/**
 * Playwright e2e for the cockpit shell (T160, design/cockpit-design.md §3
 * and §9): the inbox, the stream tree and its dots, inline answers, and the
 * phone-width layout. Same Chromium discovery as `feed.e2e.test.ts`
 * (`resolveChromiumExecutable`, which throws rather than skipping when no
 * browser is installed).
 *
 * The daemon side is the real HTTP + `/ws` server (`startHttpServer`) over
 * a real temp home and the real services, including the tailer that pushes
 * the cockpit frame. It is started directly rather than through
 * `startDaemon` for one reason: `QuestionService`'s `deliver` seam — the
 * exact boundary where an answer is handed to the asking session (T137) —
 * is observable here, so "the answer reaches the session" is asserted on
 * the delivery call itself rather than inferred.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import { type Question, ulid } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { AttachService, VerbService } from '../attach';
import { DocsService } from '../docs';
import { GateService } from '../gates';
import { type HttpServerHandle, startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { LandingService } from '../landing';
import { QuestionService } from '../questions';
import { RulesService } from '../rules';
import type { FakeAgentScript } from '../runner/fake-agent';
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

/** Polls until `selector` matches at least one element. */
async function waitForCount(page: Page, selector: string, atLeast: number): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    const seen = await page.locator(selector).count();
    if (seen >= atLeast) return;
    if (Date.now() > deadline) {
      throw new Error(`${selector} never reached ${atLeast} elements (last saw ${seen})`);
    }
    await page.waitForTimeout(100);
  }
}

