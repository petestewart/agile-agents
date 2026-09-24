/**
 * T047 review round 1, blocker 1: the abandoned-browser ownership rules in
 * `acquireBrowserPage` are the whole point of factoring it out of the three
 * e2e suites, so they get tested here rather than left to a browser flake to
 * expose. A fake browser and a hand-driven `launch()` make the races that
 * matter — a launch that never returns, and one that returns *after* the
 * caller has moved on — deterministic and fast: no Chromium, no subprocess.
 */

import { describe, expect, test } from 'bun:test';
import { type AcquirableBrowser, acquireBrowserPage, runWithinBudget } from './chromium';

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
