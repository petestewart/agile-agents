/**
 * Playwright e2e for the control room SPA (T025 — design
 * agile-agents-design.md §17 "Control room"; ticket Validation Steps:
 * "Playwright against a seeded daemon"). Same Chromium discovery as
 * `feed.e2e.test.ts` (`resolveChromiumExecutable`, which throws rather than
 * skipping when no browser is installed) and the same `startDaemon` harness — this covers the render + the
 * read/write paths through `startDaemon`'s real wiring, `bus.send` included
 * (T025 review round 1 blocker 3: `daemon.ts` now passes its `Bus` into
 * `startHttpServer`, so chat/propose-edit are exercised for real here, not
 * pinned at their old 503).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession,
} from '@agile-agents/acp-client';
import { ulid } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { Bus } from '../bus';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { StateStore } from '../store';
import {
  BROWSER_ATTEMPTS,
  BROWSER_READY_BUDGET_MS,
  acquireBrowserPage,
  resolveChromiumExecutable,
  runWithinBudget,
} from './chromium';

const executablePath = resolveChromiumExecutable();

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

/**
 * T041: the offline stand-in for the resident EM's vendor — the same
 * `fake-agent.ts` subprocess `runner/fake-driver.ts`'s `createFakeSpawn`
 * uses, scripted to answer any prompt with one canned reply. No vendor
 * login, no `AGILE_LIVE`.
 */
