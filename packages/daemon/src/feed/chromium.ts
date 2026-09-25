/**
 * Chromium discovery and wedge-proofing for the Playwright e2e tests.
 * `resolveChromiumExecutable` throws when no browser is found, so a
 * missing browser fails loudly instead of skipping the suite (a false
 * green). Order: `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (pointing at nothing is
 * an error), playwright-core's pinned `executablePath()`, then a scan of
 * the known browser roots for any `chromium-<build>` in every platform
 * layout.
 */

import childProcess from 'node:child_process';
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
 * A lost stdio pipe that no promise sees. `chromium.launch()` spawns
 * Chromium with two extra pipes (fds 3 and 4, `--remote-debugging-pipe`),
 * and bun's `child_process.spawn` opens both eagerly as `net` sockets via
 * `net.connect({ fd })`. On Bun 1.3.11 that connect can fail (the EBADF
 * family: an `epoll_ctl` refused for the pipe fd surfaces as `connect
 * ENOENT`), and bun reports it by emitting `error` on the socket from a
 * `.catch`. Playwright only adds its own `error` listeners once the launch
 * reaches its pipe transport, several awaits later, so in that window the
 * emit has no listener: it escapes as an unhandled rejection that the launch
 * promise never sees, bun's test runner fails whichever test is running
 * (process handlers don't stop it), and the launch itself hangs on a dead
 * pipe. CI job 108116908628 is that shape: a 9 ms failure with a stack
 * through `#createStdioObject`; reproduced by injecting EBADF into that
 * socket's `epoll_ctl` (strace `-e inject=epoll_ctl:error=EBADF:when=N`).
 *
 * The guard puts a listener on every extra stdio socket the moment spawn
 * returns, while one of `acquireBrowserPage`'s launches is in flight, so the
 * error is caught and turned into a failed attempt (retried like a launch
 * that rejects). Only spawns with more than three stdio entries are touched:
 * that is Playwright's pipe launch; the daemon's own spawns use three.
 *
 * The same sockets are also kept reachable for the life of the process
 * (`pinnedStdio`), because on Bun 1.3.11 a dead child's extra-stdio socket
 * closes its fd number a second time when it is garbage-collected. The fd
 * was already closed when the child exited, so by then that number belongs
 * to something else, and the stale close shuts it underneath its owner.
 * Measured with strace on a full `bun test`: a finalizer sweep ran
 * `close(240) close(242) close(241) close(243)` then `close(241) = EBADF`...,
 * where 240 was the live Chromium's devtools pipe ("Connection terminated
 * while reading from pipe", Chromium exits, the page wedges: the 40 s
 * "made no progress" on the T161 stream-page test every CI run). After the
 * e2e files the same stale closes land on whatever the next file opens: the
 * fake agent's pipes in attach/service.test.ts, whose first line then never
 * arrives (T330 on f59c9ef, T174 on 8377414, 20 s `waitFor` timeouts).
 * Reproduced outside the suite by spawning a 5-stdio child, killing it,
 * spawning another and forcing a GC: the second child's fd 3/4 sockets are
 * closed; with the first child's sockets kept reachable they never are.
 * Three-stdio children (the daemon's own) show no stale close.
 */
interface StdioSocket {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** The part of a spawned child the guard touches; `ChildProcess` or a fake. */
export interface GuardedChild {
  stdio?: ReadonlyArray<unknown>;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Where `spawn` is looked up at call time: `node:child_process` itself, or a fake. */
export interface SpawnHost {
  spawn: (...args: never[]) => GuardedChild;
}

interface PipeGuard {
  /** Resolves with the socket error when a guarded launch loses a stdio pipe. */
  lost: Promise<Error>;
  release(): void;
}

/**
 * Every extra-stdio socket a guarded launch has opened, dead or alive:
 * never collected, so never finalized, so never closes a reused fd (see
 * above). A few objects per browser launch, for the life of a test process.
 */
const pinnedStdio: unknown[] = [];

/** How many sockets are pinned; for the unit tests. */
export function pinnedStdioCount(): number {
  return pinnedStdio.length;
}

const activeGuards = new Map<
  SpawnHost,
  { original: SpawnHost['spawn']; onLost: Set<(err: Error) => void> }
>();

function isStdioSocket(value: unknown): value is StdioSocket {
  return typeof (value as { on?: unknown } | null)?.on === 'function';
}

/** Wraps `host.spawn` until `release()`; nested guards share one wrapper. */
export function guardStdioPipes(host: SpawnHost = childProcess as unknown as SpawnHost): PipeGuard {
  let entry = activeGuards.get(host);
  if (!entry) {
    const original = host.spawn;
    const onLost = new Set<(err: Error) => void>();
    const created = { original, onLost };
    entry = created;
    activeGuards.set(host, created);
    host.spawn = ((...args: never[]) => {
      const child = original.apply(host, args);
      const extra = child.stdio?.slice(3) ?? [];
      for (const socket of extra) {
        if (!isStdioSocket(socket)) continue;
        pinnedStdio.push(socket);
        // Stays attached after release, inert: an error on an abandoned
        // launch's pipe must not escape either.
        socket.on('error', (err: Error) => {
          if (created.onLost.size === 0) return;
          // A browser without its pipe is useless and would linger.
          try {
            child.kill('SIGKILL');
          } catch {}
          for (const notify of [...created.onLost]) notify(err);
        });
      }
      return child;
    }) as SpawnHost['spawn'];
  }
  const shared = entry;
  let notify!: (err: Error) => void;
  const lost = new Promise<Error>((resolve) => {
    notify = resolve;
  });
  shared.onLost.add(notify);
  let released = false;
  return {
    lost,
    release() {
      if (released) return;
      released = true;
      shared.onLost.delete(notify);
      if (shared.onLost.size === 0 && activeGuards.get(host) === shared) {
        activeGuards.delete(host);
        host.spawn = shared.original;
      }
    },
  };
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
  /** Where a launch's `spawn` is guarded (see `guardStdioPipes`); injected by the unit tests. */
  spawnHost?: SpawnHost;
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

    // Installed before `launch()` runs, since it spawns a few awaits later.
    const guard = reusable ? undefined : guardStdioPipes(options.spawnHost);
    let acquiring: Promise<B>;
    try {
      acquiring = reusable ? Promise.resolve(reusable) : options.launch();
    } catch (err) {
      guard?.release();
      throw err;
    }
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

    // A fresh launch can also reject outright: CI run 36071316586 saw bun's
    // `child_process.spawn` fail to connect Chromium's stdio pipe (`connect
    // ENOENT`) in 10 ms, while the very next launch worked. That is a failed
    // attempt like a hang, so it is retried; the last attempt's rejection is
    // rethrown as-is, so a missing or broken Chromium still fails loudly.
    // A rejection from `openPage()` (or a cached browser) is not retried here.
    let launchFailure: { err: unknown } | undefined;
    if (!reusable) {
      acquiring.catch((err: unknown) => {
        launchFailure = { err };
      });
    }
    let pipeLost: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let won: { browser: B; page: P } | undefined;
    try {
      won = await Promise.race([
        opening.catch((err: unknown) => {
          if (pipeLost && attempt < attempts) return undefined;
          if (launchFailure && attempt < attempts) return undefined;
          throw err;
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), budgetMs);
        }),
        ...(guard
          ? [
              guard.lost.then((err) => {
                pipeLost = err;
                return undefined;
              }),
            ]
          : []),
      ]);
    } finally {
      clearTimeout(timer);
      if (guard) {
        // A launch abandoned before it spawned stays guarded until it settles;
        // one that lost its pipe is dead (its child killed), so let it go now.
        if (won || pipeLost) guard.release();
        else void acquiring.then(guard.release, guard.release);
      }
    }
    // Only the winner is returned, so only the winner can be cached.
    if (won) return won;
    if (pipeLost) {
      abandoned = true;
      putAway();
      void opening.then(putAway, putAway);
      const reason = `lost Chromium's stdio pipe (${pipeLost.message.split('\n')[0]})`;
      if (attempt === attempts) {
        throw new Error(`${options.label}: launch() ${reason} on attempt ${attempt}/${attempts}`);
      }
      warn(
        `${options.label}: launch() ${reason} (attempt ${attempt}/${attempts}) — launching another`,
      );
      continue;
    }
    if (launchFailure) {
      const reason =
        launchFailure.err instanceof Error
          ? launchFailure.err.message.split('\n')[0]
          : String(launchFailure.err);
      warn(
        `${options.label}: launch() rejected (attempt ${attempt}/${attempts}: ${reason}) — launching another`,
      );
      continue;
    }

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
