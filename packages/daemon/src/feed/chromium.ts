/**
 * Chromium discovery for the Playwright e2e tests (`feed.e2e.test.ts`,
 * `control-room.e2e.test.ts`).
 *
 * These tests used to call `describe.skip` when no browser was found, which
 * made a machine with no Chromium report a green run with the entire SPA
 * suite silently missing — a false green. `resolveChromiumExecutable` throws
 * instead, so a missing browser fails the file loudly and says how to fix it.
 *
 * Discovery order:
 *   1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` — an explicit override wins, and a
 *      value pointing at nothing is an error rather than a silent fallback.
 *   2. playwright-core's own `chromium.executablePath()` — the build this
 *      exact playwright-core was pinned against, when it is installed.
 *   3. A scan of the known browser roots for any installed `chromium-<build>`
 *      across every platform layout. The previous implementation knew only
 *      the Linux one (`chrome-linux/chrome` under `/opt/pw-browsers`), which
 *      is why every macOS run skipped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Per-platform paths to the browser binary inside one `chromium-<build>`
 * directory. Playwright has used several layouts (`chrome-mac` became
 * `chrome-mac-arm64` on Apple silicon, and newer builds ship "Google Chrome
 * for Testing" rather than "Chromium"), so every known one is tried.
 */
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
  // The container path this repo's e2e tests were originally written for.
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

/**
 * Absolute path to a Chromium the e2e tests can launch.
 *
 * @throws when no browser can be found — deliberately, so the suite fails
 * loudly rather than skipping the whole SPA surface.
 */
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
    // playwright-core throws when it has no registry entry for this
    // platform; fall through to the scan below.
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
 * T047: getting a usable browser is itself an operation that can hang
 * forever, and this is the one place all three e2e suites bound it.
 *
 * Measured on this container by timestamping every step of a control-room
 * test through failing whole-suite runs (158 files, one bun process, the
 * three e2e files scheduled back to back):
 *
 *   - `chromium.launch()` was reached 227 ms into the test and never
 *     returned. The entire 60 s bun budget went to that one call: no
 *     Playwright error, no navigation, no assertion. The launch issued 70 ms
 *     later by the *next* test returned in 168 ms and the rest of the file
 *     passed, so the process was healthy throughout — one wedged launch, not
 *     a slow or contended box. It is the "fifth launch or later" signature
 *     the e2e files' own notes describe (this is the process's fourth
 *     launch), caught in the act.
 *   - Bounding only the launch is measurably *worse* than leaving it
 *     unbounded: a launch can **return a browser that is already wedged**,
 *     which is then cached and hangs every later `newPage()` — 6 and 8
 *     consecutive tests lost in 2/2 runs, where the unbounded version loses
 *     one test and recovers, because bun's own timeout kills the wedged
 *     launch before it can ever be cached.
 *
 * `launch()`'s own timeout does not fire either (60 s elapsed against its
 * 30 s default) and `newPage()` takes no timeout at all, so the caller's
 * bound is the only bound there is. Hence: launch **and** first page under
 * one budget, and a browser is only ever handed back once it has actually
 * produced a page.
 *
 * Ownership is the subtle part, and it is why this returns the browser
 * rather than writing any suite's `sharedBrowser` itself (review round 1
 * blocker): `Promise.race` does not cancel the loser, so an abandoned
 * acquisition keeps running and its `launch()` may resolve later. Only the
 * winning attempt's browser is ever returned, so only the winner can be
 * cached by the caller; a late-arriving loser is closed here and can never
 * reach anyone's cache, nor race a close against a good browser that a
 * subsequent attempt already handed back.
 */
export const BROWSER_READY_BUDGET_MS = 5_000;
export const BROWSER_ATTEMPTS = 3;