function cannedEmSpawn(
  repo: string,
  reply: string,
  /**
   * T051: how long the scripted vendor takes before it says anything. The
   * default 0 keeps every earlier test's timing; a non-zero delay is what
   * makes "what the panel shows *while* a turn runs" observable at all —
   * without it the reply lands in the same frame as the click.
   */
  options?: { replyAfterMs?: number },
): (opts: SpawnSessionOptions) => SpawnedSession {
  const scriptPath = join(repo, 'em-chat-script.json');
  const replyAfterMs = options?.replyAfterMs ?? 0;
  writeFileSync(
    scriptPath,
    JSON.stringify({
      steps: [
        ...(replyAfterMs > 0 ? [{ type: 'delay', ms: replyAfterMs }] : []),
        { type: 'agent_text', text: reply },
        { type: 'end_turn' },
      ],
    }),
  );
  return (opts: SpawnSessionOptions) =>
    spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: scriptPath },
    });
}

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
 * T042 merge note: every test here that asserts Sprint-view content opens
 * `/control-room?view=sprint`. Plan is now the landing view (§17 v2: "The
 * repo opens here with an empty plan and a chat"), which these tests predate;
 * the `?view=` deep link is T043's own (`main.tsx`), so this is one query
 * parameter rather than a click on the nav in each test. The two tests that
 * drive the nav themselves are unaffected either way.
 */

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

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-control-room-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

/**
 * T047: the shared starting state behind the four `the chrome: …` tests.
 *
 * T043 folded those four sections into a single test so this file would only
 * launch Chromium once. The launch budget is still the constraint
 * (`openPage`), but the fold also made the *test* the unit of retry,
 * and `browserTest`'s browser-loss retry re-runs a body from the top. Under a
 * whole-suite single-process `bun test` — 158 files, Chromium sharing the
 * process with subprocess-heavy siblings — the folded body used most of its
 * 60 s budget on its own, so a disconnection in its second half put the retry
 * past the budget and failed the run (2/2 whole-suite runs, while the file
 * passed 10/10 on its own via `test:e2e`). The four sections are four tests
 * now: one browser still, one `chromium.launch()` still, but a quarter of the
 * work per budget and a retry that costs a quarter as much.
 *
 * Every section wants the same starting state — a running sprint, one working
 * agent, one ticket and one pending `unblock` — on a dark page already
 * showing the Sprint view, and cleans up its own repo, daemon and page
 * context (`teardown` before `stop`, as everywhere else in this file).
 */
type ChromeFixture = {
  repo: string;
  store: StateStore;
  gates: GateService;
  page: Page;
  /** The seeded pending `unblock`: section 0's Needs-you row, section A's badge count. */
  hilId: string;
};

async function withChrome(body: (fixture: ChromeFixture) => Promise<void>): Promise<void> {
  const repo = initRepo();
  let handle: DaemonHandle | undefined;
  let page: Page | undefined;

  try {
    const init = runInit(repo);
    const store = StateStore.open(init.stateRoot);
    const gates = new GateService(store);
    const seeded = await gates.request('unblock', {
      policy: { gates: { unblock: 'human' }, breaker_signals: [] },
      hilKind: 'unblock',
    });
    await store.putTicket({
      id: 'TKT-9102',
      title: 'Dark mode fixture ticket',
      status: 'ready',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });
    // T043: a running sprint and a working agent, so every part of the
    // top bar has real content to render (an empty bar proves nothing).
    await store.putSprint({
      id: 'S-1',
      goal: 'chrome fixture sprint',
      tickets: [],
      budget_tokens: 1000,
      started: new Date().toISOString(),
      carried_over: [],
    });
    await store.putAgent('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      last_seen: new Date().toISOString(),
      ticket: 'TKT-9102',
    });

    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });

    page = await openPage({ colorScheme: 'dark' });
    await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);
    // T042 merge note: the Sprint view is reached by `?view=` deep link
    // because Plan is now the landing view (§17 v2). Wait for the chrome's
    // first render here rather than in each section — the bar is what every
    // section below reads, directly or through the view it frames.
    await page
      .locator('[data-testid="topbar"]')
      .waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });

    await body({ repo, store, gates, page, hilId: seeded.id });
  } finally {
    await teardown([page]);
    await handle?.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('control room SPA (Playwright e2e)', () => {
  // T043: the chrome tests run first — see `openPage` for why test
  // order in this file is load-bearing on this container.
  /**
   * T025 review round 1 blocker 4 (dark mode fell back to UA
   * ButtonFace/ButtonText on every clickable surface), extended by T043 to
   * the top half of the new chrome (§17 "Control room v2"), and split by
   * T047 into the four tests below — one per section, sharing the one
   * browser and the one `withChrome` fixture:
   *   0.  the T025 dark-mode surfaces
   *   A.  the top bar is identical on Plan, Sprint and Settings
   *   A2. finished + review pending: the single action is disabled
   *   B.  the tool row's chat modes and the rail collapse
   * Settings' own half is the test after them.
   */
  browserTest(
    'the chrome: dark mode on every clickable surface',
    () =>
      withChrome(async ({ page, hilId }) => {
        // `page.evaluate`'s callback runs in the browser, where `document`/
        // `getComputedStyle` exist — this file's own (non-DOM) tsconfig lib
        // does not know that, hence the loose `any` cast rather than a `dom`
        // lib change to a package that has no other browser-context code.
        const colorScheme = await page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: browser-context globals, see comment above
          const win = globalThis as any;
          return win.getComputedStyle(win.document.documentElement).colorScheme as string;
        });
        expect(colorScheme).toContain('dark');

        const hilItem = page.locator(`.hil-item[data-id="${hilId}"]`);
        await hilItem.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        // T044: the Sprint body is the strip + Needs-you cards + one story
        // per ticket; the story and the Needs-you card are the two surfaces
        // that used to be the Board card and the panel header here.
        const storyCard = page.locator('[data-testid="ticket-card-TKT-9102"]');
        await storyCard.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        const storyOpen = page.locator('[data-testid="story-open-TKT-9102"]');

        const UA_LIGHT_BG = 'rgb(239, 239, 239)';
        const UA_LIGHT_TEXT = 'rgb(0, 0, 0)';

        for (const locator of [storyOpen, hilItem, storyCard]) {
          const { bg, color } = await locator.evaluate((el) => {
            // biome-ignore lint/suspicious/noExplicitAny: browser-context globals, see comment above
            const cs = (globalThis as any).getComputedStyle(el);
            return { bg: cs.backgroundColor as string, color: cs.color as string };
          });
          expect(bg).not.toBe(UA_LIGHT_BG);
          expect(color).not.toBe(UA_LIGHT_TEXT);
        }
      }),
    TEST_BUDGET_MS,
  );

  browserTest(
    'the chrome: one top bar, identical on Plan, Sprint and Settings',
    () =>
      withChrome(async ({ page, repo }) => {
        const topbar = page.locator('[data-testid="topbar"]');

        // Ticket AC: "Screenshots of Plan, Sprint and Settings show the
        // identical top bar" — asserted as DOM rather than pixels: the bar's
        // text and the order of its parts must be byte-identical across the
        // three views, and only `aria-current` on the nav may differ (§17 v2
        // "Top bar is identical on every view"; Pete's note, "nothing in the
        // bar should move between views").
        // The running timer is the one thing that legitimately differs between
        // two reads seconds apart, so it is normalized away; everything else —
        // text and the order of the bar's parts — must match exactly.
        const readBar = async (): Promise<{ text: string; order: string[] }> => {
          const text = ((await topbar.textContent()) ?? '').replace(/\d+m \d+s/g, 'Xm XXs');
          const order = await topbar.evaluate((el) => {
            // biome-ignore lint/suspicious/noExplicitAny: browser-context globals
            const children = Array.from((el as any).children as ArrayLike<Record<string, string>>);
            return children.map((child) => child.className ?? child.tagName ?? '');
          });
          return { text, order };
        };

        const bars: Array<{ text: string; order: string[] }> = [];
        for (const view of ['plan', 'sprint', 'settings'] as const) {
          await page.locator(`[data-testid="topbar"] button[data-view="${view}"]`).click();
          // The view actually changed — otherwise "identical" is trivially true.
          await page
            .locator(`.cr-frame[data-view="${view}"]`)
            .waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
          bars.push(await readBar());
        }
        const first = bars[0] as { text: string; order: string[] };
        expect(bars[1]).toEqual(first);
        expect(bars[2]).toEqual(first);
        // ...and it is the real bar, not three empty ones. The Sprint tab
        // carries the Needs-you count (§17 v2) — one seeded `hil_request`.
        expect(first.text).toContain('PlanSprint1Settings');
        expect(await page.locator('[data-testid="needs-you-badge"]').textContent()).toBe('1');
        expect(first.text).toContain('Sprint 1 · running');
        expect(first.text).toContain('1 agent working');
        expect(first.text).toContain('Halt Sprint 1');

        // The project name, with its path on hover (§17 v2).
        const project = page.locator('[data-testid="topbar-project"]');
        expect(await project.textContent()).toBe(repo.split('/').pop() ?? repo);
        expect(await project.getAttribute('title')).toBe(repo);

        // Every tool-row button is icon-only, so every one must carry a
        // tooltip and an accessible name, and be reachable by keyboard.
        for (const id of ['chat-toggle', 'chat-popout', 'chat-maximize']) {
          const button = page.locator(`[data-testid="${id}"]`);
          expect(await button.getAttribute('title')).toBeTruthy();
          expect(await button.getAttribute('aria-label')).toBeTruthy();
          await button.focus();
          const focused = await page.evaluate(
            // biome-ignore lint/suspicious/noExplicitAny: browser-context globals
            () => ((globalThis as any).document.activeElement as any)?.dataset?.testid as string,
          );
          expect(focused).toBe(id);
        }
      }),
    TEST_BUDGET_MS,
  );

  browserTest(
    'the chrome: a finished sprint with a pending review disables the action',
    () =>
      withChrome(async ({ page, store, gates }) => {
        // Mockup `#s4`: "Sprint 1 · finished in 7m 09s · review pending" with a
        // *disabled* "Start Sprint 2" titled "Review Sprint 1 first". Both
        // writes go through the store, so the page learns about them over its
        // already-open `/ws` — no reload, no fetch from this test.
        const action = page.locator('[data-testid="sprint-action"]');
        await action.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await action.textContent()).toBe('Halt Sprint 1');
        await gates.request('sprint_review', {
          policy: { gates: { sprint_review: 'human' }, breaker_signals: [] },
          hilKind: 'demo',
        });
        await store.putSprint({
          ...store.getSprint('S-1'),
          retro: { mispointed: [], global_halts: 0, escalations: 0 },
        });
        await waitForAttr(page, '[data-testid="sprint-action"]', 'disabled', '');
        expect(await action.textContent()).toBe('Start Sprint 2');
        expect(await action.getAttribute('title')).toBe('Review Sprint 1 first');
        expect(await page.locator('[data-testid="sprint-status"]').textContent()).toBe(
          'Sprint 1 · finished · review pending',
        );
        // Clicking a disabled button does nothing — no sprint is started.
        await action.click({ force: true }).catch(() => {});
        expect(store.listSprints().map((sp) => sp.id)).toEqual(['S-1']);
      }),
    TEST_BUDGET_MS,
  );

  browserTest(
    'the chrome: chat modes and the rail collapse',
    () =>
      withChrome(async ({ page }) => {
        const frame = page.locator('.cr-frame');
        await frame.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await frame.getAttribute('data-chat')).toBe('panel');
        expect(await page.locator('.cr-chat-col').count()).toBe(1);
        expect(await page.locator('.cr-main').count()).toBe(1);

        // Hide: the chat column goes, the middle pane stays.
        await page.locator('[data-testid="chat-toggle"]').click();
        expect(await frame.getAttribute('data-chat')).toBe('hidden');
        expect(await page.locator('.cr-chat-col').count()).toBe(0);
        expect(await page.locator('.cr-main').count()).toBe(1);

        // Show again, then maximize: "Chat maximize hides the middle pane".
        await page.locator('[data-testid="chat-toggle"]').click();
        await page.locator('[data-testid="chat-maximize"]').click();
        expect(await frame.getAttribute('data-chat')).toBe('max');
        expect(await page.locator('.cr-main').count()).toBe(0);
        expect(await page.locator('.cr-chat-col').count()).toBe(1);

        // Restore brings both back.
        await page.locator('[data-testid="chat-maximize"]').click();
        expect(await frame.getAttribute('data-chat')).toBe('panel');
        expect(await page.locator('.cr-main').count()).toBe(1);

        // The rail collapse is a Plan-screen control and survives a reload
        // (ticket scope: "persisted in localStorage").
        await page.locator('[data-testid="topbar"] button[data-view="plan"]').click();
        const planScreen = page.locator('[data-testid="plan-screen"]');
        await planScreen.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await planScreen.getAttribute('data-rail')).toBe('expanded');
        await page.locator('[data-testid="rail-toggle"]').click();
        expect(await planScreen.getAttribute('data-rail')).toBe('collapsed');
        // Persisted per browser, so the next page load starts collapsed
        // (asserted on the stored value rather than a reload: every extra
        // navigation is work this contended process can ill afford).
        const stored = await page.evaluate(() =>
          // biome-ignore lint/suspicious/noExplicitAny: browser-context globals
          (globalThis as any).localStorage.getItem('agile.cr.rail-collapsed'),
        );
        expect(stored).toBe('1');
      }),
    TEST_BUDGET_MS,
  );

  /**
   * T043, Settings' half of the chrome (§17 journey step 4 + v2 "Spend ... is
   * a Settings row and a pop-out modal"). Split out of the test above after
   * QA round 1: together they ran past their budget under the contention of
   * the ticket's own validation step, `bun test packages/daemon/src/feed`.
   * Sections:
   *   C. a Who-decides edit round-trips and changes the next gate's owner
   *   D. dark AND light: none of the chrome falls back to a UA colour
   */
  browserTest(
    'Settings: a Who-decides edit changes the next gate, spend pops out, dark and light both render',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const gates = new GateService(store);

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage({ colorScheme: 'dark' });
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=settings`);

        const UA_LIGHT_BG = 'rgb(239, 239, 239)';
        const UA_LIGHT_TEXT = 'rgb(0, 0, 0)';

        // ---- C. Who decides: a policy edit that changes the next gate -------
        // The repo default delegates `unblock` to the EM.
        expect(store.getPolicy().gates.unblock).toBe('em');
        const askMe = page.locator('[data-testid="gate-unblock-human"]');
        await askMe.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        // The rows render from `GET /api/policy`; before it lands every row
        // reads as the fail-safe `human` (`resolveGate`'s default), which is
        // the very value this section is about to write — so wait for the real
        // policy first.
        await waitForAttr(page, '[data-testid="gate-unblock-em"]', 'aria-pressed', 'true');
        expect(await askMe.getAttribute('aria-pressed')).toBe('false');

        await askMe.click();
        // The segment reflects the saved policy the daemon handed back...
        await waitForAttr(page, '[data-testid="gate-unblock-human"]', 'aria-pressed', 'true');
        // ...it is on disk through the store, with a `policy_put` event...
        expect(store.getPolicy().gates.unblock).toBe('human');
        expect(store.listEvents().some((e) => e.kind === 'policy_put' && e.agent === 'human')).toBe(
          true,
        );
        // ...and the NEXT gate raised resolves to the new owner.
        const raised = await gates.request('unblock', {
          policy: store.getPolicy(),
          hilKind: 'unblock',
        });
        expect(raised.owner).toBe('human');

        // Spend moved out of the top bar into a Settings row that opens a
        // modal which can pop out (§17 v2: "Spend is not in the top bar; it is
        // a Settings row and a pop-out modal").
        await page.locator('[data-testid="open-spend"]').click();
        await page
          .locator('[data-testid="spend-modal"]')
          .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
        const spendPopout = page.locator('[data-testid="spend-modal-popout"]');
        expect(await spendPopout.getAttribute('title')).toBeTruthy();
        expect(await spendPopout.getAttribute('aria-label')).toBeTruthy();
        await page.locator('[data-testid="spend-modal"] .cr-modal-actions button').click();
        await page
          .locator('[data-testid="spend-modal"]')
          .waitFor({ state: 'detached', timeout: PAGE_TIMEOUT_MS });

        // A preset writes every gate at once, and the chooser reads back what
        // the gates block now says.
        await page.locator('[data-testid="preset-hands-off"]').click();
        await waitForAttr(page, '[data-testid="preset-hands-off"]', 'aria-pressed', 'true');
        expect(store.getPolicy().gates).toMatchObject({
          approve_plan: 'em',
          approve_decision: 'em',
          unblock: 'em',
          sprint_review: 'em',
          demo: 'em',
        });

        // Review round 1 blocker 2: the middle preset is the mockup's rendered
        // "Plans and reviews" state — the rule-change gate (`approve_decision`)
        // stays with the human, it is not delegated with the rest.
        await page.locator('[data-testid="preset-gates-to-em"]').click();
        await waitForAttr(page, '[data-testid="preset-gates-to-em"]', 'aria-pressed', 'true');
        expect(store.getPolicy().gates).toMatchObject({
          approve_plan: 'human',
          approve_decision: 'human',
          sprint_review: 'human',
          unblock: 'em',
          demo: 'em',
        });
        expect(
          await page
            .locator('[data-testid="gate-approve_decision-human"]')
            .getAttribute('aria-pressed'),
        ).toBe('true');

        // ---- D. dark and light both render ---------------------------------
        // T025 review round 1 blocker 4, extended to the new chrome: none of
        // it may fall back to the UA ButtonFace/ButtonText palette (the two
        // light constants are the ones declared above).
        const UA_DARK_BG = 'rgb(59, 59, 59)';

        for (const colorScheme of ['dark', 'light'] as const) {
          // `page.emulateMedia`, not a second `browser.newPage({colorScheme})`
          // and no reload: `prefers-color-scheme` is a live media query, so
          // flipping it re-evaluates the same CSS the control room themes with
          // — and every extra page/navigation in this file is work this
          // contended process can ill afford.
          await page.emulateMedia({ colorScheme });

          const scheme = await page.evaluate(() => {
            // biome-ignore lint/suspicious/noExplicitAny: browser-context globals
            const win = globalThis as any;
            return win.getComputedStyle(win.document.documentElement).colorScheme as string;
          });
          expect(scheme).toContain(colorScheme);

          for (const selector of [
            '[data-testid="topbar"] button[data-view="plan"]',
            '[data-testid="sprint-action"]',
            '[data-testid="chat-toggle"]',
            '[data-testid="gate-unblock-human"]',
            '[data-testid="preset-hands-off"]',
          ]) {
            const { bg, color } = await page.locator(selector).evaluate((el) => {
              // biome-ignore lint/suspicious/noExplicitAny: browser-context globals
              const cs = (globalThis as any).getComputedStyle(el);
              return { bg: cs.backgroundColor as string, color: cs.color as string };
            });
            expect(bg).not.toBe(UA_LIGHT_BG);
            expect(bg).not.toBe(UA_DARK_BG);
            if (colorScheme === 'dark') expect(color).not.toBe(UA_LIGHT_TEXT);
          }
        }
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'renders Needs You from a seeded hil_request, approves it for real, and reflects a live halt',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const gates = new GateService(store);

        // Seed one open HIL request and one ticket before the daemon (and the
        // page) ever start, so the page's initial reads already carry them.
        const seeded = await gates.request('unblock', {
          policy: { gates: { unblock: 'human' }, breaker_signals: [] },
          hilKind: 'unblock',
        });
        await store.putTicket({
          id: 'TKT-9101',
          title: 'Control room e2e fixture ticket',
          status: 'ready',
          contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
          depends: [],
          oracle_refs: [],
          kb_refs: [],
          history: [],
          security: false,
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        // "Needs you" inbox renders the seeded hil_request (§17 "Attention
        // queue": one line per item, deadline, approve/delegate).
        const hilItem = page.locator(`.hil-item[data-id="${seeded.id}"]`);
        await hilItem.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await hilItem.textContent()).toContain('unblock');

        // Board renders the seeded ticket from GET /api/tickets (a T025 read
        // endpoint that did not exist before this ticket).
        const ticketCard = page.locator('[data-testid="ticket-card-TKT-9101"]');
        await ticketCard.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });

        // Detail-on-click: approve resolves the real hil_request the daemon's
        // GateService owns (never a client-side-only state change).
        await hilItem.click();
        // T039 (§17 "Control room v2"): the card takes a typed answer as well
        // as its buttons — the note rides along with the approve.
        await page.locator('[data-testid="hil-note"]').fill('yes, but only for the seed script');
        await page.locator('[data-testid="hil-approve"]').click();
        await hilItem.waitFor({ state: 'detached', timeout: PAGE_TIMEOUT_MS });

        const onDisk = store.getEntity(
          `board/hil/${seeded.id}.yaml`,
          (v) => v as { status: string; decision: string; decided_by: string; note?: string },
        );
        expect(onDisk.status).toBe('resolved');
        expect(onDisk.decision).toBe('approve');
        expect(onDisk.decided_by).toBe('human');
        expect(onDisk.note).toBe('yes, but only for the seed script');

        // T043: the top bar's single action (§17 v2 "the single action (Start
        // Sprint N / Halt Sprint N)") replaces T025's separate Halt button.
        // With a sprint running it halts; the halt is a real one through
        // `createHalt`, reflected back over the live /ws snapshot into the
        // sprint strip, and the button then offers Resume.
        await store.putSprint({
          id: 'S-1',
          goal: 'halt fixture sprint',
          tickets: [],
          budget_tokens: 1000,
          started: new Date().toISOString(),
          carried_over: [],
        });
        const action = page.locator('[data-testid="sprint-action"]');
        const haltDeadline = Date.now() + POLL_DEADLINE_MS;
        while (!(await action.textContent())?.startsWith('Halt') && Date.now() < haltDeadline) {
          await page.waitForTimeout(100);
        }
        expect(await action.textContent()).toBe('Halt Sprint 1');
        await action.click();
        const haltCount = page.locator('[data-testid="halt-count"]');
        const deadline = Date.now() + POLL_DEADLINE_MS;
        let text = await haltCount.textContent();
        while (text !== '1' && Date.now() < deadline) {
          await page.waitForTimeout(100);
          text = await haltCount.textContent();
        }
        expect(text).toBe('1');
        expect(store.listHalts()).toHaveLength(1);
        expect(store.listHalts()[0]?.raised_by).toBe('human');
        // A raised halt takes the button over: the only useful next move.
        expect(await action.textContent()).toBe('Resume Sprint 1');
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'chat panel send lands a real fyi message on the em inbox and logs a message event',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const bus = new Bus(store, init.stateRoot);

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          // T041: the send now also runs a resident EM turn — point it at the
          // fake ACP transport so this offline test never tries to spawn a
          // real vendor (`test:integration` must pass with no vendor login).
          emChatSpawn: cannedEmSpawn(repo, 'ack'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        const textarea = page.locator('.cr-chat-input textarea');
        await textarea.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        await textarea.fill('steer: reroute this ticket off openai');
        await page.locator('.cr-chat-input button').click();

        // No inline error — the message actually went through.
        const error = page.locator('.cr-chat-log', { hasText: 'bus not wired' });
        expect(await error.count()).toBe(0);

        // Real behaviour, not a UI-only optimistic append: the message is on
        // the em inbox on disk, sent as `human`, and a `message` event was
        // logged (ticket AC: "every write ... appears in the event log").
        const deadline = Date.now() + POLL_DEADLINE_MS;
        let inbox = bus.poll('em');
        while (
          !inbox.some((m) => m.body.includes('reroute this ticket off openai')) &&
          Date.now() < deadline
        ) {
          await page.waitForTimeout(100);
          inbox = bus.poll('em');
        }
        const delivered = inbox.find((m) => m.body.includes('reroute this ticket off openai'));
        expect(delivered?.from).toBe('human');
        expect(store.listEvents().some((e) => e.kind === 'message' && e.data.kind === 'fyi')).toBe(
          true,
        );
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'propose-edit sends a real decision request to the architect, never writes the oracle directly',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const bus = new Bus(store, init.stateRoot);
        await store.putOracleEntry(
          {
            id: 'DEC-0001',
            title: 'Fixture decision',
            status: 'active',
            supersedes: [],
            depends: [],
            affects: [],
            decided: '2026-09-08',
            by: 'architect',
            rationale: 'fixture',
          },
          'Full decision body.',
        );

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        // The Oracle/KB list only renders once that tab is selected (Ops is
        // the default view, §17 "Layout direction").
        await page.getByRole('button', { name: 'Oracle / KB' }).click();
        await page.locator('[data-testid="oracle-item-DEC-0001"]').waitFor({
          state: 'attached',
          timeout: PAGE_TIMEOUT_MS,
        });
        await page.locator('[data-testid="oracle-item-DEC-0001"]').click();
        await page.locator('#propose-edit').fill('Widen the grace window to 60s.');
        await page.locator('[data-testid="propose-edit-submit"]').click();

        const deadline = Date.now() + POLL_DEADLINE_MS;
        let inbox = bus.poll('architect');
        while (!inbox.some((m) => m.body.includes('60s')) && Date.now() < deadline) {
          await page.waitForTimeout(100);
          inbox = bus.poll('architect');
        }
        const delivered = inbox.find((m) => m.body.includes('60s'));
        expect(delivered?.from).toBe('human');
        expect(delivered?.kind).toBe('decision');
        // Never a direct write — the oracle entry itself is untouched.
        expect(store.getOracleEntry('DEC-0001' as never).entry.title).toBe('Fixture decision');
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  // QA round 1 (REJECT): an external change (a ticket transitioned through
  // the store directly, not via this browser's own write) must reach the
  // Board without a manual reload.
  browserTest(
    'an external ticket transition through the store moves the Board card without a page reload',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        await store.putTicket({
          id: 'TKT-9103',
          title: 'Live-refresh fixture ticket',
          status: 'draft',
          contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
          depends: [],
          oracle_refs: [],
          kb_refs: [],
          history: [],
          security: false,
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        // T044: the ticket is a story, and its stage pill is what a status
        // change moves (the Board's columns are gone).
        const card = page.locator('[data-testid="ticket-card-TKT-9103"]');
        await card.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        const stage = page.locator('[data-testid="story-stage-TKT-9103"]');
        const initialStage = (await stage.textContent()) ?? '';
        expect(initialStage).toContain('Draft');

        // External change: no fetch/reload call from this test — the daemon's
        // own store is mutated directly, the way another agent's process
        // would, and the page must pick it up over its already-open /ws.
        await store.transitionTicket('TKT-9103', 'ready', { by: 'test' });

        const deadline = Date.now() + POLL_DEADLINE_MS;
        let label = initialStage;
        while (label.includes('Draft') && Date.now() < deadline) {
          await page.waitForTimeout(100);
          label = (await stage.textContent()) ?? '';
        }
        expect(label).toContain('Ready');
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  // T032: a heartbeat-only `agent_put` (store.ts's `heartbeat()`, the
  // `data: {heartbeat: true}` shape) must NOT trigger `refreshAux`'s
  // six-endpoint refetch — before this fix, one arrived roughly every 30s
  // per live agent and re-pulled agents/tickets/oracle/kb/policy/snapshot
  // for no observable change every time. A real (non-heartbeat) `agent_put`
  // — e.g. `putAgent` registering a role change — must still refetch.
  browserTest(
    'a heartbeat burst causes zero /api/* refetches; a real agent_put still refetches',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const agentId = 'agent-heartbeat-e2e' as never;
        await store.putAgent(agentId, {
          vendor: 'claude',
          model: 'sonnet',
          last_seen: new Date(0).toISOString(),
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        const apiRequests: string[] = [];
        page.on('request', (req) => {
          const path = new URL(req.url()).pathname;
          if (path.startsWith('/api/')) apiRequests.push(path);
        });

        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);
        // Let the initial mount's own refreshAux (six requests) settle before
        // measuring — only requests from here on are attributable to events.
        await page.waitForTimeout(500);
        apiRequests.length = 0;

        // 20-heartbeat burst: each call advances `now` well past
        // HEARTBEAT_COALESCE_MS so every one actually writes and mints its
        // own `agent_put` (real 30s-apart beats), rather than being coalesced
        // away — this exercises the UI's event filter, not the store's
        // coalescing (that's `store.test.ts`'s job).
        let simulatedNow = Date.now();
        for (let i = 0; i < 20; i++) {
          simulatedNow += 40_000;
          const beatTime = simulatedNow;
          await store.heartbeat(agentId, {}, () => new Date(beatTime));
        }

        // Give the (debounced, 150ms) refresh path every chance to have fired
        // if it were going to.
        await page.waitForTimeout(800);
        expect(apiRequests).toEqual([]);

        // A real agent_put (role/registration change, not a heartbeat) still
        // triggers the refetch — the filter targets the heartbeat shape
        // specifically, it doesn't silently swallow every agent_put.
        await store.putAgent(agentId, {
          vendor: 'claude',
          model: 'sonnet',
          last_seen: new Date(simulatedNow).toISOString(),
          role: 'engineer',
        });

        const deadline = Date.now() + POLL_DEADLINE_MS;
        while (apiRequests.length === 0 && Date.now() < deadline) {
          await page.waitForTimeout(100);
        }
        expect(apiRequests.length).toBeGreaterThan(0);
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  /**
   * T040 (§17 "Control room v2" → "Questions vs Decisions"): a pending
   * question is a Needs-you card, and answering it on the card marks it
   * answered for real — through the daemon's own `QuestionService`, not a
   * client-side state change.
   */
  browserTest(
    'an open question renders as a Needs-you card and answering it marks it answered',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const questions = new QuestionService(store);

        const seeded = await questions.raise({
          raised_by: 'eng-1',
          text: 'the contract contradicts the spec — which wins?',
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        const card = page.locator(`.question-item[data-id="${seeded.id}"]`);
        await card.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await card.textContent()).toContain('which wins?');

        await card.click();
        await page
          .locator('[data-testid="question-answer"]')
          .fill('the spec wins — refine the ticket');
        await page.locator('[data-testid="question-reply"]').click();
        await card.waitFor({ state: 'detached', timeout: PAGE_TIMEOUT_MS });

        const onDisk = store.getEntity(
          `board/questions/${seeded.id}.yaml`,
          (v) => v as { status: string; answer: string; resolved_as: string; answered_by: string },
        );
        expect(onDisk.status).toBe('answered');
        expect(onDisk.answer).toBe('the spec wins — refine the ticket');
        expect(onDisk.resolved_as).toBe('reply');
        expect(onDisk.answered_by).toBe('human');
        // The answer reached the engineer that raised it.
        expect(store.listEntities('bus/inbox/eng-1', (v) => v)).toHaveLength(1);
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  /**
   * T041 acceptance, offline half: "in a live run, 'what is left on all
   * tickets' gets an answer in the panel within one turn; the pop-out window
   * and the in-page panel show the same thread". Driven through the fake ACP
   * transport, so the whole path — `POST /api/chat/em` -> resident EM turn ->
   * `chat_delta`/`chat_turn_end` on `/ws` -> bus thread -> `GET
   * /api/chat/em` — is real except for the vendor.
   */
  browserTest(
    'the chat panel answers within one turn, and the reply survives a reload and the pop-out route',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;
      let popout: Page | undefined;
      const reply = 'TKT-1001 is in review; TKT-1002 is unassigned.';

      try {
        runInit(repo);
        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          emChatSpawn: cannedEmSpawn(repo, reply),
        });
        const base = `http://127.0.0.1:${handle.http.port}`;

        /**
         * QA round 1 deflake, part 1: the first turn goes over plain HTTP,
         * before Chromium exists. Two things come of it — the browser-driven
         * turn below then reuses an *already resident* session and spawns
         * nothing (which is what this ticket built, and is now asserted), and
         * the browser's life no longer straddles a vendor spawn, which is what
         * made the remaining failure mode reproducible enough to locate (see
         * the bounded shared close, part 2). It also buys a real assertion for
         * free: the panel must render a thread that existed before the page
         * did.
         */
        const warmup = await fetch(`${base}/api/chat/em`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'warm up the resident EM session' }),
        });
        expect(warmup.status).toBe(200);
        await waitForThread(base, 2);
        expect(handle.residentEm?.alive).toBe(true);

        page = await openPage();
        await page.goto(`${base}/control-room?view=sprint`);

        // The panel renders the thread that already existed before this page
        // did — history comes from the bus (`GET /api/chat/em`), not from
        // anything this browser did.
        await waitForChatText(page, 'warm up the resident EM session');

        const textarea = page.locator('.cr-chat-input textarea');
        await textarea.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        await textarea.fill('what is left on all tickets');
        await page.locator('.cr-chat-input button').click();

        // One turn, answered in the panel — on the already-resident session.
        await waitForChatText(page, 'what is left on all tickets');
        await waitForThread(base, 4);
        await waitForChatText(page, reply);

        // A reload

        // A reload renders the same thread — it comes from the bus, not from
        // anything this page kept in memory.
        await page.reload();
        await waitForChatText(page, reply);
        expect(await page.locator('.cr-chat-msg[data-from="you"]').first().textContent()).toContain(
          'warm up the resident EM session',
        );

        // ... and so does the popped-out window's own route.
        popout = await openPage();
        await popout.goto(`${base}/control-room/chat`);
        await waitForChatText(popout, reply);
        expect(await popout.locator('[data-testid="chat-popout"]').count()).toBe(0);

        // The replies are real `em -> human` bus messages, not a UI-only
        // render: two turns, each answered, in order.
        const thread = (await (await fetch(`${base}/api/chat/em`)).json()) as Array<{
          from: string;
          body: string;
        }>;
        expect(thread.map((e) => e.from)).toEqual(['human', 'em', 'human', 'em']);
        expect(thread[2]?.body).toBe('what is left on all tickets');
        expect(thread[3]?.body).toBe(reply);
        // The browser-driven turn reused the resident session rather than
        // spawning a second one (the ticket's whole premise).
        expect(handle.residentEm?.alive).toBe(true);
      } finally {
        await teardown([page, popout]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  /**
   * T051 (Pete, 2026-09-19: "on Send the EM's pending bubble appears instantly
   * filled with the text of its previous reply"; "it should have a spinner or
   * thinking verb or something until it streams its response").
   *
   * This is the reproduction that found the cause, kept as the regression:
   * turn 1 runs first so there IS a previous reply, the scripted vendor then
   * takes `replyAfterMs` before it says anything, and the assertions are all
   * made in that window. On the pre-fix code the pending bubble already held
   * turn 1's text here, because `acp-client`'s `session.on()` replays the
   * event ring and `ResidentEm.runTurn` attached a listener per turn — so the
   * new turn's first deltas were the previous turn's reply (see
   * `em/resident.test.ts`, which pins the daemon half).
   */
  browserTest(
    'T051: the pending bubble shows a thinking indicator, never the previous reply',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;
      const reply = 'TKT-1001 is in review; TKT-1002 is unassigned.';

      try {
        runInit(repo);
        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          // Slow enough that the in-flight window is observable, short enough
          // that two turns fit well inside this file's per-test budget.
          emChatSpawn: cannedEmSpawn(repo, reply, { replyAfterMs: 3000 }),
        });
        const base = `http://127.0.0.1:${handle.http.port}`;

        // Turn 1 over plain HTTP (same warm-up shape as the test above): the
        // resident session is live and its reply is on the thread before the
        // browser exists, which is the precondition the defect needed.
        const warmup = await fetch(`${base}/api/chat/em`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'warm up the resident EM session' }),
        });
        expect(warmup.status).toBe(200);
        await waitForThread(base, 2);

        page = await openPage();
        await page.goto(`${base}/control-room?view=sprint`);
        await waitForChatText(page, reply);
        expect(await page.locator('.cr-chat-msg[data-from="em"]').count()).toBe(1);

        await page.locator('.cr-chat-input textarea').fill('what is left on all tickets');
        await page.locator('[data-testid="chat-send"]').click();

        // Immediately after Send, inside the vendor's own delay: the human's
        // line is up, and the EM's bubble is a thinking indicator with NO
        // body — this is the assertion the pre-fix code fails, because the
        // bubble held `reply` already.
        // Located as "the EM's second bubble", NOT as "the pending one", so a
        // bubble that is wrongly full of text still gets inspected and the
        // failure names the stale text instead of timing out on a selector.
        await waitForChatCount(page, '.cr-chat-msg[data-from="em"]', 2);
        const pending = page.locator('.cr-chat-msg[data-from="em"]').nth(1);
        const pendingText = (await pending.textContent()) ?? '';
        expect(pendingText).not.toContain(reply);
        expect(pendingText).toContain('thinking');
        expect(await pending.getAttribute('data-pending')).toBe('true');
        expect(await pending.locator('[data-testid="chat-thinking"]').count()).toBe(1);
        expect(await page.locator('.cr-chat-msg[data-from="you"]').nth(1).textContent()).toContain(
          'what is left on all tickets',
        );

        // A second send while the turn is in flight is refused, with the
        // reason on screen rather than a dead button.
        await page.locator('.cr-chat-input textarea').fill('and another thing');
        expect(await page.locator('[data-testid="chat-send"]').isDisabled()).toBe(true);
        expect(await page.locator('[data-testid="chat-busy"]').count()).toBe(1);

        // The deltas fill that same bubble, and the indicator goes at turn end.
        await waitForThread(base, 4);
        await waitForChatCount(page, '.cr-chat-msg[data-from="em"]', 2);
        await waitForChatCount(page, '.cr-chat-msg[data-pending="true"]', 0);
        expect(await page.locator('[data-testid="chat-thinking"]').count()).toBe(0);
        expect(await page.locator('.cr-chat-msg[data-from="em"]').nth(1).textContent()).toContain(
          reply,
        );
        // Exactly one copy of the reply per turn — no stale prefix, no
        // doubled text from a delta that landed on the wrong line.
        expect(
          ((await page.locator('.cr-chat-msg[data-from="em"]').nth(1).textContent()) ?? '').split(
            reply,
          ).length - 1,
        ).toBe(1);

        // Input is free again, and a reload shows the stored thread with no
        // placeholder anywhere.
        await waitForChatCount(page, '[data-testid="chat-busy"]', 0);
        await page.reload();
        await waitForChatText(page, reply);
        expect(await page.locator('[data-testid="chat-thinking"]').count()).toBe(0);
        expect(await page.locator('.cr-chat-msg[data-pending="true"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  /**
   * T051, the other half: "a turn that errors (`resident EM turn failed …`) or
   * times out shows that in the bubble instead of hanging". Forced offline by
   * a vendor command that exits before the ACP handshake — the daemon reports
   * it as a `chat_turn_end` with an `error`, which is the same frame a real
   * failed or timed-out turn ends with.
   */
  browserTest(
    'T051: a turn that fails renders the reason in the bubble and frees the input',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        runInit(repo);
        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          emChatSpawn: (opts: SpawnSessionOptions) =>
            spawnSession({ ...opts, cmd: 'bun', args: ['-e', 'process.exit(1)'] }),
        });
        const base = `http://127.0.0.1:${handle.http.port}`;

        page = await openPage();
        await page.goto(`${base}/control-room?view=sprint`);
        await page.locator('.cr-chat-input textarea').fill('are you there?');
        await page.locator('[data-testid="chat-send"]').click();

        // The failure is in the thread, in the bubble that was waiting for the
        // answer — not a silent spinner and not only a toast.
        const failed = page.locator('[data-testid="chat-line-error"]');
        await failed.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect((await failed.textContent()) ?? '').toContain('could not answer');
        // ...and the panel is usable again: no indicator, no in-flight note.
        await waitForChatCount(page, '[data-testid="chat-thinking"]', 0);
        await waitForChatCount(page, '[data-testid="chat-busy"]', 0);
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
  /**
   * T044 (§17 v2 Sprint + Review, mockup `#s3`/`#s4`): the two new bodies
   * render what the daemon derived — one story per ticket with its
   * timestamped steps and the reviewer's verdict quoted, a Team table that
   * still lists the agent whose session has exited (with the model it ran
   * on), and the sprint-review narrative, which is the same text
   * `em/report.ts` writes into `runs/*.md`.
   *
   * The data half of this — after a REAL offline sprint, against the actual
   * run report file — is asserted in `packages/cli/src/run.e2e.test.ts`,
   * which cannot open a browser of its own without destabilising this file
   * (see `openPage`). Here the finished sprint is seeded directly
   * through the store so the render is exercised with no vendor at all.
   */
  browserTest(
    'the Sprint and Review views: ticket stories, a departed agent in Team, and the review narrative',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);
        const gates = new GateService(store);
        const bus = new Bus(store, init.stateRoot);

        await store.putSprint({
          id: 'S-1',
          goal: 'Transfers, reversals, category report',
          tickets: ['TKT-9201'],
          budget_tokens: 1000,
          started: new Date().toISOString(),
          carried_over: [],
        });
        await store.putTicket({
          id: 'TKT-9201',
          title: 'Add Ledger.transfer between accounts',
          status: 'draft',
          sprint: 'S-1',
          contract: {
            inputs: [],
            outputs: [],
            acceptance: ['transfers move both accounts'],
            done: [],
            env: 'clone',
          },
          depends: [],
          oracle_refs: [],
          kb_refs: [],
          history: [],
          security: false,
        });
        await store.transitionTicket('TKT-9201', 'ready', { by: 'architect' });
        await store.transitionTicket('TKT-9201', 'assigned', { by: 'em' });
        await store.transitionTicket('TKT-9201', 'in_progress', { by: 'eng-9201' });
        await store.appendStanza({
          ts: new Date().toISOString(),
          ticket: 'TKT-9201',
          agent: 'eng-9201',
          kind: 'review_submitted',
          summary: '+61 -0 in 2 files, 6 new tests pass',
        });
        await store.transitionTicket('TKT-9201', 'in_review', { by: 'eng-9201' });
        await store.putEntity(reviewRecordRelPath('TKT-9201', 1, 'primary'), validateReviewRecord, {
          ticket: 'TKT-9201',
          round: 1,
          pass: 'primary',
          agent: 'reviewer-9201',
          ts: new Date().toISOString(),
          findings: [],
          verdict: 'approve',
          hunks: [],
        });
        await bus.send({
          id: ulid(),
          ts: new Date().toISOString(),
          from: 'reviewer-9201',
          to: ['eng-9201'],
          kind: 'review_verdict',
          priority: 'normal',
          ticket: 'TKT-9201',
          body: 'validation happens before either write',
          refs: [reviewRecordRelPath('TKT-9201', 1, 'primary')],
          requires_ack: false,
        });
        await store.transitionTicket('TKT-9201', 'in_qa', { by: 'reviewer-9201' });

        // One agent still working, one whose session has ended — the row
        // for the second must survive (§17 v2: "finished agents stay
        // listed for the sprint").
        await store.putAgent('qa-9201', {
          vendor: 'claude',
          model: 'fake/model-1',
          role: 'qa',
          ticket: 'TKT-9201',
          last_seen: new Date().toISOString(),
        });
        await store.putAgent('eng-9201', {
          vendor: 'claude',
          model: 'fake/model-1',
          role: 'engineer',
          ticket: 'TKT-9201',
          last_seen: new Date().toISOString(),
        });
        await store.deleteAgent('eng-9201');

        // The sprint-review gate: it is what turns the Review view's
        // buttons on, and what the shell switches to on its own.
        await gates.request('sprint_review', {
          policy: { gates: { sprint_review: 'human' }, breaker_signals: [] },
          hilKind: 'approve_decision',
          summary: 'Sprint 1 is ready for your review',
        });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        // A pending sprint_review opens on the Review view; the Sprint view
        // is one click away.
        const summary = page.locator('[data-testid="review-summary"]');
        await summary.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await page.locator('[data-testid="review-asked"]').textContent()).toContain(
          'Transfers, reversals, category report',
        );
        expect(await page.locator('[data-testid="review-where"]').textContent()).toBeTruthy();
        // The narrative the page shows is the one the daemon built — the
        // same function that writes `runs/*.md` (asserted against the real
        // file in the CLI's own e2e).
        const narrative = (await (
          await fetch(`http://127.0.0.1:${handle.http.port}/api/sprint/review`)
        ).json()) as { asked: string; built: string };
        expect(await page.locator('[data-testid="review-asked"]').textContent()).toBe(
          `What was asked: ${narrative.asked}`,
        );
        expect(await page.locator('[data-testid="review-built"]').textContent()).toBe(
          `What was built: ${narrative.built}`,
        );

        await page.locator('[data-testid="sprint-tab-sprint"]').click();

        // The story: timestamped steps, the verdict quoted from the
        // reviewer's own message, and the "what is happening now" line.
        const steps = page.locator('[data-testid="story-steps-TKT-9201"]');
        await steps.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        const storyText = (await steps.textContent()) ?? '';
        expect(storyText).toContain('Built');
        expect(storyText).toContain('6 new tests pass');
        expect(storyText).toContain('Review approved');
        expect(storyText).toContain('validation happens before either write');
        expect(storyText).toContain('QA running in a fresh clone');
        expect(await page.locator('[data-testid="story-stage-TKT-9201"]').textContent()).toBe(
          'In QA',
        );

        // Team: the live QA agent and the departed engineer, both naming a
        // real model id.
        const departed = page.locator('[data-testid="team-row-eng-9201"]');
        await departed.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await departed.getAttribute('data-state')).toBe('left');
        expect(await page.locator('[data-testid="team-model-eng-9201"]').textContent()).toBe(
          'claude / fake/model-1',
        );
        expect(await page.locator('[data-testid="team-model-qa-9201"]').textContent()).toBe(
          'claude / fake/model-1',
        );

        // The ticket detail: contract, blocked-by/blocks and the verdicts
        // off the bus thread (the diff needs a worktree, which this seeded
        // fixture has none of — the panel says so rather than erroring).
        await page.locator('[data-testid="story-open-TKT-9201"]').click();
        const detail = page.locator('[data-testid="ticket-detail"]');
        await detail.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await page.locator('[data-testid="ticket-blocked-by"]').textContent()).toBe(
          'nothing',
        );
        expect(await page.locator('[data-testid="ticket-verdicts"]').textContent()).toContain(
          'validation happens before either write',
        );
        expect(await page.locator('[data-testid="ticket-contract"]').textContent()).toContain(
          'transfers move both accounts',
        );
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    // 60s, like the file's other retry-prone long test: room for one
    // `browserTest` retry (two 20s page waits) under whole-suite contention.
    TEST_BUDGET_MS,
  );
});

