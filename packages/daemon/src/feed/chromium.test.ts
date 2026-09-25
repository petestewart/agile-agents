/**
 * T047 review round 1, blocker 1: the abandoned-browser ownership rules in
 * `acquireBrowserPage` are the whole point of factoring it out of the three
 * e2e suites, so they get tested here rather than left to a browser flake to
 * expose. A fake browser and a hand-driven `launch()` make the races that
 * matter — a launch that never returns, and one that returns *after* the
 * caller has moved on — deterministic and fast: no Chromium, no subprocess.
 */

import { describe, expect, test } from 'bun:test';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readlinkSync } from 'node:fs';
import {
  type AcquirableBrowser,
  type GuardedChild,
  type SpawnHost,
  acquireBrowserPage,
  guardStdioPipes,
  pinnedStdioCount,
  runWithinBudget,
} from './chromium';

class FakeBrowser implements AcquirableBrowser {
  closes = 0;
  connected = true;
  constructor(readonly name: string) {}
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.closes += 1;
    this.connected = false;
  }
}

/** A promise plus the handles to settle it whenever the test wants. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets an already-scheduled `.then` chain run before the test asserts on its effects. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const silent = () => {};

describe('acquireBrowserPage', () => {
  test('returns the browser and page from a launch that works, and never closes it', async () => {
    const browser = new FakeBrowser('ok');
    const warnings: string[] = [];
    const acquired = await acquireBrowserPage({
      label: 'test',
      launch: async () => browser,
      openPage: async () => 'page-1',
      warn: (m) => warnings.push(m),
    });

    expect(acquired.browser).toBe(browser);
    expect(acquired.page).toBe('page-1');
    expect(browser.closes).toBe(0);
    expect(warnings).toEqual([]);
  });

  test('reuses a connected cached browser without launching', async () => {
    const cached = new FakeBrowser('cached');
    let launches = 0;
    const acquired = await acquireBrowserPage({
      label: 'test',
      cached,
      launch: async () => {
        launches += 1;
        return new FakeBrowser('fresh');
      },
      openPage: async () => 'page',
      warn: silent,
    });

    expect(acquired.browser).toBe(cached);
    expect(launches).toBe(0);
  });

  test('ignores a cached browser that has disconnected and launches instead', async () => {
    const cached = new FakeBrowser('cached');
    cached.connected = false;
    const fresh = new FakeBrowser('fresh');
    const acquired = await acquireBrowserPage({
      label: 'test',
      cached,
      launch: async () => fresh,
      openPage: async () => 'page',
      warn: silent,
    });

    expect(acquired.browser).toBe(fresh);
  });

  /**
   * The blocker itself. Attempt 1's launch is wedged past the budget, so the
   * caller moves on and attempt 2 hands back a good browser. Attempt 1's
   * launch *then* resolves — the case the code's own "close it if it ever
   * does come back" comment anticipates. The late browser must be closed and
   * must never be handed back, or a caller caching what it is given would
   * cache a browser that is being closed underneath it.
   */
  test('a launch that resolves after being abandoned is closed, never returned', async () => {
    const wedged = new FakeBrowser('wedged');
    const good = new FakeBrowser('good');
    const wedgedLaunch = deferred<FakeBrowser>();
    const warnings: string[] = [];
    let launches = 0;

    const acquiring = acquireBrowserPage({
      label: 'test',
      launch: () => {
        launches += 1;
        return launches === 1 ? wedgedLaunch.promise : Promise.resolve(good);
      },
      openPage: async (browser) => `page-on-${browser.name}`,
      budgetMs: 10,
      warn: (m) => warnings.push(m),
    });

    const acquired = await acquiring;
    // Attempt 2's browser is the one handed back.
    expect(acquired.browser).toBe(good);
    expect(acquired.page).toBe('page-on-good');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('attempt 1/3');

    // ...and only now does the wedged launch come back.
    wedgedLaunch.resolve(wedged);
    await drainMicrotasks();

    expect(wedged.closes).toBe(1);
    // The good browser the caller is about to cache is untouched.
    expect(good.closes).toBe(0);
    expect(good.isConnected()).toBe(true);
  });

  /**
   * The same race one step later: the abandoned attempt gets all the way to a
   * *page* after losing. It still must not be handed back, and must be closed
   * exactly once — not twice, which would be the other way to get this wrong.
   */
  test('an abandoned attempt that reaches a page still closes it exactly once', async () => {
    const wedged = new FakeBrowser('wedged');
    const good = new FakeBrowser('good');
    const slowPage = deferred<string>();
    let launches = 0;

    const acquired = await acquireBrowserPage({
      label: 'test',
      launch: async () => {
        launches += 1;
        return launches === 1 ? wedged : good;
      },
      openPage: (browser) => (browser === wedged ? slowPage.promise : Promise.resolve('good-page')),
      budgetMs: 10,
      warn: silent,
    });

    expect(acquired.browser).toBe(good);

    slowPage.resolve('too-late');
    await drainMicrotasks();

    expect(wedged.closes).toBe(1);
    expect(good.closes).toBe(0);
  });

  test('throws after the configured number of attempts, and each abandoned browser is closed', async () => {
    const launched: FakeBrowser[] = [];
    const warnings: string[] = [];

    await expect(
      acquireBrowserPage({
        label: 'feed e2e',
        launch: async () => {
          const browser = new FakeBrowser(`b${launched.length}`);
          launched.push(browser);
          return browser;
        },
        // Never resolves: the wedged-`newPage()` half of the root cause.
        openPage: () => new Promise<string>(() => {}),
        budgetMs: 10,
        attempts: 2,
        warn: (m) => warnings.push(m),
      }),
    ).rejects.toThrow(/feed e2e: launch\(\)\/newPage\(\) did not return within 10ms/);

    expect(warnings).toHaveLength(2);
    await drainMicrotasks();
    expect(launched).toHaveLength(2);
    for (const browser of launched) expect(browser.closes).toBe(1);
  });

  test('a cached browser that misses the budget is abandoned, not retried', async () => {
    const cached = new FakeBrowser('cached');
    const fresh = new FakeBrowser('fresh');
    let launches = 0;
    let openCalls = 0;

    const acquired = await acquireBrowserPage({
      label: 'test',
      cached,
      launch: async () => {
        launches += 1;
        return fresh;
      },
      openPage: (browser) => {
        openCalls += 1;
        // The cached browser is wedged; the freshly launched one is fine.
        return browser === cached ? new Promise<string>(() => {}) : Promise.resolve('page');
      },
      budgetMs: 10,
      warn: silent,
    });

    expect(acquired.browser).toBe(fresh);
    expect(launches).toBe(1);
    expect(openCalls).toBe(2);
    await drainMicrotasks();
    expect(cached.closes).toBe(1);
  });

  test('a launch that rejects on every attempt rejects with its own error', async () => {
    let launches = 0;
    const warnings: string[] = [];
    await expect(
      acquireBrowserPage({
        label: 'test',
        launch: async () => {
          launches += 1;
          throw new Error('no chromium here');
        },
        openPage: async () => 'page',
        budgetMs: 10,
        attempts: 3,
        warn: (m) => warnings.push(m),
      }),
    ).rejects.toThrow('no chromium here');
    expect(launches).toBe(3);
    expect(warnings).toHaveLength(2);
  });

  test('a launch that rejects once (a transient spawn failure) is retried with a fresh launch', async () => {
    const good = new FakeBrowser('good');
    let launches = 0;
    const warnings: string[] = [];
    const acquired = await acquireBrowserPage({
      label: 'test',
      launch: async () => {
        launches += 1;
        if (launches === 1) throw new Error('Failed to connect');
        return good;
      },
      openPage: async () => 'page',
      budgetMs: 1_000,
      warn: (m) => warnings.push(m),
    });
    expect(acquired.browser).toBe(good);
    expect(launches).toBe(2);
    expect(warnings).toEqual([
      'test: launch() rejected (attempt 1/3: Failed to connect) — launching another',
    ]);
  });

  test('a page that rejects on a launched browser still rejects, without a retry', async () => {
    let launches = 0;
    await expect(
      acquireBrowserPage({
        label: 'test',
        launch: async () => {
          launches += 1;
          return new FakeBrowser('b');
        },
        openPage: async () => {
          throw new Error('newPage broke');
        },
        budgetMs: 10,
        warn: silent,
      }),
    ).rejects.toThrow('newPage broke');
    expect(launches).toBe(1);
  });
});

