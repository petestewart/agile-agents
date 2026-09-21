/**
 * Playwright e2e for the control room SPA, against a seeded daemon. Same
 * Chromium discovery as `feed.e2e.test.ts` (`resolveChromiumExecutable`,
 * which throws rather than skipping when no browser is installed) and the
 * same `startDaemon` harness.
 *
 * T122 deleted the Plan, board, Review and Settings screens, and with them
 * every test that drove one. What survives is the shell the daemon still
 * serves — the project block, the Needs-you list and the event tail — and,
 * inside it, T121's "a pending gate and an open question are Needs-you
 * items" coverage. The cockpit's own e2e comes back with the cockpit, in
 * Phase 6.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { Bus } from '../bus';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { StreamService } from '../streams';
import {
  BROWSER_ATTEMPTS,
  BROWSER_READY_BUDGET_MS,
  acquireBrowserPage,
  resolveChromiumExecutable,
  runWithinBudget,
} from './chromium';

const executablePath = resolveChromiumExecutable();

/**
 * QA round 1 (T043): every deadline in this file is sized for the *loaded*
 * case, not the idle one.
 *
 * The ticket's own validation step is `bun test packages/daemon/src/feed`,
 * which schedules this file alongside three siblings; under that contention a
 * step that takes ~100 ms idle can take seconds. Worse, `playwright-core`
 * used directly (no Playwright test runner, so no config) defaults every
 * action's timeout to **0 = wait forever**: a `click()` on a control that is
 * momentarily disabled — e.g. Settings' gate segments, which stay disabled
 * until `GET /api/policy` lands and while a save is in flight — never
 * returns, and the failure surfaces only as the bun-test budget expiring with
 * no Playwright error to read. `PAGE_TIMEOUT_MS` is installed on every page
 * (`openPage`) so any such step fails fast, and loudly, with the locator in
 * the message.
 */
const PAGE_TIMEOUT_MS = 20_000;

/** Deadline for this file's own condition polls (`while (!condition)` loops). Same load-sizing rationale as `PAGE_TIMEOUT_MS`. */
const POLL_DEADLINE_MS = 20_000;

/**
 * ONE Chromium for the whole file, not one per test.
 *
 * Measured on this container under the tickets' own validation step,
 * `bun test packages/daemon/src/feed` (four files, ~10 browser tests):
 * a browser per test — the file's old shape — fails that command every run,
 * always at the fifth launch or later; one shared browser passes about half
 * of them. `chromium.launch()` itself is what stops returning, with no
 * Playwright error to read, so fewer launches is the only lever the test code
 * has.
 *
 * The residual flake is not T043's and is not fixable from here: the same
 * command on `origin/claude/control-room-v2`, with none of this ticket's
 * code, is also flaky (4 clean runs in 6, failing on T025's own
 * `propose-edit` test). Its signature — bun's test budget firing while no
 * Playwright timeout does — is a *blocked* bun event loop, not a slow
 * browser. What this file can do, and now does, is keep every test cheap,
 * bounded and independent: one page-context per test closed before its daemon
 * stops, a real action timeout on every page, load-sized poll deadlines, and
 * a bounded browser close.
 */
let sharedBrowser: Browser | undefined;

/**
 * ...and it is re-launched when it has been disconnected, which on this
 * container happens *from outside this file*. Isolated measurement, same
 * commit: this file alone passes 3/3; with `feed.e2e.test.ts` alongside it,
 * one test fails in 2 of 3 runs; with the whole directory (`bun test
 * packages/daemon/src/feed`, four files, the tickets' own validation step)
 * the browser reports `Target page, context or browser has been closed`
 * partway through, every run — while a standalone probe doing the same 12
 * contexts, and the same 8 `startDaemon`/`stop` cycles around them, never
 * disconnects once. The trigger is bun's own dangling-process cleanup firing
 * as the directory's short files finish, not anything this file does; so the
 * only defence available to test code is to notice and start again.
 *
 * T047: "notice" now covers the browser that is still *connected* and simply
 * no longer answering, as well as the disconnected one — see `openPage`,
 * which is where both are noticed and replaced.
 */

/**
 * The one browser's close is bounded, and that bound is load-bearing. T041's
 * QA round 1 established the behaviour: every assertion completes in well
 * under a second, every page closes in ~35 ms — and then `browser.close()`
 * never returns, because the test process fails to observe the Chromium
 * child's exit (bun's harness, not anything the product ships). A close that
 * has not returned in `SHARED_CLOSE_BUDGET_MS` is left to bun's own
 * dangling-process cleanup (it reports "killed N dangling process"), with a
 * line on stderr so it is never silent. The budget sits under bun's own 5s
 * hook budget, which a longer one would blow; a close that works at all
 * returns in 40-90 ms.
 */
const SHARED_CLOSE_BUDGET_MS = 3_000;