/** A deadline-bounded poll on a plain condition (a delivery call, a store read). */
async function waitUntil(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

interface Cockpit {
  home: string;
  store: StateStore;
  streams: StreamService;
  questions: QuestionService;
  gates: GateService;
  rules: RulesService;
  /** Every `deliver(sessionId, question)` the question service made — the hand-off to the asking session. */
  delivered: Array<{ session: string; question: Question }>;
  http: HttpServerHandle;
  base: string;
  stop(): Promise<void>;
}

/**
 * A fresh temp home with the real services and the real HTTP + `/ws`
 * server over it, the way `startDaemon` wires them (`daemon.ts`), minus
 * the RPC socket and the vendor runner this suite never uses.
 */
async function startCockpit(): Promise<Cockpit> {
  const home = mkdtempSync(join(tmpdir(), 'agile-cockpit-e2e-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  const streams = new StreamService(store);
  const delivered: Cockpit['delivered'] = [];
  const questions = new QuestionService(store, streams, {
    deliver: async (session, question) => {
      delivered.push({ session, question });
    },
  });
  const gates = new GateService(store);
  const rules = new RulesService({ store, streams });
  const inbox = new InboxService({ streams, questions, gates, rules });
  const http = startHttpServer({
    port: 0,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    store,
    gates,
    streams,
    questions,
    inbox,
    rules,
    feedPollIntervalMs: 50,
  });
  return {
    home,
    store,
    streams,
    questions,
    gates,
    rules,
    delivered,
    http,
    base: `http://127.0.0.1:${http.port}`,
    async stop() {
      await http.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('cockpit shell (Playwright e2e)', () => {
  browserTest(
    'an agent question on a nested stream appears without reload, the answer reaches the session, and the dot changes',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const root = await cockpit.streams.create('human', {
          title: 'ledger-lite',
          goal: 'a small ledger',
        });
        const mid = await cockpit.streams.create('human', {
          title: 'import CSV',
          goal: 'import bank exports',
          parent: root.id,
        });
        const leaf = await cockpit.streams.create('human', {
          title: 'parser',
          goal: 'parse the dialects',
          parent: mid.id,
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);

        // The inbox is the default view, and it is calmly empty.
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
        // The tree nests all three, and the leaf is idle (grey).
        const leafRow = `[data-testid="stream-tree"] [data-stream="${leaf.id}"]`;
        await page.locator(leafRow).waitFor({ state: 'visible' });
        expect(await page.locator(`${leafRow} .title`).textContent()).toBe('parser');
        expect(
          await page.locator(`[data-stream="${mid.id}"] + ul [data-stream="${leaf.id}"]`).count(),
        ).toBe(1);
        await waitForAttr(page, `${leafRow} .cr-dot`, 'data-dot', 'grey');

        // The agent asks — through the service, the path the MCP `ask` verb
        // takes — while the page is open. No reload from here on.
        const session = ulid();
        const question = await cockpit.questions.raise({
          stream: leaf.id,
          raised_by: 'eng-1',
          session,
          text: 'comma or semicolon for the CSV dialect?',
        });

        const card = `[data-id="${question.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        // Grouped under the stream's full path (§3.2).
        expect(await page.locator(`.cr-group[data-stream="${leaf.id}"] h2`).textContent()).toBe(
          'ledger-lite / import CSV / parser',
        );
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'comma or semicolon',
        );
        await waitForText(page, '[data-testid="inbox-badge"]', '1');
        // The dot says it is the operator's move.
        await waitForAttr(page, `${leafRow} .cr-dot`, 'data-dot', 'amber');

        // Answered inline, in the operator's own words.
        await page
          .locator(`${card} [data-testid="answer-input"]`)
          .fill('semicolon — the export uses it');
        await page.locator(`${card} [data-testid="answer-send"]`).click();

        // The answer reaches the asking session, verbatim.
        await waitUntil('the answer to be delivered', () => cockpit.delivered.length > 0);
        expect(cockpit.delivered[0]?.session).toBe(session);
        expect(cockpit.delivered[0]?.question.id).toBe(question.id);
        expect(cockpit.delivered[0]?.question.answer).toBe('semicolon — the export uses it');
        const answer = cockpit.streams
          .readThread(leaf.id)
          .entries.find((entry) => entry.kind === 'answer');
        expect(answer?.by).toBe('human');

        // The card goes, the inbox is empty again, and the dot moves off amber.
        await page.locator(card).waitFor({ state: 'detached' });
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
        await waitForAttr(page, `${leafRow} .cr-dot`, 'data-dot', 'grey');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a routed call and a proposed rule are decided inline, and a stream in the tree opens its page',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const a = await cockpit.streams.create('human', { title: 'alpha', goal: 'a' });
        const b = await cockpit.streams.create('human', { title: 'beta', goal: 'b' });
        const gate = await cockpit.gates.request('classifier_review', {
          policy: cockpit.store.getPolicy(),
          stream: a.id,
          summary: 'editing a dependency manifest is never automatic',
          call: { tool: 'Edit', path: '/tmp/wt/package.json', fingerprint: '0123456789abcdef' },
        });
        const rule = await cockpit.rules.create('agent', {
          text: 'run the repo scripts, never a second toolchain',
          scope: { kind: 'stream', ref: b.id },
          provenance: { by: 'agent', stream: b.id },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-id="${gate.id}"]`).waitFor({ state: 'visible' });
        await page.locator(`[data-id="${rule.id}"]`).waitFor({ state: 'visible' });
        expect(
          await page.locator(`[data-id="${gate.id}"] [data-testid="inbox-context"]`).textContent(),
        ).toContain('package.json');

        // T161: picking beta opens its stream page, which carries only
        // beta's cards — the rule, not alpha's gate.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${b.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${b.id}"]`).waitFor();
        await page.locator(`[data-id="${gate.id}"]`).waitFor({ state: 'detached' });
        expect(
          await page.locator(`[data-testid="stream-needs"] [data-id="${rule.id}"]`).count(),
        ).toBe(1);

        await page.locator(`[data-id="${rule.id}"] [data-testid="rule-accept"]`).click();
        await page.locator(`[data-id="${rule.id}"]`).waitFor({ state: 'detached' });
        await waitUntil('the rule to be accepted', () => {
          const saved = cockpit.store.getRule(rule.id);
          return saved.status === 'accepted' && saved.decided_by === 'human';
        });

        // Back to every stream: allow the routed call with a reason.
        await page
          .locator('[data-testid="stream-tree"] .cr-tree-row', { hasText: 'All streams' })
          .click();
        const gateCard = `[data-id="${gate.id}"]`;
        await page.locator(`${gateCard} [data-testid="gate-note"]`).fill('pin it to 1.2.3');
        await page.locator(`${gateCard} [data-testid="gate-approve"]`).click();
        await page.locator(gateCard).waitFor({ state: 'detached' });
        const decided = cockpit.gates.get(gate.id);
        expect(decided.status).not.toBe('pending');
        expect(decided.note).toBe('pin it to 1.2.3');
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'phone width: no horizontal scroll, the tree is a drawer, a card is answerable',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const root = await cockpit.streams.create('human', {
          title: 'a stream with a rather long title that must not push the page sideways',
          goal: 'g',
        });
        const question = await cockpit.questions.raise({
          stream: root.id,
          raised_by: 'eng-1',
          text: 'which branch should this land on?',
        });

        page = await openPage();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${cockpit.base}/`);
        const card = `[data-id="${question.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });

        // The drawer is closed: the inbox has the whole width.
        expect(await page.locator('[data-testid="stream-tree"]').isVisible()).toBe(false);
        const overflow = (await page.evaluate(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        )) as number;
        expect(overflow).toBeLessThanOrEqual(0);
        const box = await page.locator(card).boundingBox();
        expect(box).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);

        // The top bar opens the tree; picking a stream closes it again and
        // opens its page (T161), which fits the phone width too.
        await page.locator('[data-testid="rail-toggle"]').click();
        await page.locator('[data-testid="stream-tree"]').waitFor({ state: 'visible' });
        await page.locator(`[data-testid="stream-tree"] [data-stream="${root.id}"]`).click();
        await page.locator('[data-testid="stream-tree"]').waitFor({ state: 'hidden' });
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        const pageOverflow = (await page.evaluate(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        )) as number;
        expect(pageOverflow).toBeLessThanOrEqual(0);

        await page.locator(`${card} [data-testid="answer-input"]`).fill('main');
        await page.locator(`${card} [data-testid="answer-send"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        await page.locator('[data-view="inbox"]').click();
        await waitForCount(page, '[data-testid="inbox-empty"]', 1);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T161: the stream page (design/cockpit-design.md §9.3) ---------------

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

interface StreamCockpit {
  home: string;
  repo: string;
  scratch: string;
  store: StateStore;
  streams: StreamService;
  questions: QuestionService;
  rules: RulesService;
  verbs: VerbService;
  attach: AttachService;
  base: string;
  stop(): Promise<void>;
}

/**
 * The whole stream-page stack, wired the way `daemon.ts` wires it — attach,
 * questions (delivering an answer by prompting the live session), verbs,
 * docs, landing — over a real temp home and a real git repo. The one
 * substitution is the transport: every session is `fake-agent.ts` over
 * real ACP, the Nth attach running `scripts[N]`.
 */
async function startStreamCockpit(scripts: FakeAgentScript[]): Promise<StreamCockpit> {
  const home = mkdtempSync(join(tmpdir(), 'agile-stream-e2e-'));
  const scratch = mkdtempSync(join(tmpdir(), 'agile-stream-e2e-scratch-'));
  const repo = mkdtempSync(join(tmpdir(), 'agile-stream-e2e-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);

  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  await store.putRepos({ demo: { path: repo, protected_branches: [] } });
  const streams = new StreamService(store);
  const gates = new GateService(store);
  const rules = new RulesService({ store, streams });
  const docs = new DocsService(store, streams, init.stateRoot);
  const questions = new QuestionService(store, streams, {
    deliver: async (session, question) => {
      // Read lazily, exactly as `daemon.ts` does: built just below.
      await attach.deliverAnswer(session, question);
    },
  });
  let spawned = 0;
  const providers: AcpProviderConfig[] = scripts.map((script, i) => {
    const path = join(scratch, `script-${i}.json`);
    writeFileSync(path, JSON.stringify(script));
    return {
      ...ACP_PROVIDERS.claude,
      command: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { AGILE_FAKE_AGENT_SCRIPT: path },
    };
  });
  const attach = new AttachService({
    store,
    streams,
    home,
    provider: (_vendor, fallback) => providers[spawned++] ?? fallback,
    docs,
    rules,
    questions: { listOpen: () => questions.listOpen() },
    gates: { list: () => gates.list() },
  });
  const verbs = new VerbService({ store, streams, questions, docs, rules });
  const landing = new LandingService({ store, streams, gates });
  const inbox = new InboxService({ streams, questions, gates, rules });
  const http = startHttpServer({
    port: 0,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    store,
    gates,
    streams,
    questions,
    inbox,
    rules,
    landing,
    attach,
    docs,
    feedPollIntervalMs: 50,
  });
  return {
    home,
    repo,
    scratch,
    store,
    streams,
    questions,
    rules,
    verbs,
    attach,
    base: `http://127.0.0.1:${http.port}`,
    async stop() {
      await attach.stopAll();
      await http.stop();
      await store.flush();
      store.close();
      for (const dir of [home, repo, scratch]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A question well past the inbox's 200-char clip, with a tail only the full text carries. */
const LONG_QUESTION = `The export files mix two conventions: ${'some rows quote every field and use a comma, others quote nothing and use a semicolon; '.repeat(
  3,
)}which delimiter should the parser treat as canonical — TAIL-MARKER-7?`;

describe('stream page (Playwright e2e, T161)', () => {
  browserTest(
    'attach → question → answer → findings → land on one stream, with the fake transport',
    async () => {
      const asked = join(tmpdir(), `agile-stream-e2e-asked-${ulid()}`);
      const reviewed = join(tmpdir(), `agile-stream-e2e-reviewed-${ulid()}`);
      const promptLog = join(tmpdir(), `agile-stream-e2e-prompts-${ulid()}.jsonl`);
      const worker: FakeAgentScript = {
        logFile: promptLog,
        turns: [
          [
            { type: 'agent_text', text: 'reading **the parser** now' },
            { type: 'tool_call', toolCallId: 'read-1', title: 'read parser.ts' },
            { type: 'wait_for_file', path: asked, timeoutMs: 60_000 },
            { type: 'end_turn' },
          ],
          // The composer's line, queued behind the first turn.
          [{ type: 'agent_text', text: 'noted: RFC 4180 quoting' }, { type: 'end_turn' }],
          // The answer.
          [{ type: 'agent_text', text: 'continuing with semicolon' }, { type: 'end_turn' }],
        ],
        steps: [{ type: 'end_turn' }],
      };
      const reviewer: FakeAgentScript = {
        steps: [
          { type: 'agent_text', text: 'reviewing the diff' },
          { type: 'tool_call', toolCallId: 'review-1', title: 'read the diff' },
          { type: 'wait_for_file', path: reviewed, timeoutMs: 60_000 },
          { type: 'end_turn' },
        ],
      };
      const cockpit = await startStreamCockpit([worker, reviewer]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'CSV parser',
          goal: 'Pick the **dialect** and implement it.',
          repo: 'demo',
        });
        const rule = await cockpit.rules.create('human', {
          text: 'run the repo scripts, never a second toolchain',
          scope: { kind: 'stream', ref: stream.id },
        });
        await cockpit.rules.accept(rule.id, 'human');
        mkdirSync(join(cockpit.home, 'streams', `${stream.id}.docs`), { recursive: true });
        writeFileSync(
          join(cockpit.home, 'streams', `${stream.id}.docs`, 'dialects.md'),
          '# Dialects\n\nSemicolons in the EU exports.\n',
        );

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        const root = `[data-testid="stream-page"][data-stream="${stream.id}"]`;
        await page.locator(root).waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="stream-title"]').textContent()).toBe('CSV parser');

        // Rules in scope and docs, one click each.
        await page.locator('.cr-tabs [data-tab="rules"]').click();
        await page.locator(`[data-testid="rule"][data-rule="${rule.id}"]`).waitFor();
        await page.locator('.cr-tabs [data-tab="docs"]').click();
        await page.locator('[data-testid="doc"]', { hasText: 'dialects.md' }).waitFor();
        await page.locator('.cr-tabs [data-tab="thread"]').click();

        // ---- attach: the worker speaks onto the thread, live.
        await page.locator('[data-testid="attach"]').click();
        await page
          .locator('[data-testid="session"][data-role="worker"][data-status="running"]')
          .waitFor();
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', {
            hasText: 'reading the parser',
          })
          .waitFor();
        // Markdown, not raw asterisks.
        expect(
          await page
            .locator('[data-testid="thread-entry"][data-by="agent"] strong', {
              hasText: 'the parser',
            })
            .count(),
        ).toBe(1);
        // Mid-turn: the thinking indicator is on.
        await page.locator('[data-testid="thinking"]').waitFor({ state: 'visible' });

        // ---- the composer: a human line, and a prompt to the worker.
        await page.locator('[data-testid="composer-input"]').fill('use RFC 4180 quoting');
        await page.locator('[data-testid="composer-send"]').click();
        await page
          .locator('[data-testid="thread-entry"][data-by="human"]', {
            hasText: 'use RFC 4180 quoting',
          })
          .waitFor();

        // ---- question: the worker asks through the `ask` verb, then ends its turn.
        const session = cockpit.streams.get(stream.id).sessions.find((s) => s.role === 'worker');
        expect(session).toBeDefined();
        await waitUntil('the worker to register', () =>
          cockpit.store.listAgents().some((a) => a.id === session?.id),
        );
        const { id: questionId } = await cockpit.verbs.ask({
          session: session?.id,
          text: LONG_QUESTION,
        });
        writeFileSync(asked, '');
        // The stream page shows the question whole — the tail the inbox clips.
        const card = `[data-testid="stream-needs"] [data-id="${questionId}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'TAIL-MARKER-7',
        );
        // The composer's line was prompted into the worker (its queued turn ran).
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'noted: RFC 4180 quoting' })
          .waitFor();
        expect(readFileSync(promptLog, 'utf8')).toContain('use RFC 4180 quoting');

        // The worker's work, committed in its worktree.
        const worktree = cockpit.streams.get(stream.id).worktree ?? '';
        writeFileSync(join(worktree, 'parser.ts'), 'export const DELIMITER = ";";\n');
        git(['add', 'parser.ts'], worktree);
        git(['commit', '-q', '-m', 'semicolon parser'], worktree);

        // ---- answer, on the stream page.
        await page.locator(`${card} [data-testid="answer-input"]`).fill('semicolon');
        await page.locator(`${card} [data-testid="answer-send"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'continuing with semicolon' })
          .waitFor();
        await waitUntil(
          'the worker to finish',
          () => cockpit.streams.get(stream.id).agent.status === 'done',
        );
        await page.locator('[data-testid="stream-status"]', { hasText: 'agent done' }).waitFor();
        await page.locator('[data-testid="thinking"]').waitFor({ state: 'detached' });

        // The diff tab: the worktree against main.
        await page.locator('.cr-tabs [data-tab="diff"]').click();
        await page.locator('[data-testid="diff"]', { hasText: 'parser.ts' }).waitFor();
        expect(
          await page
            .locator('[data-testid="diff"] [data-line="add"]', { hasText: 'DELIMITER' })
            .count(),
        ).toBe(1);
        await page.locator('.cr-tabs [data-tab="thread"]').click();

        // ---- findings: Review attaches a reviewer, which reports one.
        await page.locator('[data-testid="review"]').click();
        await page.locator('[data-testid="session"][data-role="reviewer"]').waitFor();
        await waitUntil('the reviewer to register', () => {
          const reviewerSession = cockpit.streams
            .get(stream.id)
            .sessions.find((s) => s.role === 'reviewer');
          return cockpit.store.listAgents().some((a) => a.id === reviewerSession?.id);
        });
        const reviewerId = cockpit.streams
          .get(stream.id)
          .sessions.find((s) => s.role === 'reviewer')?.id;
        await cockpit.verbs.finding({
          session: reviewerId,
          severity: 'minor',
          file: 'parser.ts',
          line: 1,
          text: 'export the delimiter as a named constant type',
        });
        writeFileSync(reviewed, '');
        await page.locator('[data-testid="finding"][data-severity="minor"]').waitFor();
        expect(await page.locator('[data-testid="finding"]').textContent()).toContain(
          'parser.ts:1',
        );
        await page.locator('[data-testid="thread-entry"][data-kind="finding"]').waitFor();
        await waitUntil('the reviewer to stop', () =>
          cockpit.streams
            .get(stream.id)
            .sessions.every((s) => s.status === 'stopped' || s.status === 'error'),
        );

        // ---- land: first refused (a dirty main), the reason on the page…
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'yes');
        writeFileSync(join(cockpit.repo, 'README.md'), '# edited by the operator\n');
        await page.locator('[data-testid="stream-land"]').click();
        const result = page.locator('[data-testid="land-result"]');
        await result.waitFor({ state: 'visible' });
        expect(await result.getAttribute('data-status')).toBe('refused');
        expect(await result.textContent()).toContain('uncommitted changes');
        expect(cockpit.streams.get(stream.id).human.status).toBe('open');

        // …then landed once main is clean again.
        git(['checkout', '--', 'README.md'], cockpit.repo);
        await page.locator('[data-testid="stream-land"]').click();
        await waitForAttr(page, '[data-testid="land-result"]', 'data-status', 'landed');
        expect(cockpit.streams.get(stream.id).human.status).toBe('landed');
        expect(existsSync(join(cockpit.repo, 'parser.ts'))).toBe(true);
        await page.locator('[data-testid="stream-status"]', { hasText: 'you landed' }).waitFor();
        await waitForAttr(
          page,
          `[data-testid="stream-tree"] [data-stream="${stream.id}"] .cr-dot`,
          'data-dot',
          'green',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
        for (const path of [asked, reviewed, promptLog]) rmSync(path, { force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a question over 200 chars is readable in full: the card expands in place, and its stream page shows it whole',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'import', goal: 'g' });
        const question = await cockpit.questions.raise({
          stream: stream.id,
          raised_by: 'eng-1',
          text: LONG_QUESTION,
        });
        expect(LONG_QUESTION.length).toBeGreaterThan(200);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-id="${question.id}"]`;
        const context = page.locator(`${card} [data-testid="inbox-context"]`);
        await context.waitFor({ state: 'visible' });
        // Clipped in the list…
        expect(await context.textContent()).not.toContain('TAIL-MARKER-7');
        expect((await context.textContent())?.trim().endsWith('…')).toBe(true);
        // …expanded in place, still in the list…
        await page.locator(`${card} [data-testid="card-expand"]`).click();
        await waitForText(page, `${card} [data-testid="inbox-context"]`, LONG_QUESTION);
        await page.locator(`${card} [data-testid="card-expand"]`).click();
        expect(await context.textContent()).not.toContain('TAIL-MARKER-7');

        // …and whole on the stream page the card opens.
        await page.locator(`${card} [data-testid="open-stream"]`).click();
        const full = `[data-testid="stream-needs"] [data-id="${question.id}"] [data-testid="inbox-context"]`;
        await waitForText(page, full, LONG_QUESTION);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});
