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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type Question,
  type KnowledgeItem as Rule,
  classifierQuestion,
  examplesOf,
  patternOf,
  ulid,
  validateClassifierConfig,
} from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { AttachService, VerbService } from '../attach';
import { ClassifierKeyService, FakeClassifier } from '../classifier';
import { AutonomyService } from '../coordination/autonomy';
import { CardService } from '../coordination/cards';
import { ContractService } from '../coordination/contracts';
import { PlanService } from '../coordination/plans';
import { DeliveryService } from '../delivery';
import { DirectorService } from '../director';
import { DocsService } from '../docs';
import { RoutedEventService, routeAndEmit } from '../events';
import { GateService } from '../gates';
import { type HttpServerHandle, startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { KnowledgeService, type RuleRpcEvalDeps } from '../knowledge';

/** Proposals the home migration carried over from a seed import are batched under this source. */
const SEED_PROVENANCE = 'migration';
import { ProjectService } from '../projects';
import { QuestionService } from '../questions';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { RepoInPlaceService, StreamService } from '../streams';
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
async function openPage(options?: {
  colorScheme?: 'dark' | 'light';
  serviceWorkers?: 'block';
}): Promise<Page> {
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
/**
 * Waits for a worker session the page shows as `running`. On a timeout it
 * throws with what explains the miss: the stream's sessions as the API
 * serves them, the session strip as rendered, the thread's daemon events,
 * each session's stderr.log, and the page's recent API and socket traffic.
 */
async function waitForRunningWorker(
  page: Page,
  cockpit: { base: string; home: string; attachErrors?: string[] },
  streamId: string,
  traffic: string[],
): Promise<void> {
  try {
    await page
      .locator('[data-testid="session"][data-role="worker"][data-status="running"]')
      .waitFor();
  } catch (err) {
    type PagePayload = {
      stream: {
        sessions: Array<{ id: string }>;
        worktree?: string;
        branch?: string;
        agent: unknown;
      };
      thread: Array<{ by: string; body: string }>;
    };
    const api = await fetch(`${cockpit.base}/api/streams/${streamId}`)
      .then((res) => res.json() as Promise<PagePayload>)
      .catch(() => undefined);
    const strip = await page
      .locator('[data-testid="sessions"]')
      .evaluateAll((els) => els.map((el) => el.outerHTML))
      .catch((e: unknown) => [`(unreadable: ${String(e)})`]);
    const alerts = await page
      .locator('[role="alert"]')
      .allTextContents()
      .catch(() => []);
    const stderr = (api?.stream.sessions ?? []).map((s) => {
      try {
        const log = readFileSync(join(cockpit.home, 'sessions', s.id, 'stderr.log'), 'utf8');
        return `${s.id}:\n${log.slice(-2000)}`;
      } catch {
        return `${s.id}: (no stderr.log)`;
      }
    });
    throw new Error(
      [
        String(err),
        `api sessions: ${JSON.stringify(api?.stream.sessions)}`,
        `stream: ${JSON.stringify({ worktree: api?.stream.worktree, branch: api?.stream.branch, agent: api?.stream.agent })}`,
        `attach errors: ${(cockpit.attachErrors ?? []).join('\n---\n') || 'none'}`,
        `thread (daemon): ${JSON.stringify(api?.thread.filter((e) => e.by === 'daemon').map((e) => e.body))}`,
        `session strip: ${strip.join('\n')}`,
        `alerts: ${JSON.stringify(alerts)}`,
        `stderr:\n${stderr.join('\n')}`,
        `traffic (last 40):\n${traffic.slice(-40).join('\n')}`,
      ].join('\n'),
    );
  }
}

/** Records the page's API and socket traffic and console errors, for {@link waitForRunningWorker}. */
function recordTraffic(page: Page): string[] {
  const log: string[] = [];
  const t0 = Date.now();
  const at = (): string => `+${Date.now() - t0}ms`;
  const path = (url: string): string => new URL(url).pathname;
  page.on('request', (r) => {
    if (r.url().includes('/api/')) log.push(`${at()} > ${r.method()} ${path(r.url())}`);
  });
  page.on('response', (r) => {
    if (!r.url().includes('/api/')) return;
    const line = `${at()} < ${r.status()} ${path(r.url())}`;
    if (r.status() < 400) {
      log.push(line);
      return;
    }
    // The refusal's reason is the whole point of a failing call.
    const index = log.push(line) - 1;
    void r
      .text()
      .then((body) => {
        log[index] = `${line} ${body.slice(0, 500)}`;
      })
      .catch(() => {});
  });
  page.on('requestfailed', (r) => log.push(`${at()} x ${r.url()} ${r.failure()?.errorText}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      log.push(`${at()} console.${m.type()}: ${m.text()}`);
    }
  });
  page.on('websocket', (ws) => {
    log.push(`${at()} ws open ${path(ws.url())}`);
    ws.on('close', () => log.push(`${at()} ws close`));
    ws.on('framereceived', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : '';
      log.push(`${at()} ws < ${text.slice(0, 60)}`);
    });
  });
  return log;
}

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

/** T167: `waitUntil` for a condition that needs the page (an async read). */
async function waitUntilAsync(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

interface Cockpit {
  home: string;
  store: StateStore;
  streams: StreamService;
  projects: ProjectService;
  questions: QuestionService;
  gates: GateService;
  rules: KnowledgeService;
  events: RoutedEventService;
  plans: PlanService;
  contracts: ContractService;
  autonomy: AutonomyService;
  director: DirectorService;
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
async function startCockpit(
  extra: {
    ruleEvals?: RuleRpcEvalDeps;
    classifierKey?: boolean;
    githubAuth?: () => Promise<boolean>;
  } = {},
): Promise<Cockpit> {
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
  const rules = new KnowledgeService({ store, streams });
  const contracts = new ContractService({ store, streams });
  const plans = new PlanService({ store, streams, contracts });
  const autonomy = new AutonomyService({ store, streams, plans, contracts });
  const inbox = new InboxService({
    streams,
    questions,
    gates,
    rules,
    plans,
    contracts,
    proposals: autonomy,
  });
  const projects = new ProjectService(store, streams);
  const events = new RoutedEventService(store);
  // T300: no delivery wired, so a line to the Director stays pending (no session).
  const director = new DirectorService({ store, streams, events, home });
  const http = startHttpServer({
    port: 0,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    store,
    gates,
    streams,
    projects,
    events,
    director,
    questions,
    inbox,
    rules,
    plans,
    contracts,
    autonomy,
    ...(extra.ruleEvals ? { ruleEvals: extra.ruleEvals } : {}),
    // T167: a key service over a fresh config and no env, so the operator's
    // own TYPESAFE_API_KEY never counts and no real call is possible.
    ...(extra.classifierKey
      ? {
          classifierKey: new ClassifierKeyService({
            config: validateClassifierConfig({}),
            store,
            env: {},
          }),
        }
      : {}),
    // T222: the pr refusal's auth seam; never a real `gh`.
    ...(extra.githubAuth ? { githubAuth: extra.githubAuth } : {}),
    feedPollIntervalMs: 50,
  });
  return {
    home,
    store,
    streams,
    projects,
    questions,
    gates,
    rules,
    events,
    plans,
    contracts,
    autonomy,
    director,
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
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
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
          scope: { kind: 'subtree', node: b.id },
          source: { by: 'agent', node: b.id },
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
          const saved = cockpit.store.getKnowledge(rule.id);
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
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
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

// ---- T163: the rules screen (design/cockpit-design.md §5, §9) ----------

describe('rules screen (Playwright e2e, T163)', () => {
  browserTest(
    'seeded proposals are one inbox card that opens the filtered list; bulk retire; an accepted rule reaches the stream page',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'parser', goal: 'g' });
        const seeded: Rule[] = [];
        for (const text of ['schemas are strict', 'hooks enforce', 'one event per write']) {
          seeded.push(
            await cockpit.rules.create('human', { text, source: { by: SEED_PROVENANCE } }),
          );
        }
        const lesson = await cockpit.rules.create('agent', {
          text: 'run the repo scripts, never a second toolchain',
          scope: { kind: 'subtree', node: stream.id },
          source: { by: 'agent', node: stream.id },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        // One card for the seed import, one for the lesson.
        const batch = `[data-kind="rule_batch"][data-id="${SEED_PROVENANCE}"]`;
        await page.locator(batch).waitFor({ state: 'visible' });
        await page.locator(`[data-kind="rule_accept"][data-id="${lesson.id}"]`).waitFor();
        expect(await page.locator('[data-kind="rule_accept"]').count()).toBe(1);
        expect(
          await page.locator(`${batch} [data-testid="inbox-context"]`).textContent(),
        ).toContain(`3 proposed rules from ${SEED_PROVENANCE}`);

        // The card opens the rules screen, filtered to exactly those three.
        await page.locator(`${batch} [data-testid="rule-batch-open"]`).click();
        await page.locator('[data-testid="rules-screen"]').waitFor();
        await page.locator('[data-testid="rules-filter-source"]').waitFor();
        await waitForCount(page, '[data-testid="rules-row"]', 3);
        expect(await page.locator('[data-testid="rules-row"]').count()).toBe(3);
        expect(
          await page.locator(`[data-testid="rules-row"][data-rule="${lesson.id}"]`).count(),
        ).toBe(0);

        // Select all three and retire them in one go.
        await page.locator('[data-testid="rules-select-all"]').check();
        await page.locator('[data-testid="rules-bulk-retire"]').click();
        await waitUntil('the seeded rules to be retired', () =>
          seeded.every((r) => {
            const saved = cockpit.store.getKnowledge(r.id);
            return saved.status === 'retired' && saved.decided_by === 'human';
          }),
        );
        // Filtered to proposed, the list is now empty.
        await page.locator('[data-testid="rules-empty"]').waitFor();

        // Clear the source filter and show every status: the lesson is
        // there, and the retired three are too. Accept the lesson here.
        await page.locator('[data-testid="rules-filter-source"] button').click();
        await page.locator('[data-testid="rules-filter-status"]').selectOption('all');
        await waitForCount(page, '[data-testid="rules-row"][data-status="retired"]', 3);
        const row = `[data-testid="rules-row"][data-rule="${lesson.id}"]`;
        await page.locator(`${row} [data-testid="rules-accept"]`).click();
        await waitForAttr(page, row, 'data-status', 'accepted', POLL_DEADLINE_MS);
        expect(cockpit.store.getKnowledge(lesson.id).decided_by).toBe('human');

        // The inbox is empty again, and the rule is in the stream's rules tab.
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await page.locator('.cr-tabs [data-tab="rules"]').click();
        await page.locator(`[data-testid="rule"][data-rule="${lesson.id}"]`).waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "edit a rule's question and criteria, then test its examples through the classifier",
    async () => {
      const classifier = new FakeClassifier((state, questions) =>
        questions.map((q) => ({
          id: q.id,
          probability: state.startsWith('bun add') ? 0.95 : state.startsWith('npm') ? 0.6 : 0.05,
        })),
      );
      const cockpit = await startCockpit({
        ruleEvals: {
          classifier,
          bands: {
            deny_at: DEFAULT_CLASSIFIER_DENY_AT,
            allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
          },
          timeout_ms: 2_000,
        },
      });
      let page: Page | undefined;
      try {
        const rule = await cockpit.rules.create('human', {
          text: 'do not add a dependency without asking',
          enforcement: 'action',
          check: {
            by: 'classifier',
            examples: [
              { action: 'bun add lodash', violates: true },
              { action: 'edit src/index.ts', violates: false },
            ],
          },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/?view=rules`);
        const row = `[data-testid="rules-row"][data-rule="${rule.id}"]`;
        await page.locator(row).waitFor();
        // A proposal is not evaluated: the button is there but disabled.
        expect(await page.locator(`${row} [data-testid="rules-test"]`).isDisabled()).toBe(true);

        await page.locator(`${row} [data-testid="rules-edit"]`).click();
        await page
          .locator(`${row} [data-testid="rules-edit-question"]`)
          .fill('Does this action add a package to the project?');
        await page
          .locator(`${row} [data-testid="rules-edit-criteria-true"]`)
          .fill('a package manager adds a dependency');
        await page
          .locator(`${row} [data-testid="rules-edit-criteria-false"]`)
          .fill('no dependency changes');
        await page.locator(`${row} [data-testid="rules-edit-add-example"]`).click();
        await page
          .locator(`${row} [data-testid="rules-edit-example"] input[aria-label="Example action"]`)
          .nth(2)
          .fill('npm install left-pad');
        await page.locator(`${row} [data-testid="rules-edit-save"]`).click();
        await page.locator(`${row} [data-testid="rules-editor"]`).waitFor({ state: 'detached' });
        const saved = cockpit.store.getKnowledge(rule.id);
        expect(classifierQuestion(saved)).toBe('Does this action add a package to the project?');
        expect(saved.check).toMatchObject({
          criteria: {
            true: 'a package manager adds a dependency',
            false: 'no dependency changes',
          },
        });
        expect(examplesOf(saved)).toHaveLength(3);
        await waitForText(
          page,
          `${row} [data-testid="rules-question"]`,
          'Q: Does this action add a package to the project?',
        );

        await page.locator(`${row} [data-testid="rules-accept"]`).click();
        await waitForAttr(page, row, 'data-status', 'accepted', POLL_DEADLINE_MS);
        await page.locator(`${row} [data-testid="rules-test"]`).click();
        await waitForCount(page, `${row} [data-testid="rules-eval"]`, 3);
        const bands = await page
          .locator(`${row} [data-testid="rules-eval"]`)
          .evaluateAll((els) =>
            els.map((el) => [el.getAttribute('data-band'), el.getAttribute('data-agree')]),
          );
        expect(bands).toEqual([
          ['deny', 'yes'],
          ['allow', 'yes'],
          ['route', 'no'],
        ]);
        expect(await page.locator(`${row} [data-testid="rules-evals"]`).textContent()).toContain(
          '2/3 agree',
        );
        // The classifier was asked the edited question, with the criteria.
        const asked = classifier.calls.at(-1)?.questions[0];
        expect(JSON.stringify(asked)).toContain('add a package to the project');
        expect(JSON.stringify(asked)).toContain('no dependency changes');
        // No confidence anywhere on the page (D14).
        expect(
          (await page.locator('[data-testid="rules-screen"]').textContent())?.toLowerCase(),
        ).not.toContain('confidence');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('rules screen: patterns, new rule, cancel, classifier key (Playwright e2e, T167)', () => {
  browserTest(
    'a pattern is shown; New rule creates a proposal; edit then Cancel or Esc changes nothing',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const rule = await cockpit.rules.create('human', {
          text: 'never wipe the tree',
          enforcement: 'action',
          check: {
            by: 'pattern',
            pattern: { kind: 'command_deny', args: { patterns: ['rm -rf', 'git reset --hard'] } },
          },
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=rules`);
        const row = `[data-testid="rules-row"][data-rule="${rule.id}"]`;
        await waitForText(
          page,
          `${row} [data-testid="rules-pattern"]`,
          'command_deny: "rm -rf", "git reset --hard"',
        );

        // Edit, change everything, Cancel: nothing is sent, the editor closes.
        const before = JSON.stringify(cockpit.store.getKnowledge(rule.id));
        await page.locator(`${row} [data-testid="rules-edit"]`).click();
        await page.locator(`${row} [data-testid="rules-edit-text"]`).fill('changed text');
        await page
          .locator(`${row} [data-testid="rules-edit-pattern-kind"]`)
          .selectOption('no_push');
        await page.locator(`${row} [data-testid="rules-edit-cancel"]`).click();
        await page.locator(`${row} [data-testid="rules-editor"]`).waitFor({ state: 'detached' });
        // Reopened, the draft is the saved rule again, not the discarded one.
        await page.locator(`${row} [data-testid="rules-edit"]`).click();
        expect(await page.locator(`${row} [data-testid="rules-edit-text"]`).inputValue()).toBe(
          'never wipe the tree',
        );
        await page.locator(`${row} [data-testid="rules-edit-text"]`).fill('changed by esc');
        await page.locator(`${row} [data-testid="rules-edit-text"]`).press('Escape');
        await page.locator(`${row} [data-testid="rules-editor"]`).waitFor({ state: 'detached' });
        expect(JSON.stringify(cockpit.store.getKnowledge(rule.id))).toBe(before);

        // Editing the pattern's arguments does save.
        await page.locator(`${row} [data-testid="rules-edit"]`).click();
        await page
          .locator(`${row} [data-testid="rules-edit-pattern-args"]`)
          .fill('rm -rf\ngit clean -fdx');
        await page.locator(`${row} [data-testid="rules-edit-save"]`).click();
        await page.locator(`${row} [data-testid="rules-editor"]`).waitFor({ state: 'detached' });
        expect(patternOf(cockpit.store.getKnowledge(rule.id))).toEqual({
          kind: 'command_deny',
          args: { patterns: ['rm -rf', 'git clean -fdx'] },
        });

        // New rule: a pattern on a ship item is refused in the form (§14.3: action only).
        await page.locator('[data-testid="rules-new"]').click();
        const form = '[data-testid="rules-new-form"]';
        await page.locator(`${form} [data-testid="rules-edit-text"]`).fill('keep secrets out');
        await page.locator(`${form} [data-testid="rules-edit-enforcement"]`).selectOption('ship');
        await page
          .locator(`${form} [data-testid="rules-edit-pattern-kind"]`)
          .selectOption('path_deny');
        await page.locator(`${form} [data-testid="rules-edit-pattern-args"]`).fill('secrets/**');
        await page.locator(`${form} [data-testid="rules-edit-save"]`).click();
        await waitUntilAsync('the form to refuse a pattern on a ship item', async () =>
          page
            ? ((await page.locator(`${form} [role="alert"]`).textContent()) ?? '').includes(
                'a pattern check is an action check only',
              )
            : false,
        );
        await page.locator(`${form} [data-testid="rules-edit-enforcement"]`).selectOption('action');
        await page.locator(`${form} [data-testid="rules-edit-critical"]`).check();
        await page.locator(`${form} [data-testid="rules-edit-save"]`).click();
        await page.locator(form).waitFor({ state: 'detached' });
        await waitUntil('the new rule to be stored', () =>
          cockpit.store.listKnowledge().some((r) => r.text === 'keep secrets out'),
        );
        const created = cockpit.store.listKnowledge().find((r) => r.text === 'keep secrets out');
        expect(created?.status).toBe('proposed');
        expect(created?.source.by).toBe('human');
        expect(created?.critical).toBe(true);
        expect(created && patternOf(created)).toEqual({
          kind: 'path_deny',
          args: { globs: ['secrets/**'] },
        });
        await waitForText(
          page,
          `[data-testid="rules-row"][data-rule="${created?.id}"] [data-testid="rules-pattern"]`,
          'path_deny: "secrets/**"',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'Settings saves a classifier key write-only; Test examples follows it; Remove turns it off',
    async () => {
      const fakeKey = 'fake-t167-playwright-key-7788';
      const cockpit = await startCockpit({
        classifierKey: true,
        ruleEvals: {
          classifier: new FakeClassifier(),
          bands: {
            deny_at: DEFAULT_CLASSIFIER_DENY_AT,
            allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
          },
        },
      });
      let page: Page | undefined;
      try {
        const rule = await cockpit.rules.create('human', {
          text: 'no new deps',
          enforcement: 'action',
          check: {
            by: 'classifier',
            examples: [
              { action: 'bun add lodash', violates: true },
              { action: 'edit src/a.ts', violates: false },
            ],
          },
        });
        await cockpit.rules.accept(rule.id, 'human');
        const testButton = `[data-testid="rules-row"][data-rule="${rule.id}"] [data-testid="rules-test"]`;

        page = await openPage();
        await page.goto(`${cockpit.base}/?view=rules`);
        await page.locator(testButton).waitFor();
        expect(await page.locator(testButton).isDisabled()).toBe(true);

        await page.locator('[data-view="settings"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'no key');
        await page.locator('[data-testid="settings-key-input"]').fill(fakeKey);
        await page.locator('[data-testid="settings-key-save"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'key set (from config)');
        expect(await page.locator('[data-testid="settings-key-input"]').inputValue()).toBe('');
        expect(await page.content()).not.toContain(fakeKey);

        await page.locator('[data-view="rules"]').click();
        await page.locator(testButton).waitFor();
        await waitUntilAsync('Test examples to be enabled', async () =>
          page ? !(await page.locator(testButton).isDisabled()) : false,
        );

        await page.locator('[data-view="settings"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'key set (from config)');
        await page.locator('[data-testid="settings-key-remove"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'no key');
        await page.locator('[data-view="rules"]').click();
        await page.locator(testButton).waitFor();
        await waitUntilAsync('Test examples to be disabled', async () =>
          page ? await page.locator(testButton).isDisabled() : false,
        );
        expect(readFileSync(join(cockpit.home, 'log', 'events.jsonl'), 'utf8')).not.toContain(
          fakeKey,
        );
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
  rules: KnowledgeService;
  verbs: VerbService;
  attach: AttachService;
  /** Every attach that threw, with its stack: what a 400 from the attach route was. */
  attachErrors: string[];
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
  // T205: a second repo, for + Repo's second part (never checked out: parts cut on first attach).
  await store.putRepos({
    demo: { path: repo, protected_branches: [] },
    web: { path: repo, protected_branches: [] },
  });
  const streams = new StreamService(store);
  const gates = new GateService(store);
  const rules = new KnowledgeService({ store, streams });
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
  const attachErrors: string[] = [];
  const attachOnce = attach.attach.bind(attach);
  attach.attach = async (...args) => {
    try {
      return await attachOnce(...args);
    } catch (err) {
      attachErrors.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
      throw err;
    }
  };
  const verbs = new VerbService({ store, streams, questions, docs, rules });
  const landing = new DeliveryService({ store, streams, gates });
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
    repoInPlace: new RepoInPlaceService(store, streams, {
      attach: (id) => attach.attach(id),
      stop: (id) => attach.stop(id),
    }),
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
    attachErrors,
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
          scope: { kind: 'subtree', node: stream.id },
        });
        await cockpit.rules.accept(rule.id, 'human');
        mkdirSync(join(cockpit.home, 'streams', `${stream.id}.docs`), { recursive: true });
        writeFileSync(
          join(cockpit.home, 'streams', `${stream.id}.docs`, 'dialects.md'),
          '# Dialects\n\nSemicolons in the EU exports.\n',
        );

        page = await openPage();
        const traffic = recordTraffic(page);
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        const root = `[data-testid="stream-page"][data-stream="${stream.id}"]`;
        await page.locator(root).waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="stream-title"]').textContent()).toBe('CSV parser');

        // Knowledge in scope and docs, one click each.
        await page.locator('.cr-tabs [data-tab="rules"]').click();
        await page.locator(`[data-testid="rule"][data-rule="${rule.id}"]`).waitFor();
        await page.locator('.cr-tabs [data-tab="docs"]').click();
        await page.locator('[data-testid="doc"]', { hasText: 'dialects.md' }).waitFor();
        await page.locator('.cr-tabs [data-tab="thread"]').click();

        // ---- attach: the worker speaks onto the thread, live.
        // T170: Attach opens the picker, prefilled with the D17 built-in.
        await page.locator('[data-testid="attach"]').click();
        await page.locator('[data-testid="session-picker"][data-role="worker"]').waitFor();
        expect(await page.locator('[data-testid="picker-model"]').inputValue()).toBe(
          'claude-opus-5-5',
        );
        expect(await page.locator('[data-testid="picker-effort"]').inputValue()).toBe('low');
        await page.locator('[data-testid="picker-start"]').click();
        await waitForRunningWorker(page, cockpit, stream.id, traffic);
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
        // T174: sent mid-turn, so it is marked as waiting until delivered.
        const queuedMarker = page
          .locator('[data-testid="thread-entry"][data-by="human"]', {
            hasText: 'use RFC 4180 quoting',
          })
          .locator('[data-testid="thread-queued"]');
        await queuedMarker.waitFor({ state: 'visible' });
        expect(await queuedMarker.textContent()).toContain('queued');

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
        // T174: delivered, so no longer marked as waiting.
        await queuedMarker.waitFor({ state: 'detached' });

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
        await page.locator('[data-testid="session-picker"][data-role="reviewer"]').waitFor();
        await page.locator('[data-testid="picker-start"]').click();
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
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
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

describe('session defaults (Playwright e2e, T170)', () => {
  browserTest(
    'change the default in Settings, Attach, and the session strip shows the new model and effort',
    async () => {
      const cockpit = await startStreamCockpit([{ steps: [{ type: 'end_turn' }] }]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'defaults',
          goal: 'g',
          repo: 'demo',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        const home = (suffix: string) => `[data-testid="settings-session-home${suffix}"]`;
        const contains = async (selector: string, text: string) =>
          waitUntilAsync(`${selector} to contain ${text}`, async () =>
            ((await page?.locator(selector).first().textContent()) ?? '').includes(text),
          );
        // T164: a Global default row, then Per-repo defaults, one row per repo.
        await contains(home(''), 'Global default');
        await contains('[data-testid="settings-session-repos-heading"]', 'Per-repo defaults');
        await contains('[data-testid="settings-session-repo-demo"]', 'demo');
        await contains(
          '[data-testid="settings-session-repo-demo"]',
          'overrides the global default',
        );
        await contains('[data-testid="settings-session-repo-demo-resolved"]', 'Resolves to');
        await waitForText(page, home('-resolved'), 'Resolves to claude / claude-opus-5-5 / low');
        await page.locator(home('-field-model')).fill('claude-sonnet-4-6');
        await page.locator(home('-field-effort')).selectOption('high');
        await page.locator(home('-save')).click();
        await waitForText(
          page,
          home('-resolved'),
          'Resolves to claude / claude-sonnet-4-6 / high · saved',
        );
        expect(readFileSync(join(cockpit.home, 'config.yaml'), 'utf8')).toContain(
          'default_model: claude-sonnet-4-6',
        );

        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        // T164: Enter sends, Shift+Enter is a newline, an empty composer sends nothing.
        const composer = page.locator('[data-testid="composer-input"]');
        await composer.press('Enter');
        await composer.fill('first line');
        await composer.press('Shift+Enter');
        await composer.type('second line');
        expect(await composer.inputValue()).toBe('first line\nsecond line');
        await composer.press('Enter');
        await waitUntilAsync(
          'the Enter-sent line on the thread',
          async () => (await composer.inputValue()) === '',
        );
        const said = cockpit.streams
          .readThread(stream.id)
          .entries.filter((e) => e.by === 'human' && e.kind === 'line');
        expect(said.map((e) => e.body)).toEqual(['first line\nsecond line']);

        await page.locator('[data-testid="attach"]').click();
        await page.locator('[data-testid="session-picker"]').waitFor();
        await waitUntilAsync(
          'the picker to prefill',
          async () =>
            (await page?.locator('[data-testid="picker-model"]').inputValue()) ===
            'claude-sonnet-4-6',
        );
        expect(await page.locator('[data-testid="picker-effort"]').inputValue()).toBe('high');
        await page.locator('[data-testid="picker-start"]').click();
        await page
          .locator('[data-testid="session"][data-role="worker"]', {
            hasText: 'claude/claude-sonnet-4-6 · high',
          })
          .waitFor();
        expect(cockpit.streams.get(stream.id).sessions[0]).toMatchObject({
          model: 'claude-sonnet-4-6',
          effort: 'high',
        });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('stream page rough edges (Playwright e2e, T166)', () => {
  browserTest(
    'Needs you shows "nothing waiting on you"; a branch merged by hand is marked landed; Close closes as human',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        // A stream whose branch was merged into main outside `land`.
        const worktree = join(cockpit.repo, '.worktrees', 's-merged');
        git(['worktree', 'add', '-q', '-b', 's-merged', worktree, 'main'], cockpit.repo);
        writeFileSync(join(worktree, 'help.txt'), '--help\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'help'], worktree);
        git(['worktree', 'remove', worktree], cockpit.repo);
        git(['merge', '-q', '--no-ff', '-m', 'merge by hand', 's-merged'], cockpit.repo);
        const merged = await cockpit.streams.create('human', {
          title: 'help flag',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.update('daemon', merged.id, { branch: 's-merged' });
        const other = await cockpit.streams.create('human', { title: 'to close', goal: 'g' });

        // Cross-origin writes are rejected before anything changes.
        for (const action of ['close', 'mark-landed']) {
          const res = await fetch(`${cockpit.base}/api/streams/${other.id}/${action}`, {
            method: 'POST',
            headers: { origin: 'https://evil.example' },
          });
          expect(res.status).toBe(403);
        }
        expect(cockpit.streams.get(other.id).human.status).toBe('open');

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${merged.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${merged.id}"]`).waitFor();
        await page.locator('[data-testid="stream-needs-empty"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="stream-needs"] h2').textContent()).toBe(
          'Needs you',
        );
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'merged');
        expect(await page.locator('[data-testid="land-before"]').textContent()).toContain(
          'Already merged into main',
        );
        expect(await page.locator('[data-testid="stream-land"]').count()).toBe(0);
        await page.locator('[data-testid="stream-mark-landed"]').click();
        await page.locator('[data-testid="stream-status"]', { hasText: 'you landed' }).waitFor();
        expect(cockpit.streams.get(merged.id).human.status).toBe('landed');
        expect(await page.locator('[data-testid="stream-close"]').count()).toBe(0);

        // Close, on another stream.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${other.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${other.id}"]`).waitFor();
        await page.locator('[data-testid="stream-close"]').click();
        await page.locator('[data-testid="stream-status"]', { hasText: 'you closed' }).waitFor();
        expect(cockpit.streams.get(other.id).human.status).toBe('closed');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('nothing to deliver (Playwright e2e, T231)', () => {
  browserTest(
    'a deliver with no commits beyond main shows "nothing to deliver" on the Delivery line',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const worktree = join(cockpit.repo, '.worktrees', 's-empty');
        git(['worktree', 'add', '-q', '-b', 's-empty', worktree, 'main'], cockpit.repo);
        const stream = await cockpit.streams.create('human', {
          title: 'empty',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.update('daemon', stream.id, { branch: 's-empty', worktree });
        const res = await fetch(`${cockpit.base}/api/streams/${stream.id}/land`, {
          method: 'POST',
          headers: { origin: cockpit.base },
        });
        expect(res.ok).toBe(false);
        expect(cockpit.streams.get(stream.id).delivery_state?.status).toBe('not_started');

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await page
          .locator('[data-testid="delivery-state"]', {
            hasText: 'nothing to deliver: no commits beyond main',
          })
          .waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('parents and land conflicts (Playwright e2e, T176)', () => {
  browserTest(
    'attach on a parent starts straight away; a conflicted land shows the files, not "Ready"; Resolve then re-land',
    async () => {
      const quick: FakeAgentScript = { steps: [{ type: 'end_turn' }] };
      const cockpit = await startStreamCockpit([quick, quick]);
      let page: Page | undefined;
      try {
        const parent = await cockpit.streams.create('human', {
          title: 'Ledger features',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.create('human', { title: 'child', goal: 'g', parent: parent.id });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${parent.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${parent.id}"]`).waitFor();
        await page.locator('[data-testid="attach"]').click();
        await page.locator('[data-testid="picker-start"]').click();
        // D20: no parent-attach confirmation any more; the agent just starts,
        // as a coordinator (P20, T280).
        await page.locator('[data-testid="session"][data-role="coordinator"]').waitFor();

        // A stream whose branch and main both change shared.txt.
        const worktree = join(cockpit.repo, '.worktrees', 's-conflict');
        git(['worktree', 'add', '-q', '-b', 's-conflict', worktree, 'main'], cockpit.repo);
        writeFileSync(join(worktree, 'shared.txt'), 'from the stream\n');
        git(['add', 'shared.txt'], worktree);
        git(['commit', '-q', '-m', 'stream'], worktree);
        writeFileSync(join(cockpit.repo, 'shared.txt'), 'from main\n');
        git(['add', 'shared.txt'], cockpit.repo);
        git(['commit', '-q', '-m', 'main'], cockpit.repo);
        const stream = await cockpit.streams.create('human', {
          title: 'csv',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.update('daemon', stream.id, { branch: 's-conflict', worktree });

        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'yes');
        await page.locator('[data-testid="stream-land"]').click();
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'conflict');
        expect(await page.locator('[data-testid="land-conflict-file"]').allTextContents()).toEqual([
          'shared.txt',
        ]);
        expect(await page.locator('[data-testid="land-panel"]').textContent()).not.toContain(
          'Ready',
        );

        // Resolve: the picker, then a worker whose brief carries the instruction.
        await page.locator('[data-testid="stream-resolve"]').click();
        await page.locator('[data-testid="picker-start"]').click();
        await waitUntil('the resolve worker to finish', () => {
          const s = cockpit.streams.get(stream.id);
          return s.sessions.length === 1 && s.agent.status === 'done';
        });
        const session = cockpit.streams.get(stream.id).sessions[0]?.id as string;
        const brief = readFileSync(join(cockpit.home, 'sessions', session, 'brief.md'), 'utf8');
        expect(brief).toContain('git merge main');
        expect(brief).toContain('shared.txt');

        // What the worker would have done; then the operator lands again.
        Bun.spawnSync(['git', 'merge', 'main'], { cwd: worktree });
        writeFileSync(join(worktree, 'shared.txt'), 'from main\nfrom the stream\n');
        git(['commit', '-q', '-am', 'merge main'], worktree);
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'yes');
        await page.locator('[data-testid="stream-land"]').click();
        await waitForAttr(page, '[data-testid="land-result"]', 'data-status', 'landed');
        expect(cockpit.streams.get(stream.id).human.status).toBe('landed');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('a session that dies on a vendor error (Playwright e2e, T171)', () => {
  browserTest(
    "the sessions strip shows the vendor's error line",
    async () => {
      const cockpit = await startStreamCockpit([
        {
          stderrBanner: 'this model is not supported by this vendor build',
          validModes: ['nope'],
          steps: [{ type: 'end_turn' }],
        },
      ]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'dies', goal: 'g' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await cockpit.attach.attach(stream.id);
        await page
          .locator(
            '[data-testid="session"][data-status="error"] [data-testid="session-ended-reason"]',
            {
              hasText: 'this model is not supported by this vendor build',
            },
          )
          .waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('rule hits on the stream (Playwright e2e, T169)', () => {
  browserTest(
    'a rule_hit thread entry renders as a "blocked by rule" card that opens the rule on the Rules screen',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'build', goal: 'g' });
        const rule = await cockpit.rules.create('human', {
          text: 'never wipe build output',
          enforcement: 'action',
          check: {
            by: 'pattern',
            pattern: { kind: 'command_deny', args: { patterns: ['rm -rf'] } },
          },
        });
        await cockpit.rules.accept(rule.id, 'human');
        const other = await cockpit.rules.create('human', { text: 'an unrelated rule' });
        // Exactly the entry `HookService.noteHit` writes for a pattern deny.
        await cockpit.store.appendThreadEntry(stream.id, {
          ts: new Date().toISOString(),
          by: 'daemon',
          kind: 'event',
          body: `rule_hit: ${rule.id} denied \`rm -rf dist\` — rule: never wipe build output`,
          ref: rule.id,
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        const card = `[data-testid="thread-rule-hit"][data-rule="${rule.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        const text = (await page.locator(card).textContent()) ?? '';
        expect(text).toContain('blocked by rule');
        expect(text).toContain('rm -rf dist');

        await page.locator(`${card} [data-testid="thread-rule-link"]`).click();
        await page.locator('[data-testid="rules-screen"]').waitFor();
        await page.locator('[data-testid="rules-filter-rule"]').waitFor();
        await waitForCount(page, '[data-testid="rules-row"]', 1);
        await page.locator(`[data-testid="rules-row"][data-rule="${rule.id}"]`).waitFor();
        expect(
          await page.locator(`[data-testid="rules-row"][data-rule="${other.id}"]`).count(),
        ).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T266: the Knowledge screen -------------------------------------------

describe('the Knowledge screen (Playwright e2e, T266)', () => {
  browserTest(
    'a proposed decision reads "decision proposed", is accepted, and shows on the node\'s Knowledge-in-scope tab',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'ledger', goal: 'g' });
        const decision = await cockpit.rules.create('human', {
          kind: 'decision',
          text: 'money is stored as integer cents',
          scope: { kind: 'subtree', node: stream.id },
          paths: ['src/money/**'],
        });
        await cockpit.rules.create('human', { text: 'a global standard' });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-id="${decision.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} .kind`).textContent()).toContain('decision proposed');

        // The Knowledge screen filters by kind and enforcement.
        await page.locator('[data-view="rules"]').click();
        await page.locator('[data-testid="rules-screen"] h1', { hasText: 'Knowledge' }).waitFor();
        await waitForCount(page, '[data-testid="rules-row"]', 2);
        await page.locator('[data-testid="rules-filter-kind"]').selectOption('decision');
        await waitForCount(page, '[data-testid="rules-row"]', 1);
        const row = `[data-testid="rules-row"][data-rule="${decision.id}"]`;
        expect(await page.locator(`${row} [data-testid="rules-paths"]`).textContent()).toBe(
          'src/money/**',
        );
        await page.locator('[data-testid="rules-filter-enforcement"]').selectOption('action');
        await waitForCount(page, '[data-testid="rules-row"]', 0);
        await page.locator('[data-testid="rules-filter-enforcement"]').selectOption('all');

        await page.locator(`${row} [data-testid="rules-accept"]`).click();
        await waitUntil(
          'the decision to be accepted',
          () => cockpit.store.getKnowledge(decision.id).status === 'accepted',
        );

        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        const tab = page.locator('.cr-tabs [data-tab="rules"]');
        expect(await tab.textContent()).toContain('Knowledge in scope');
        await tab.click();
        await page.locator(`[data-testid="rule"][data-rule="${decision.id}"]`).waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T162: new stream, quick capture, `n` and `/` -------------------------

describe('new stream and quick capture (Playwright e2e, T162)', () => {
  browserTest(
    'quick capture turns one line into a stream with no repo and opens its page',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        // T208: the only project is where a capture on "All" files.
        const shop = await cockpit.projects.create({ name: 'shop' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });

        // Interaction one: type the line. Interaction two: Enter.
        await page.locator('[data-testid="quick-capture"]').fill('why is the nightly export slow?');
        await page.locator('[data-testid="quick-capture"]').press('Enter');

        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        await waitUntil('the stream to exist', () => cockpit.streams.list().length === 2);
        const created = cockpit.streams.list().find((s) => s.id !== shop.root);
        expect(created?.title).toBe('why is the nightly export slow?');
        expect(created?.repo).toBeUndefined();
        expect(created?.parent).toBe(shop.root);
        expect(created?.project).toBe(shop.id);
        const row = `[data-testid="stream-tree"] [data-stream="${created?.id}"]`;
        await page.locator(row).waitFor({ state: 'visible' });
        expect(await page.locator(row).getAttribute('aria-current')).toBe('true');
        expect(await page.locator('[data-testid="quick-capture"]').inputValue()).toBe('');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '`n` opens "New stream"; a stream created with a parent nests under it and its page opens',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const parent = await cockpit.streams.create('human', {
          title: 'ledger-lite',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${parent.id}"]`)
          .waitFor({ state: 'visible' });

        // `n` while typing does nothing: it is just a letter in the box.
        await page.locator('[data-testid="quick-capture"]').focus();
        await page.keyboard.press('n');
        expect(await page.locator('[data-testid="new-stream"]').count()).toBe(0);
        await page.locator('[data-testid="quick-capture"]').fill('');
        await page.locator('[data-testid="quick-capture"]').blur();

        await page.keyboard.press('n');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="new-stream-title"]').fill('import CSV');
        await page.locator('[data-testid="new-stream-parent"]').selectOption(parent.id);
        await page.locator('[data-testid="new-stream-create"]').click();

        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        await waitUntil('the child to exist', () => cockpit.streams.list().length === 3);
        const child = cockpit.streams.list().find((s) => s.parent === parent.id);
        expect(child?.title).toBe('import CSV');
        expect(child?.parent).toBe(parent.id);
        await page
          .locator(`[data-stream="${parent.id}"] + ul [data-stream="${child?.id}"]`)
          .waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '`/` focuses the tree filter, which keeps matches and their ancestors',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const root = await cockpit.streams.create('human', { title: 'ledger-lite', goal: 'g' });
        const leaf = await cockpit.streams.create('human', {
          title: 'parser',
          goal: 'g',
          parent: root.id,
        });
        const other = await cockpit.streams.create('human', { title: 'docs', goal: 'g' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        await page.locator(`${tree} [data-stream="${other.id}"]`).waitFor({ state: 'visible' });

        await page.keyboard.press('/');
        expect(
          (await page.evaluate('document.activeElement?.dataset?.testid ?? null')) as string,
        ).toBe('stream-filter');
        await page.keyboard.type('PARS');
        await page.locator(`${tree} [data-stream="${other.id}"]`).waitFor({ state: 'detached' });
        expect(await page.locator(`${tree} [data-stream="${leaf.id}"]`).count()).toBe(1);
        expect(await page.locator(`${tree} [data-stream="${root.id}"]`).count()).toBe(1);
        // Typed into the filter, `n` stays a letter.
        await page.keyboard.type('n');
        expect(await page.locator('[data-testid="new-stream"]').count()).toBe(0);

        await page.keyboard.press('Escape');
        await page.locator(`${tree} [data-stream="${other.id}"]`).waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('add a repo from Settings (Playwright e2e, T206)', () => {
  browserTest(
    'fixtures/demo-project registers from Settings and shows in the New stream repo picker; a bad path shows the one-line error',
    async () => {
      const cockpit = await startCockpit();
      const fixture = join(import.meta.dir, '..', '..', '..', '..', 'fixtures', 'demo-project');
      const scratch = mkdtempSync(join(tmpdir(), 'agile-repo-add-e2e-'));
      const repo = join(scratch, 'demo-project');
      let page: Page | undefined;
      try {
        cpSync(fixture, repo, { recursive: true });
        git(['init', '-q', '-b', 'master'], repo);
        git(['config', 'user.email', 'test@example.com'], repo);
        git(['config', 'user.name', 'Test'], repo);
        git(['add', '-A'], repo);
        git(['commit', '-q', '-m', 'init'], repo);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-repos-empty"]').waitFor({ state: 'visible' });

        // A path inside a repo but not its toplevel is refused with the daemon's line.
        await page.locator('[data-testid="settings-repo-add-path"]').fill(join(repo, 'src'));
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await waitForText(
          page,
          '[data-testid="settings-repo-add-error"]',
          `state.repo_add: ${join(repo, 'src')} is not the repo's toplevel (that is ${repo})`,
        );
        const missing = join(scratch, 'nope');
        await page.locator('[data-testid="settings-repo-add-path"]').fill(missing);
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await waitForText(
          page,
          '[data-testid="settings-repo-add-error"]',
          `state.repo_add: ${missing} does not exist`,
        );
        expect(cockpit.store.getRepos()).toEqual({});

        await page.locator('[data-testid="settings-repo-add-path"]').fill(repo);
        await page.locator('[data-testid="settings-repo-add-protected"]').fill('master, release');
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await waitForText(page, '[data-testid="settings-repo-demo-project-main"]', 'master');
        expect(await page.locator('[data-testid="settings-repo-add-error"]').count()).toBe(0);
        expect(cockpit.store.getRepos()['demo-project']?.protected_branches).toEqual([
          'master',
          'release',
        ]);

        await page.keyboard.press('n');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        await page
          .locator('[data-testid="new-stream-repo-names"] option[value="demo-project"]')
          .waitFor({ state: 'attached' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T222: repo delivery settings --------------------------------------------

describe('repo delivery settings (Playwright e2e, T222)', () => {
  browserTest(
    'change the delivery mode in Settings: pr is refused without GitHub auth, then set with it',
    async () => {
      let authed = false;
      const cockpit = await startCockpit({ githubAuth: async () => authed });
      const repo = mkdtempSync(join(tmpdir(), 'agile-delivery-e2e-'));
      let page: Page | undefined;
      try {
        git(['init', '-q', '-b', 'main'], repo);
        git(['remote', 'add', 'origin', 'git@github.com:acme/api.git'], repo);
        await cockpit.store.addRepo('api', { path: repo });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        const row = '[data-testid="settings-repo-api"]';
        await page.locator(`${row}[data-delivery="direct"]`).waitFor({ state: 'visible' });

        await page.locator('[data-testid="settings-repo-api-delivery"]').selectOption('pr');
        await waitForText(
          page,
          '[data-testid="settings-repo-api-error"]',
          'state.repo_set: pr delivery needs GitHub auth — run `gh auth login` (see `agile daemon status`)',
        );
        expect(cockpit.store.getRepos().api?.delivery).toBe('direct');

        authed = true;
        await page.locator('[data-testid="settings-repo-api-delivery"]').selectOption('pr');
        await page.locator(`${row}[data-delivery="pr"]`).waitFor({ state: 'visible' });
        // Controlled by the saved row, so it flips only after the POST: click, then wait.
        await page.locator('[data-testid="settings-repo-api-auto-merge"]').click();
        await waitUntil(
          'auto-merge to be saved',
          () => cockpit.store.getRepos().api?.auto_merge === true,
        );
        expect(cockpit.store.getRepos().api).toMatchObject({
          delivery: 'pr',
          github: { owner: 'acme', repo: 'api' },
        });

        await page.locator('[data-testid="settings-repo-api-delivery"]').selectOption('direct');
        await page.locator(`${row}[data-delivery="direct"]`).waitFor({ state: 'visible' });
        expect(cockpit.store.getRepos().api?.delivery).toBe('direct');
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T208: the project tree and switcher -----------------------------------

describe('project tree and switcher (Playwright e2e, T208)', () => {
  browserTest(
    "two projects: each one's nodes show only under it; quick capture lands in the selected one",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const shopNode = await cockpit.streams.create('human', {
          title: 'checkout',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        await page.locator(`${tree} [data-stream="${shopNode.id}"]`).waitFor({ state: 'visible' });
        // The root carries the project icon, and the node nests under it.
        expect(
          await page.locator(`${tree} [data-stream="${shop.root}"]`).getAttribute('data-role'),
        ).toBe('project');
        await page
          .locator(`[data-stream="${shop.root}"] + ul [data-stream="${shopNode.id}"]`)
          .waitFor({ state: 'visible' });

        // "New project" from the rail: the switcher moves to it.
        await page.locator('[data-testid="new-project-open"]').click();
        await page.locator('[data-testid="new-project-name"]').fill('docs');
        await page.locator('[data-testid="new-project-create"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'detached' });
        await waitUntil('the project to exist', () => cockpit.projects.list().length === 2);
        const docs = cockpit.projects.list().find((p) => p.name === 'docs');
        if (!docs) throw new Error('docs project missing');
        await waitUntilAsync(
          'the switcher to select docs',
          async () =>
            (await page?.locator('[data-testid="project-switcher"]').inputValue()) === docs.id,
        );
        await page.locator(`${tree} [data-stream="${docs.root}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${shopNode.id}"]`).count()).toBe(0);
        expect(await page.locator(`${tree} [data-stream="${shop.root}"]`).count()).toBe(0);

        // Quick capture files into the selected project (not the only/first one).
        await page.locator('[data-testid="quick-capture"]').fill('write the guide');
        await page.locator('[data-testid="quick-capture"]').press('Enter');
        await waitUntil('the capture to exist', () =>
          cockpit.streams.list().some((s) => s.title === 'write the guide'),
        );
        const captured = cockpit.streams.list().find((s) => s.title === 'write the guide');
        expect(captured?.project).toBe(docs.id);
        expect(captured?.parent).toBe(docs.root);
        await page.locator(`${tree} [data-stream="${captured?.id}"]`).waitFor({ state: 'visible' });
        expect(
          await page.locator(`${tree} [data-stream="${docs.root}"]`).getAttribute('data-role'),
        ).toBe('project');

        // Back to shop: only shop's nodes.
        await page.locator('[data-testid="project-switcher"]').selectOption(shop.id);
        await page.locator(`${tree} [data-stream="${shopNode.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${captured?.id}"]`).count()).toBe(0);
        expect(await page.locator(`${tree} [data-stream="${docs.root}"]`).count()).toBe(0);

        // "All" shows both projects' trees.
        await page.locator('[data-testid="project-switcher"]').selectOption('');
        await page.locator(`${tree} [data-stream="${captured?.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${shopNode.id}"]`).count()).toBe(1);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('New stream starts the agent (Playwright e2e, T204)', () => {
  browserTest(
    'a node made from New stream shows a running session without a second click',
    async () => {
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const parent = await cockpit.streams.create('human', {
          title: 'ledger-lite',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        const traffic = recordTraffic(page);
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${parent.id}"]`).click();
        await page.keyboard.press('n');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="new-stream-title"]').fill('import CSV');
        await page.locator('[data-testid="new-stream-repo"]').fill('demo');
        await page.locator('[data-testid="new-stream-create"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });

        const created = cockpit.streams.list().find((x) => x.title === 'import CSV');
        await waitForRunningWorker(page, cockpit, created?.id ?? '', traffic);
        // The control reads Restart once a worker has run.
        expect(await page.locator('[data-testid="attach"]').textContent()).toBe('Restart');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a stale stream-page read that lands last never hides a running session',
    async () => {
      // Every pushed frame and every action re-reads the page, so reads
      // overlap and their responses can land in any order.
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'CSV parser',
          goal: 'g',
          repo: 'demo',
        });
        // The cockpit's service worker would take the reads out of `page.route`'s sight.
        page = await openPage({ serviceWorkers: 'block' });
        // The first page read is served before the attach commits (no
        // session yet). Answer the first read after the attach with that
        // stale body, late: a read served before a write, arriving after
        // the reads served after it, the order a loaded CI box can produce.
        let staleBody: string | undefined;
        let attached = false;
        let held = 0;
        await page.route(
          (url) => url.pathname.startsWith('/api/streams/'),
          async (route) => {
            const request = route.request();
            const response = await route.fetch();
            if (request.method() === 'POST') {
              await route.fulfill({ response });
              attached = true;
              return;
            }
            if (!request.url().endsWith(`/api/streams/${stream.id}`)) {
              await route.fulfill({ response });
              return;
            }
            if (staleBody === undefined) staleBody = await response.text();
            if (attached && held === 0) {
              held += 1;
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              await route.fulfill({ response, body: staleBody });
              return;
            }
            await route.fulfill({ response });
          },
        );
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator('[data-testid="attach"]').click();
        await page.locator('[data-testid="picker-start"]').click();
        await page
          .locator('[data-testid="session"][data-role="worker"][data-status="running"]')
          .waitFor();
        // Past every held read: the page still shows the fresh state.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(held).toBeGreaterThan(0);
        expect(
          await page
            .locator('[data-testid="session"][data-role="worker"]')
            .getAttribute('data-status'),
        ).toBe('running');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'quick capture files a node and starts no session',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const parent = await cockpit.streams.create('human', {
          title: 'ledger-lite',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${parent.id}"]`).click();
        await page.locator('[data-testid="quick-capture"]').fill('why is export slow?');
        await page.locator('[data-testid="quick-capture"]').press('Enter');
        await waitUntil('the captured node', () =>
          cockpit.streams.list().some((s) => s.title === 'why is export slow?'),
        );
        const captured = cockpit.streams.list().find((s) => s.title === 'why is export slow?');
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        expect(captured?.sessions).toEqual([]);
        expect(await page.locator('[data-testid="attach"]').textContent()).toBe('Start');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('+ Repo in place (Playwright e2e, T205)', () => {
  browserTest(
    '+ Repo on a conversation keeps the thread; a second repo (from a proposal) adds part rows',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'Sale prices',
          goal: 'can we show sale prices?',
          project: shop.id,
        });
        await cockpit.streams.appendThread('human', node.id, {
          kind: 'line',
          body: 'THREAD-MARKER-205',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        const root = `[data-testid="stream-page"][data-stream="${node.id}"]`;
        await page.locator(root).waitFor();

        // Conversation + demo: a work node with a branch, the same thread.
        await page.locator('[data-testid="add-repo"]').click();
        await page.locator('[data-testid="add-repo-select"]').selectOption('demo');
        await page.locator('[data-testid="add-repo-submit"]').click();
        await page.locator('[data-testid="stream-status"]', { hasText: 'stream/' }).waitFor();
        expect(cockpit.streams.get(node.id).repo).toBe('demo');
        await page
          .locator(`${root} [data-testid="thread"]`, { hasText: 'THREAD-MARKER-205' })
          .waitFor();

        // The agent's "web too?" proposal carries an Add button.
        await cockpit.streams.appendThread('daemon', node.id, {
          kind: 'proposal',
          body: 'next: this needs a change in web too; add it?',
        });
        await page.locator('[data-testid="proposal-add-repo"]', { hasText: 'Add web' }).click();
        await waitUntil(
          'two parts',
          () => cockpit.streams.list().filter((s) => s.parent === node.id).length === 2,
        );
        const parts = cockpit.streams.list().filter((s) => s.parent === node.id);
        for (const part of parts) {
          await page.locator(`[data-testid="stream-tree"] [data-stream="${part.id}"]`).waitFor();
        }
        expect(parts.map((p) => p.title).sort()).toEqual(['demo part', 'web part']);
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${node.id}"][data-role="coordinating"]`,
          )
          .waitFor();
        await page
          .locator(`${root} [data-testid="thread"]`, { hasText: 'THREAD-MARKER-205' })
          .waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T227: overlap tracking ------------------------------------------------

describe('overlap warnings (Playwright e2e, T227)', () => {
  browserTest(
    'two api nodes in different projects touching prices.ts warn in the repo view and the rail',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const blog = await cockpit.projects.create({ name: 'Blog' });
        const a = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
          repo: 'api',
        });
        const b = await cockpit.streams.create('human', {
          title: 'api: add /posts',
          goal: 'g',
          project: blog.id,
          repo: 'api',
        });
        const at = new Date().toISOString();
        await cockpit.streams.update('daemon', a.id, {
          touched: { files: ['prices.ts', 'sale.ts'], base: 'abc', at },
        });
        await cockpit.streams.update('daemon', b.id, {
          touched: { files: ['posts.ts', 'prices.ts'], base: 'abc', at },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${a.id}"] [data-testid="overlap-mark"]`,
          )
          .waitFor();
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${a.parent}"] [data-testid="overlap-mark"]`,
          )
          .waitFor();
        await page.locator('[data-view="repos"]').click();
        await waitForText(
          page,
          '[data-testid="repo-view"] [data-repo="api"] [data-testid="repo-overlap"]',
          '⚠ api: add salePrice and api: add /posts both changed prices.ts',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T283: status cards ---------------------------------------------------

describe('status cards on the parent page (Playwright e2e, T283)', () => {
  browserTest(
    "a child's card shows its doing, state and files on its parent's page",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const api = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
          parent: shop.root,
          repo: 'api',
        });
        const cards = new CardService({ store: cockpit.store, streams: cockpit.streams });
        const after = await cockpit.streams.update('daemon', api.id, {
          agent: { status: 'working', progress: 'adding salePrice' },
          touched: { files: ['prices.ts'], base: 'abc', at: new Date().toISOString() },
        });
        await cards.refresh(after);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        const card = `[data-testid="child-cards"] [data-node="${api.id}"]`;
        await waitForAttr(page, card, 'data-state', 'working');
        await waitForText(page, `${card} [data-testid="status-card-doing"]`, 'adding salePrice');
        await waitForText(page, `${card} [data-testid="status-card-files"]`, 'prices.ts');

        // A corrupt card is an error line naming path:line; the others still render.
        const web = await cockpit.streams.create('human', {
          title: 'web: show sale',
          goal: 'g',
          project: shop.id,
          parent: shop.root,
          repo: 'api',
        });
        writeFileSync(
          join(cockpit.home, 'cards', `${web.id}.yaml`),
          `node: ${web.id}\ndoing: x\nstate: exploding\n`,
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale!' });
        const bad = `[data-testid="child-cards"] [data-node="${web.id}"] [data-testid="status-card-error-text"]`;
        await page.locator(bad).waitFor();
        expect(await page.locator(bad).textContent()).toContain(`cards/${web.id}.yaml:3:`);
        await waitForAttr(page, card, 'data-state', 'working');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T209: the repo view and lenses ----------------------------------------

describe('repo view and lenses (Playwright e2e, T209)', () => {
  browserTest(
    'a node on api in two projects shows under api with both paths; Running lists only live sessions',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({
          api: { path: cockpit.home, delivery: 'pr' },
          web: { path: cockpit.home },
        });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const blog = await cockpit.projects.create({ name: 'Blog' });
        const feature = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
        });
        const shopApi = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          parent: feature.id,
          repo: 'api',
        });
        await cockpit.streams.create('human', {
          title: 'Show the sale on web',
          goal: 'g',
          parent: feature.id,
        });
        const blogApi = await cockpit.streams.create('human', {
          title: 'api: add /posts',
          goal: 'g',
          project: blog.id,
          repo: 'api',
        });
        await cockpit.streams.update('human', blogApi.id, {
          waits_on: [{ node: shopApi.id, added_by: 'human', added_at: new Date().toISOString() }],
        });
        await cockpit.store.updateStream('daemon', shopApi.id, (s) => ({
          ...s,
          sessions: [
            {
              id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              vendor: 'claude',
              model: 'm',
              role: 'worker',
              status: 'running',
            },
          ],
        }));

        // T265: an accepted api standard shows under api; a proposal and a web one do not.
        const apiNorm = await cockpit.rules.create('human', {
          text: 'every handler validates its input',
          scope: { kind: 'repo', repo: 'api' },
        });
        await cockpit.rules.accept(apiNorm.id, 'human');
        await cockpit.rules.create('human', {
          text: 'a proposal is not a norm',
          scope: { kind: 'repo', repo: 'api' },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="repos"]').click();
        const api = '[data-testid="repo-view"] [data-repo="api"]';
        await page.locator(`${api} [data-knowledge="${apiNorm.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${api} [data-testid="repo-norm"]`).count()).toBe(1);
        expect(
          await page.locator(`${api} [data-knowledge="${apiNorm.id}"]`).textContent(),
        ).toContain('every handler validates its input');
        expect(
          await page
            .locator('[data-testid="repo-view"] [data-repo="web"] [data-testid="repo-norm"]')
            .count(),
        ).toBe(0);
        await page.locator(`${api} [data-stream="${blogApi.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${api} [data-testid="repo-delivery"]`).textContent()).toBe(
          '(pr)',
        );
        expect(
          await page
            .locator(`${api} [data-stream="${shopApi.id}"] [data-testid="node-path"]`)
            .textContent(),
        ).toBe('Shop › Show sale prices › api: add salePrice');
        expect(
          await page
            .locator(`${api} [data-stream="${blogApi.id}"] [data-testid="node-path"]`)
            .textContent(),
        ).toBe('Blog › api: add /posts');
        expect(await page.locator(`${api} [data-stream]`).count()).toBe(2);
        expect(
          await page
            .locator('[data-testid="repo-view"] [data-repo="web"] [data-testid="repo-delivery"]')
            .textContent(),
        ).toBe('(direct)');

        await page.locator('[data-view="running"]').click();
        const running = '[data-testid="running-lens"]';
        await page
          .locator(`${running} [data-stream="${shopApi.id}"]`)
          .waitFor({ state: 'visible' });
        expect(await page.locator(`${running} [data-stream]`).count()).toBe(1);

        await page.locator('[data-view="deps"]').click();
        await waitForText(
          page,
          '[data-testid="deps-lens"] [data-testid="dep-edge"]',
          'api: add /posts waits on api: add salePrice',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T245: the node Activity tab --------------------------------------------

describe('node activity (Playwright e2e, T245)', () => {
  browserTest(
    "a main_changed on api shows on the other api node's Activity as same repo",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const blog = await cockpit.projects.create({ name: 'Blog' });
        const a = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
          repo: 'api',
        });
        const b = await cockpit.streams.create('human', {
          title: 'api: add /posts',
          goal: 'g',
          project: blog.id,
          repo: 'api',
        });
        // T244's producer emits this on a merge; here it is emitted directly.
        const event = await routeAndEmit(
          cockpit.events,
          {
            type: 'main_changed',
            subject: a.id,
            repo: 'api',
            payload: { repo: 'api', sha: 'abc123', outcome: 'synced' },
            by: 'daemon',
          },
          cockpit.streams.list(),
        );
        expect(event.routing).toEqual([{ node: b.id, because: 'same_repo' }]);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${b.id}"]`).click();
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        const row = `[data-testid="activity"] [data-event="${event.id}"]`;
        await waitForText(page, `${row} [data-testid="activity-because"]`, 'same repo');
        expect(await page.locator(`${row} [data-testid="activity-type"]`).textContent()).toBe(
          'main changed',
        );
        expect(
          await page.locator(`${row} [data-testid="activity-status"]`).textContent(),
        ).toContain('pending');

        // The subject itself was not routed the event.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${a.id}"]`).click();
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        await page.locator('[data-testid="activity-empty"]').waitFor();

        // The repo view lists the repo's events.
        await page.locator('[data-view="repos"]').click();
        await waitForText(
          page,
          `[data-testid="repo-view"] [data-repo="api"] [data-event="${event.id}"]`,
          'main changed · api: add salePrice',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('plan approval (Playwright e2e, T281)', () => {
  browserTest(
    'a draft plan is an inbox card; Approve moves it to approved on the Plan tab',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const node = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
        });
        const child = (title: string) =>
          cockpit.streams.create('human', { title, goal: 'g', project: shop.id, parent: node.id });
        const api = await child('api: add salePrice');
        const web = await child('web: show salePrice');
        const contract = await cockpit.contracts.write(
          node.id,
          {
            title: 'GET /price/:id',
            body: 'returns { cents, saleCents? }',
            parties: [api.id, web.id],
          },
          'human',
        );
        await cockpit.plans.write(
          node.id,
          [
            { child: api.id, owns: ['prices.ts'] },
            { child: web.id, owns: ['shop.html'] },
          ],
          [contract.id],
        );

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-kind="plan_approve"][data-id="${node.id}"]`;
        await page.locator(`${card} [data-testid="plan-approve"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'api: add salePrice owns prices.ts',
        );
        await page.locator(`${card} [data-testid="plan-approve"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        expect(cockpit.plans.get(node.id)?.status).toBe('approved');

        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page.locator('.cr-tabs [data-tab="plan"]').click();
        await waitForAttr(page, '[data-testid="plan-status"]', 'data-status', 'approved');
        await page.locator(`[data-contract="${contract.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`[data-contract="${contract.id}"]`).textContent()).toContain(
          'saleCents',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('coordinator autonomy (Playwright e2e, T282)', () => {
  browserTest(
    'at Advise a coordinator change is an inbox card; Apply performs it; the node picker overrides the level',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const node = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
        });
        const child = (title: string) =>
          cockpit.streams.create('human', { title, goal: 'g', project: shop.id, parent: node.id });
        const api = await child('api: add salePrice');
        const web = await child('web: show salePrice');
        const out = await cockpit.autonomy.act(node.id, 'coordinator', 'agent:test', {
          action: 'add_waits_on',
          child: web.id,
          on: api.id,
        });
        expect(out.applied).toBe(false);
        const id = out.applied ? '' : out.proposal.id;

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-kind="proposal"][data-id="${id}"]`;
        await page.locator(`${card} [data-testid="proposal-apply"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'web: show salePrice waits on api: add salePrice',
        );
        await page.locator(`${card} [data-testid="proposal-apply"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        expect(cockpit.streams.get(web.id).waits_on?.map((w) => w.node)).toEqual([api.id]);
        expect(cockpit.autonomy.get(id).status).toBe('applied');

        // The node's picker: override the project's Advise with Organise.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page.locator('[data-testid="autonomy-select"]').selectOption('organise');
        const deadline = Date.now() + 10_000;
        while (cockpit.streams.get(node.id).autonomy !== 'organise' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(cockpit.autonomy.levelFor(node.id)).toBe('organise');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('the Director page (Playwright e2e, T300)', () => {
  browserTest(
    'the page shows the Director thread; a line sent there is routed to the Director',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.appendDirectorThread({
          ts: new Date().toISOString(),
          by: 'director',
          kind: 'line',
          body: 'Two projects are idle.',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="director"]').click();
        await page.locator('[data-testid="director-page"]').waitFor();
        const entry = (text: string) =>
          (page as Page)
            .locator('[data-testid="director-thread"] [data-testid="thread-entry"]', {
              hasText: text,
            })
            .waitFor();
        await entry('Two projects are idle.');
        await page.locator('[data-testid="director-composer"]').fill('Shop needs sale prices.');
        await page.locator('[data-testid="director-send"]').click();
        await entry('Shop needs sale prices.');
        await page
          .locator('[data-testid="director-activity-row"]', { hasText: 'director request' })
          .waitFor();
        expect(cockpit.events.pendingFor('director').map((p) => p.event.type)).toEqual([
          'director_request',
        ]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});