/** The surface `acquireBrowserPage` needs; `playwright-core`'s `Browser` satisfies it, and so can a fake. */
export interface AcquirableBrowser {
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface AcquireBrowserPageOptions<B extends AcquirableBrowser, P> {
  /** Prefix for the stderr line when an attempt is abandoned, e.g. `'feed e2e'`. */
  label: string;
  /** A browser to reuse when it is still connected, instead of launching. Omit for a fresh browser per call. */
  cached?: B | undefined;
  launch: () => Promise<B>;
  openPage: (browser: B) => Promise<P>;
  budgetMs?: number;
  attempts?: number;
  /** Defaults to `console.error`; injected by the unit tests. */
  warn?: (message: string) => void;
}

/** Close without caring: an abandoned browser may itself be wedged, and nothing is waiting on it. */
function closeQuietly(browser: AcquirableBrowser): void {
  void Promise.resolve()
    .then(() => browser.close())
    .catch(() => {});
}

/**
 * A page on a browser that is demonstrably alive, or a throw. Retries a
 * wedged launch/`newPage()` up to `attempts` times, abandoning (and
 * eventually closing) each browser that misses `budgetMs`.
 *
 * The returned browser is the caller's to cache; nothing else ever is.
 */
export async function acquireBrowserPage<B extends AcquirableBrowser, P>(
  options: AcquireBrowserPageOptions<B, P>,
): Promise<{ browser: B; page: P }> {
  const budgetMs = options.budgetMs ?? BROWSER_READY_BUDGET_MS;
  const attempts = options.attempts ?? BROWSER_ATTEMPTS;
  const warn = options.warn ?? ((message: string) => console.error(message));
  let reusable = options.cached?.isConnected() ? options.cached : undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Set once this attempt has lost its race. The attempt re-reads it after
    // every await at which it could still hand a browser back, so an
    // abandoned attempt can only ever put its browser away.
    let abandoned = false;
    // The browser this attempt got hold of, whether or not it ever produced
    // a page. `putAway` needs it by handle and not through `opening`: an
    // attempt wedged in `openPage()` never settles, so a close hung off that
    // promise would never run and the browser would leak (caught by
    // `chromium.test.ts`'s wedged-`newPage()` cases).
    let attemptBrowser: B | undefined;
    let putAwayDone = false;
    /** Close this attempt's browser, at most once, as soon as there is one to close. */
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
    // Only the winner is ever returned, so only the winner can be cached by
    // the caller (review round 1 blocker 1).
    if (won) return won;

    abandoned = true;
    // Whichever comes first: the browser is already in hand (wedged in
    // `openPage()`), or it arrives later (wedged in `launch()`). `putAway`
    // is idempotent, so both firing is fine and neither firing twice is.
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
 * T047 review round 1: the second half of the same hazard, and the reason a
 * bounded *acquisition* is not enough on its own.
 *
 * Measured by running a watchdog inside every browser-driven test through
 * failing whole-suite runs: a test stalls for its entire budget while its
 * browser reports `isConnected() === true` the whole time — 12 consecutive
 * 5 s watchdog ticks, all "connected". So the browser is not killed and not
 * disconnected; it is alive and simply stops answering, which means
 * `isConnected()` cannot detect it and neither can the suites'
 * `isBrowserGoneError` message match. The same watchdog showed the stalled
 * body still running 60 s *after* bun had already failed the test and moved
 * on: bun's per-test timeout does not cancel anything.
 *
 * Which of the three suites is hit moves between runs (a control-room chrome
 * test, then the feed snapshot-race test, then the plan walkthrough), so
 * this is not one bad wait in one test to be rewritten — it is any
 * Playwright call on a wedged page, and the calls that hang are often the
 * ones that take no timeout at all (`waitForTimeout`, `locator.count()`,
 * `evaluate`). The only bound available to test code is around the body.
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
  // A rejection from `op` propagates, so a real assertion failure still fails
  // the test immediately rather than being mistaken for a wedge.
  return raced === marker ? { done: false } : { done: true, value: raced as T };
}