afterAll(async () => {
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  if (!browser) return;
  const closed = await Promise.race([
    browser.close().then(() => true),
    Bun.sleep(SHARED_CLOSE_BUDGET_MS).then(() => false),
  ]);
  if (!closed) {
    console.error(
      `control-room e2e: the shared browser.close() did not return within ${SHARED_CLOSE_BUDGET_MS}ms — left to bun's dangling-process cleanup (teardown only; every assertion passed)`,
    );
  }
});

/**
 * A browser-driven test that survives having its Chromium killed underneath
 * it.
 *
 * Every test body in this file is self-contained — it makes its own temp
 * repo, daemon and page in the body and cleans all three up in its own
 * `finally` — so re-running one from the top is safe, and that is exactly
 * what is needed here: bun's dangling-process cleanup kills this file's
 * browser from outside it (see `openPage`), and the test that happens
 * to be running at that moment fails with `Target page, context or browser
 * has been closed` in well under a second. One retry, only for that error
 * signature, and only once, turns that into a pass without hiding anything
 * else — a real assertion failure, a timeout, or a second disconnection all
 * still fail the test, and the retry announces itself on stderr.
 */
function isBrowserGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Target (page, context or browser|closed)|browser has been closed|has been closed/i.test(
    message,
  );
}

/** The wedged browser is dropped *and* closed: `isConnected()` still reports true for it, so nothing else will ever notice it. */
function discardSharedBrowser(): void {
  const wedged = sharedBrowser;
  sharedBrowser = undefined;
  if (wedged) void wedged.close().catch(() => {});
}

/**
 * A browser-driven test that survives its browser going quiet underneath it.
 *
 * Two failure modes, one recovery. The browser can be *killed* from outside
 * this file (bun's dangling-process cleanup — the pre-existing
 * `isBrowserGoneError` case, which fails fast and loudly), or it can stay
 * alive and simply stop answering. T047 review round 1 measured the second
 * one directly: a watchdog inside the body logged `isConnected() === true`
 * on every 5 s tick for the whole 60 s the test was stuck, and the body was
 * still running a minute after bun had failed the test and moved on — bun's
 * per-test timeout cancels nothing. So a wedge is invisible to
 * `isConnected()`, invisible to `isBrowserGoneError`, and invisible to
 * `PAGE_TIMEOUT_MS` (the calls that hang are often ones that take no timeout
 * at all: `waitForTimeout`, `locator.count()`, `evaluate`). Bounding the
 * body is the only bound test code has.
 *
 * Re-running a body from the top is safe by this file's own design: every
 * body makes its own repo, daemon and page and cleans all three up in its own
 * `finally`. An abandoned body keeps running — nothing can cancel it — but it
 * only ever touches its own temp repo and then tidies itself away, and it can
 * no longer reach the shared browser because that has already been replaced.
 */
