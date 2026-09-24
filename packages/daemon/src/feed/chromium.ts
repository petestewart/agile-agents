/**
 * Chromium discovery and wedge-proofing for the Playwright e2e tests.
 * `resolveChromiumExecutable` throws when no browser is found, so a
 * missing browser fails loudly instead of skipping the suite (a false
 * green). Order: `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (pointing at nothing is
 * an error), playwright-core's pinned `executablePath()`, then a scan of
 * the known browser roots for any `chromium-<build>` in every platform
 * layout.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/** Browser binary paths inside one `chromium-<build>` dir: every known layout (mac, arm64, Chrome for Testing). */
const BINARY_LAYOUTS: Record<string, readonly string[]> = {
  darwin: [
    join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(
      'chrome-mac',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    join(
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
  ],
  linux: [join('chrome-linux', 'chrome'), join('chrome-linux', 'headless_shell')],
  win32: [join('chrome-win', 'chrome.exe')],
};

/** Directories that may hold `chromium-<build>` installs, most specific first. */
function browserRoots(): string[] {
  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  // The container path the e2e tests were first written for.
  roots.push('/opt/pw-browsers');
  // Playwright's own per-platform default cache.
  const home = homedir();
  if (process.platform === 'darwin') roots.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) roots.push(join(localAppData, 'ms-playwright'));
  } else roots.push(join(home, '.cache', 'ms-playwright'));
  return roots;
}