/**
 * CI job 108116908628: the lost pipe that no promise sees. Bun opens a
 * Chromium launch's extra stdio pipes (fds 3 and 4) as sockets at spawn
 * time, and when that connect fails it emits `error` on the socket from a
 * `.catch`: with no listener yet, that escapes as an unhandled rejection
 * (failing whatever test is running) while the launch itself hangs. The fake
 * host below spawns a child shaped like bun's and fails fd 4 exactly that way.
 */
class FakeChild implements GuardedChild {
  readonly stdio = [
    null,
    new EventEmitter(),
    new EventEmitter(),
    new EventEmitter(),
    new EventEmitter(),
  ];
  kills: Array<string | undefined> = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

/** Bun's own shape: `doConnect(...).catch((error) => socket.emit('error', error))`. */
function loseStdioPipe(child: FakeChild, fd = 4): void {
  const socket = child.stdio[fd] as EventEmitter;
  const err = Object.assign(new Error('Failed to connect'), { syscall: 'connect', code: 'ENOENT' });
  void Promise.reject(err).catch((error: Error) => {
    socket.emit('error', error);
  });
}

function fakeSpawnHost(): { host: SpawnHost; children: FakeChild[]; original: SpawnHost['spawn'] } {
  const children: FakeChild[] = [];
  const original = (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as SpawnHost['spawn'];
  return { host: { spawn: original }, children, original };
}

describe('acquireBrowserPage: a stdio pipe lost at spawn (Bun 1.3.11)', () => {
  test('the socket error is caught, the child killed, and a fresh launch is tried at once', async () => {
    const { host, children, original } = fakeSpawnHost();
    const good = new FakeBrowser('good');
    const warnings: string[] = [];
    let launches = 0;
    const started = Date.now();

    const acquired = await acquireBrowserPage({
      label: 'test',
      spawnHost: host,
      launch: async () => {
        launches += 1;
        if (launches > 1) return good;
        // Playwright spawns a few awaits into launch(), then waits on the
        // dead pipe forever: the launch neither resolves nor rejects.
        await Promise.resolve();
        const child = host.spawn() as FakeChild;
        loseStdioPipe(child);
        return new Promise<FakeBrowser>(() => {});
      },
      openPage: async () => 'page',
      budgetMs: 5_000,
      warn: (m) => warnings.push(m),
    });

    expect(acquired.browser).toBe(good);
    expect(launches).toBe(2);
    // Retried on the error, not after the 5 s budget ran out.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(children[0]?.kills).toEqual(['SIGKILL']);
    expect(warnings).toEqual([
      "test: launch() lost Chromium's stdio pipe (Failed to connect) (attempt 1/3) — launching another",
    ]);
    // Nothing is left wrapped once no launch is in flight.
    expect(host.spawn).toBe(original);
  });

  test('a pipe lost on every attempt fails loudly with that error', async () => {
    const { host, children } = fakeSpawnHost();
    await expect(
      acquireBrowserPage({
        label: 'test',
        spawnHost: host,
        launch: async () => {
          await Promise.resolve();
          loseStdioPipe(host.spawn() as FakeChild, 3);
          return new Promise<FakeBrowser>(() => {});
        },
        openPage: async () => 'page',
        budgetMs: 5_000,
        attempts: 2,
        warn: silent,
      }),
    ).rejects.toThrow(
      "test: launch() lost Chromium's stdio pipe (Failed to connect) on attempt 2/2",
    );
    expect(children).toHaveLength(2);
  });

  test('a pipe error after the launch is decided stays caught, and inert', async () => {
    const { host, children, original } = fakeSpawnHost();
    const acquired = await acquireBrowserPage({
      label: 'test',
      spawnHost: host,
      launch: async () => {
        host.spawn();
        return new FakeBrowser('ok');
      },
      openPage: async () => 'page',
      warn: silent,
    });
    expect(host.spawn).toBe(original);
    const child = children[0] as FakeChild;
    loseStdioPipe(child);
    await drainMicrotasks();
    expect(child.kills).toEqual([]);
    expect(acquired.browser.closes).toBe(0);
  });

  test('only the extra pipes are guarded, and nested guards restore spawn once', () => {
    const { host, children, original } = fakeSpawnHost();
    const outer = guardStdioPipes(host);
    const inner = guardStdioPipes(host);
    host.spawn();
    const child = children[0] as FakeChild;
    expect((child.stdio[1] as EventEmitter).listenerCount('error')).toBe(0);
    expect((child.stdio[3] as EventEmitter).listenerCount('error')).toBe(1);
    expect((child.stdio[4] as EventEmitter).listenerCount('error')).toBe(1);
    inner.release();
    expect(host.spawn).not.toBe(original);
    outer.release();
    outer.release();
    expect(host.spawn).toBe(original);
  });
});

/**
 * CI jobs 108131833599 / 108131816730 (and the T161 stream-page wedge every
 * run): on Bun 1.3.11 a dead child's extra-stdio socket closes its fd number
 * again when it is garbage-collected, shutting whatever reused that number.
 * The guard keeps those sockets reachable so they are never finalized.
 */
describe('guardStdioPipes: a dead launch never closes a live fd', () => {
  test('a guarded spawn pins its extra-stdio sockets past a GC', () => {
    const { host } = fakeSpawnHost();
    const before = pinnedStdioCount();
    const guard = guardStdioPipes(host);
    let ref: WeakRef<object> | undefined;
    (() => {
      const child = host.spawn() as FakeChild;
      ref = new WeakRef(child.stdio[3] as object);
    })();
    guard.release();
    Bun.gc(true);
    expect(pinnedStdioCount()).toBe(before + 2);
    expect(ref?.deref()).toBeDefined();
  });

  /** The live fds of this process, as `fd -> target`. */
  function openFds(): Map<string, string> {
    const fds = new Map<string, string>();
    for (const fd of readdirSync('/proc/self/fd')) {
      try {
        fds.set(fd, readlinkSync(`/proc/self/fd/${fd}`));
      } catch {}
    }
    return fds;
  }

  function exited(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }

  /** A Chromium-shaped spawn (Playwright's pipe launch: fds 3 and 4), made under the guard. */
  function spawnPipeLaunch(): ChildProcess {
    const guard = guardStdioPipes();
    try {
      // Through the module object, as Playwright's `require('child_process')` does.
      return childProcess.spawn('sleep', ['30'], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } finally {
      guard.release();
    }
  }

  // The reproduction itself, on real processes: without the pin, the second
  // child's fd 3/4 sockets are closed within the first round or two.
  test.skipIf(process.platform !== 'linux')(
    "a killed launch's sockets, once collected, leave the next launch's fds open",
    async () => {
      for (let round = 0; round < 5; round++) {
        {
          const dead = spawnPipeLaunch();
          await Bun.sleep(20);
          dead.kill('SIGKILL');
          await exited(dead);
        }
        const before = openFds();
        const live = spawnPipeLaunch();
        try {
          await Bun.sleep(20);
          const mine = [...openFds()].filter(([fd]) => !before.has(fd));
          expect(mine.length).toBeGreaterThanOrEqual(4);
          Bun.gc(true);
          await Bun.sleep(20);
          Bun.gc(true);
          await Bun.sleep(20);
          const now = openFds();
          expect(mine.filter(([fd, target]) => now.get(fd) !== target)).toEqual([]);
        } finally {
          live.kill('SIGKILL');
          await exited(live);
        }
      }
    },
    20_000,
  );
});

describe('runWithinBudget', () => {
  test('returns the value when the operation finishes in time', async () => {
    const outcome = await runWithinBudget(async () => 'value', 1_000);
    expect(outcome).toEqual({ done: true, value: 'value' });
  });

  test('reports not-done when the operation outlives the budget', async () => {
    const outcome = await runWithinBudget(() => new Promise<string>(() => {}), 10);
    expect(outcome).toEqual({ done: false });
  });

  test('propagates a rejection rather than reporting a wedge — a real failure must still fail', async () => {
    await expect(
      runWithinBudget(async () => {
        throw new Error('expect(received).toBe(expected)');
      }, 1_000),
    ).rejects.toThrow('expect(received).toBe(expected)');
  });

  test('a falsy result is still reported as done', async () => {
    expect(await runWithinBudget(async () => undefined, 1_000)).toEqual({
      done: true,
      value: undefined,
    });
    expect(await runWithinBudget(async () => 0, 1_000)).toEqual({ done: true, value: 0 });
  });
});