function browserTest(name: string, body: () => Promise<void>, timeoutMs: number): void {
  test(
    name,
    async () => {
      const retry = async (reason: string): Promise<void> => {
        console.error(
          `control-room e2e: "${name}" {reason} — replacing the browser and running it once more`.replace(
            '{reason}',
            reason,
          ),
        );
        discardSharedBrowser();
        const second = await runWithinBudget(body, BODY_BUDGET_MS);
        if (!second.done) {
          throw new Error(
            `control-room e2e: "${name}" made no progress for ${BODY_BUDGET_MS}ms twice over, on two different browsers — the page is wedged, not slow`,
          );
        }
      };

      try {
        const first = await runWithinBudget(body, BODY_BUDGET_MS);
        if (first.done) return;
        await retry(
          `made no progress for ${BODY_BUDGET_MS}ms on a browser still reporting connected`,
        );
      } catch (err) {
        if (!isBrowserGoneError(err)) throw err;
        await retry(
          `lost its browser mid-test (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
        );
      }
    },
    timeoutMs,
  );
}

/**
 * T047: the bounded browser acquisition all three e2e suites share
 * (`acquireBrowserPage` in `./chromium`, where the measurements and the
 * ownership rules live once instead of drifting across three near-identical
 * copies). Short version: a `chromium.launch()` in a whole-suite `bun test`
 * can simply never return, `launch()`'s own timeout does not fire, and a
 * launch that *does* return can hand back an already wedged browser — so
 * launch and first page go under one budget, and only a browser that has
 * actually produced a page is ever cached.
 */
async function openPage(options?: { colorScheme?: 'dark' | 'light' }): Promise<Page> {
  const acquired = await acquireBrowserPage({
    label: 'control-room e2e',
    cached: sharedBrowser,
    launch: () => chromium.launch({ executablePath }),
    openPage: (browser) => browser.newPage(options),
  }).catch((err: unknown) => {
    // Nothing usable came back, so whatever was cached is wedged too.
    sharedBrowser = undefined;
    throw err;
  });
  // The only place this file caches a browser, and it can only ever be the
  // one `acquireBrowserPage` handed back (review round 1 blocker 1).
  sharedBrowser = acquired.browser;
  acquired.page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  acquired.page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  return acquired.page;
}

/**
 * T047 review round 1: how long a body may take before it is treated as
 * wedged rather than slow, and the per-test budget that has to hold two of
 * them.
 *
 * `BODY_BUDGET_MS` sits above the worst *legitimate* cost of a body — a full
 * `BROWSER_ATTEMPTS` acquisition sweep plus one page action running out its
 * `PAGE_TIMEOUT_MS` — so a body that is genuinely failing always surfaces its
 * own error first, and only a body making no progress at all is retried.
 * Bodies measure ~1-3 s under whole-suite load, so this is ~20x headroom.
 */
const BODY_BUDGET_MS = PAGE_TIMEOUT_MS + BROWSER_READY_BUDGET_MS * BROWSER_ATTEMPTS + 5_000;

/** Every test in this file: room for a wedged body, its retry, and slack. */
const TEST_BUDGET_MS = BODY_BUDGET_MS * 2 + 5_000;

/**
 * Per-test teardown: this test's whole page *context* (`browser.newPage()`
 * opens one per page, and closing only the page leaks it), and before its
 * daemon stops — a page left open on a stopped daemon keeps `lib/ws.ts`'s
 * client reconnecting on a 2s timer against a dead port for the rest of the
 * file. The browser itself outlives the test (`openPage`).
 */
async function teardown(pages: Array<Page | undefined>): Promise<void> {
  await Promise.allSettled(
    pages.filter((p): p is Page => p !== undefined).map((p) => p.context().close()),
  );
}

/** Polls `GET /api/chat/em` until the thread has at least `count` entries (each EM turn appends one). Deadline-bounded so a stuck turn fails with a readable message rather than the bun-test budget. */
async function waitForThread(base: string, count: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = (await (await fetch(`${base}/api/chat/em`)).json()) as unknown[];
    if (thread.length >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`chat thread never reached ${count} entries (last saw ${thread.length})`);
    }
    await Bun.sleep(50);
  }
}

/** Polls the rendered chat log for a line containing `text` (this package's tsconfig has no DOM lib, so `page.waitForFunction` is not available here). */
async function waitForChatText(page: Page, text: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.locator('.cr-chat-msg', { hasText: text }).count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`chat log never showed ${JSON.stringify(text)}`);
    await page.waitForTimeout(100);
  }
}

/** T051: polls until `selector` matches exactly `count` elements — the chat's own states (a bubble that stops being pending, an in-flight note that goes) arrive on a socket frame, so "not yet" is a real state here too. */
async function waitForChatCount(
  page: Page,
  selector: string,
  count: number,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await page.locator(selector).count();
    if (seen === count) return;
    if (Date.now() > deadline) {
      throw new Error(`${selector} never reached ${count} elements (last saw ${seen})`);
    }
    await page.waitForTimeout(100);
  }
}

/** Polls one attribute of one element until it reads `value` — the control room's rows render from an async `GET`, so "not yet loaded" is a real state, not a failure. */
async function waitForAttr(
  page: Page,
  selector: string,
  attribute: string,
  value: string,
  timeoutMs = 10000,
): Promise<void> {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await locator.getAttribute(attribute)) === value) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${selector} never reached ${attribute}="${value}" (last saw ${JSON.stringify(
          await locator.getAttribute(attribute),
        )})`,
      );
    }
    await page.waitForTimeout(100);
  }
}

/** Polls one locator's text until it matches — the sibling of `waitForAttr`. */
async function waitForText(
  page: Page,
  selector: string,
  text: string,
  timeoutMs = 10000,
): Promise<void> {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await locator.textContent()) === text) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${selector} never read ${JSON.stringify(text)} (last saw ${JSON.stringify(
          await locator.textContent(),
        )})`,
      );
    }
    await page.waitForTimeout(100);
  }
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-control-room-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

/**
 * T111: the daemon's state lives in `$AGILE_HOME`, never inside the repo.
 * Each test gets a fresh temp home and points `AGILE_HOME` at it so the
 * daemon it starts (via `discoverConfig`) opens the same home this test
 * seeded.
 */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agile-e2e-home-'));
  process.env.AGILE_HOME = home;
  return home;
}

describe('control room shell (Playwright e2e)', () => {
  browserTest(
    'renders the project block, a seeded gate and an open question as Needs-you items',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;
      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        const streams = new StreamService(store);
        const questions = new QuestionService(store, streams);
        const gates = new GateService(store);
        const stream = await streams.create('human', {
          title: 'A stream',
          goal: 'do the thing',
        });
        const seeded = await gates.request('classifier_review', {
          policy: store.getPolicy(),
          stream: stream.id,
          summary: 'classifier says this is a rule change',
        });
        await questions.raise({
          stream: stream.id,
          raised_by: 'human',
          text: 'which branch should this land on?',
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/`);
        await page
          .locator('.cr-needs-you')
          .waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });

        expect(await page.locator('.cr-project').textContent()).toBe(
          init.home.split('/').pop() ?? '',
        );
        expect(await page.locator('.cr-needs-you').textContent()).toContain('2');
        const body = (await page.locator('.cr-root').textContent()) ?? '';
        expect(body).toContain(seeded.id);
        expect(body).toContain('which branch should this land on?');
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    BODY_BUDGET_MS,
  );
});