/** Build number out of a `chromium-1208` directory name, or -1 when it has none. */
function buildNumber(dirName: string): number {
  const parsed = Number.parseInt(dirName.slice('chromium-'.length), 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

/** Newest installed Chromium under `root`, or undefined when there is none. */
function scanRoot(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const layouts = BINARY_LAYOUTS[process.platform] ?? BINARY_LAYOUTS.linux ?? [];
  const candidates = entries
    .filter((name) => name.startsWith('chromium-'))
    // Newest build first: closest to whatever playwright-core expects.
    .sort((a, b) => buildNumber(b) - buildNumber(a));
  for (const dir of candidates) {
    for (const layout of layouts) {
      const candidate = join(root, dir, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Absolute path to a launchable Chromium. Throws when none is found, so the suite fails loudly. */
export function resolveChromiumExecutable(): string {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(
      `PLAYWRIGHT_CHROMIUM_EXECUTABLE is set to "${override}", but nothing exists there. Point it at a Chromium binary or unset it to fall back to discovery.`,
    );
  }

  // The build this playwright-core was pinned against, when installed.
  try {
    const pinned = chromium.executablePath();
    if (pinned && existsSync(pinned)) return pinned;
  } catch {
    // No registry entry for this platform: fall through to the scan.
  }

  const roots = browserRoots();
  for (const root of roots) {
    const found = scanRoot(root);
    if (found) return found;
  }

  throw new Error(
    [
      'No Chromium executable found, so the Playwright e2e tests cannot run.',
      `Searched: ${roots.join(', ')}`,
      'Install one with `bunx playwright-core install chromium`, or point',
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE at an existing Chromium binary.',
    ].join('\n'),
  );
}

/**
 * Acquiring a usable browser can itself hang forever (measured: one
 * `chromium.launch()` never returned while the next launch took 168 ms;
 * `launch()`'s own timeout didn't fire and `newPage()` takes none). A
 * launch can also return an already-wedged browser, so bounding the launch
 * alone is worse: the wedged browser gets cached and hangs every later
 * test. Hence launch and first page share one budget, and a browser is
 * handed back only once it has produced a page.
 *
 * `Promise.race` doesn't cancel the loser, so an abandoned attempt may
 * still resolve later: only the winner is returned (and so cacheable), and
 * a late loser is closed here.
 */
export const BROWSER_READY_BUDGET_MS = 5_000;
export const BROWSER_ATTEMPTS = 3;

/** What `acquireBrowserPage` needs; `playwright-core`'s `Browser` or a fake. */
export interface AcquirableBrowser {
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface AcquireBrowserPageOptions<B extends AcquirableBrowser, P> {
  /** Prefix for the stderr line when an attempt is abandoned. */
  label: string;
  /** A still-connected browser to reuse instead of launching. */
  cached?: B | undefined;
  launch: () => Promise<B>;
  openPage: (browser: B) => Promise<P>;
  budgetMs?: number;
  attempts?: number;
  /** Defaults to `console.error`; injected by the unit tests. */
  warn?: (message: string) => void;
}

/** An abandoned browser may itself be wedged, and nothing waits on it. */
function closeQuietly(browser: AcquirableBrowser): void {
  void Promise.resolve()
    .then(() => browser.close())
    .catch(() => {});
}

/**
 * A page on a demonstrably alive browser, or a throw: up to `attempts`
 * tries, abandoning (and closing) each browser that misses `budgetMs`. The
 * returned browser is the caller's to cache.
 */
export async function acquireBrowserPage<B extends AcquirableBrowser, P>(
  options: AcquireBrowserPageOptions<B, P>,
): Promise<{ browser: B; page: P }> {
  const budgetMs = options.budgetMs ?? BROWSER_READY_BUDGET_MS;
  const attempts = options.attempts ?? BROWSER_ATTEMPTS;
  const warn = options.warn ?? ((message: string) => console.error(message));
  let reusable = options.cached?.isConnected() ? options.cached : undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Set once this attempt lost the race; re-read after every await, so an
    // abandoned attempt can only put its browser away.
    let abandoned = false;
    // Held by handle, not via `opening`: an attempt wedged in `openPage()`
    // never settles, so a close chained on it would never run.
    let attemptBrowser: B | undefined;
    let putAwayDone = false;
    /** Close this attempt's browser once, as soon as there is one. */
    const putAway = (): void => {
      if (putAwayDone || !attemptBrowser) return;
      putAwayDone = true;
      closeQuietly(attemptBrowser);
    };

    const acquiring: Promise<B> = reusable ? Promise.resolve(reusable) : options.launch();
    const opening = (async (): Promise<{ browser: B; page: P } | undefined> => {
      const browser = await acquiring;
      attemptBrowser = browser;
      if (abandoned) {
        putAway();
        return undefined;
      }
      const page = await options.openPage(browser);
      if (abandoned) {
        putAway();
        return undefined;
      }
      return { browser, page };
    })();

    const won = await Promise.race([
      opening,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), budgetMs)),
    ]);
    // Only the winner is returned, so only the winner can be cached.
    if (won) return won;

    abandoned = true;
    // The browser is in hand (wedged in `openPage()`) or arrives later
    // (wedged in `launch()`); `putAway` is idempotent.
    putAway();
    void opening.then(putAway, putAway);
    // A cached browser that just missed the budget is wedged: never reuse it.
    reusable = undefined;
    warn(
      `${options.label}: no usable browser within ${budgetMs}ms (attempt ${attempt}/${attempts}) — abandoning it and launching another`,
    );
  }

  throw new Error(
    `${options.label}: launch()/newPage() did not return within ${budgetMs}ms on any of ${attempts} attempts`,
  );
}

/**
 * The other half of the hazard: a browser can stay `isConnected()` while
 * it stops answering (measured: 12 consecutive "connected" 5 s ticks
 * through a stall), and bun's per-test timeout cancels nothing. Any
 * Playwright call on a wedged page can hang, often ones with no timeout
 * (`waitForTimeout`, `locator.count()`, `evaluate`), so the only bound
 * available is around the test body.
 */
export async function runWithinBudget<T>(
  op: () => Promise<T>,
  budgetMs: number,
): Promise<{ done: true; value: T } | { done: false }> {
  const marker = Symbol('budget-expired');
  const raced = await Promise.race([
    op(),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), budgetMs)),
  ]);
  // A rejection propagates: a real assertion failure isn't mistaken for a wedge.
  return raced === marker ? { done: false } : { done: true, value: raced as T };
}