/**
 * T050: the Review sub-tab must not offer a sprint review while the sprint
 * is still running. Seen live on ledger-lite (2026-09-19): 1m27s into
 * Sprint 1, with five agents working and every ticket `in_progress`, the
 * tab showed "S-1 is ready for your review", "0 of 3 ticket(s) finished",
 * "Nothing went wrong", the Accept/Send-it-back buttons and "carry all
 * three into the next sprint — 3 tickets did not finish".
 *
 * The three phases are driven by daemon state alone (`SprintReport.phase`,
 * derived from the `sprint_review` gate and `sprint.review_at`), which is
 * the same thing the top bar reads — so tab and bar cannot disagree.
 */
describe('control room — the Review tab across a sprint’s phases', () => {
  browserTest(
    'running: a notice and no decision; pending: the narrative and both buttons; decided: read-only with the decision',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);

        await store.putSprint({
          id: 'S-1',
          goal: 'Transfers, reversals, category report',
          tickets: ['TKT-9301', 'TKT-9302'],
          budget_tokens: 1000,
          started: new Date().toISOString(),
          carried_over: [],
        });
        for (const [id, title] of [
          ['TKT-9301', 'Add Ledger.transfer between accounts'],
          ['TKT-9302', 'Add Ledger.reverse(txId, date)'],
        ] as const) {
          await store.putTicket({
            id,
            title,
            status: 'draft',
            sprint: 'S-1',
            contract: { inputs: [], outputs: [], acceptance: ['it works'], done: [], env: 'clone' },
            depends: [],
            oracle_refs: [],
            kb_refs: [],
            history: [],
            security: false,
          });
          for (const to of ['ready', 'assigned', 'in_progress'] as const) {
            await store.transitionTicket(id, to, { by: 'em' });
          }
        }

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });
        const gates = handle.gateService;
        if (!gates) throw new Error('daemon started without a GateService');

        page = await openPage();
        await page.goto(`http://127.0.0.1:${handle.http.port}/control-room?view=sprint`);

        // Phase 1 — running. The tab is reachable, and says so.
        await page
          .locator('[data-testid="sprint-tab-review"]')
          .waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        await page.locator('[data-testid="sprint-tab-review"]').click();
        const running = page.locator('[data-testid="review-running"]');
        await running.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await running.textContent()).toContain('is running');
        expect(await page.locator('[data-testid="review-accept"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-send-back"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-note"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-proposes"]').count()).toBe(0);
        const progress =
          (await page.locator('[data-testid="review-progress"]').textContent()) ?? '';
        expect(progress).toContain('in progress');
        expect(progress).not.toContain('Nothing went wrong');

        // Phase 2 — the gate is raised: the narrative and both buttons.
        await gates.request('sprint_review', {
          policy: { gates: { sprint_review: 'human' }, breaker_signals: [] },
          hilKind: 'approve_decision',
          summary: 'Sprint 1 is ready for your review',
        });
        const accept = page.locator('[data-testid="review-accept"]');
        await accept.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await page.locator('[data-testid="review-send-back"]').count()).toBe(1);
        expect(await page.locator('[data-testid="review-note"]').count()).toBe(1);
        expect(await page.locator('[data-testid="review-running"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-built"]').textContent()).toContain(
          '0 of 2',
        );

        // Phase 3 — decided: read-only, with the decision that was taken.
        await accept.click();
        const decision = page.locator('[data-testid="review-decision"]');
        await decision.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
        expect(await decision.textContent()).toContain('Accepted');
        expect(await page.locator('[data-testid="review-accept"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-send-back"]').count()).toBe(0);
        expect(await page.locator('[data-testid="review-summary"]').count()).toBe(1);
      } finally {
        await teardown([page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});
