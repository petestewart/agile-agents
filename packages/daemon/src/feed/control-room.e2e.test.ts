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
  realpathSync,
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
  liveChildrenOf,
  nodeRole,
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
import { PlanService, WAITING_FOR_PLAN, planMoveCoordination } from '../coordination/plans';
import { DeliveryService } from '../delivery';
import { DirectorService } from '../director';
import { DocsService } from '../docs';
import { RoutedEventService, emitTransitions, makeEmitter, routeAndEmit } from '../events';
import { GateService } from '../gates';
import { type HttpServerHandle, startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { KnowledgeService, type RuleRpcEvalDeps } from '../knowledge';
import { startFakeLinear } from '../trackers/fake-linear';
import { createLinear } from '../trackers/linear';
import { TrackerLinks } from '../trackers/link';

/** Proposals the home migration carried over from a seed import are batched under this source. */
const SEED_PROVENANCE = 'migration';
import { ProjectService } from '../projects';
import { QuestionService } from '../questions';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { type MoveCoordination, RepoInPlaceService, StreamService } from '../streams';
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

/** T365: New node's Parent is a searchable picker (`''` is the project's top level). */
async function pickParent(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="new-stream-parent"]').click();
  await page.locator(`[data-testid="new-stream-parent-option"][data-node="${id}"]`).click();
  await waitForAttr(page, '[data-testid="new-stream-parent"]', 'data-value', id);
}

/** T365: New node's Repository is a picker with each repo's host icon (`''` is none: a conversation). */
async function pickRepo(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-stream-repo"]').click();
  await page.locator(`[data-testid="new-stream-repo-option"][data-repo="${name}"]`).click();
  await waitForAttr(page, '[data-testid="new-stream-repo"]', 'data-value', name);
}

/** T365: an item of a rail row's ⋯ menu. */
async function rowMenu(page: Page, id: string, item: string): Promise<void> {
  await page
    .locator(`[data-tree-node="${id}"] > .cr-tree-item [data-testid="tree-menu-trigger"]`)
    .click();
  await page.locator(`[data-testid="tree-menu"] [data-testid="${item}"]`).click();
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
    /** T321: the Link field's service, over a local fake tracker. */
    trackerLinks?: (streams: StreamService) => TrackerLinks;
    /** T367: the home folder the folder picker and clone see (`~`), instead of the real one. */
    userHome?: string;
  } = {},
): Promise<Cockpit> {
  const home = mkdtempSync(join(tmpdir(), 'agile-cockpit-e2e-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  // T333: a move asks plans and contracts, read lazily as the daemon does.
  const late: { move?: MoveCoordination } = {};
  const streams = new StreamService(store, {
    coordination: {
      planAwaitingApproval: (n) => late.move?.planAwaitingApproval(n) === true,
      namedIn: (p, c) => late.move?.namedIn(p, c) ?? [],
    },
  });
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
  late.move = planMoveCoordination(plans, contracts);
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
    ...(extra.trackerLinks ? { trackerLinks: extra.trackerLinks(streams) } : {}),
    ...(extra.userHome !== undefined ? { userHome: extra.userHome } : {}),
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
          await page
            .locator(`[data-tree-node="${mid.id}"] > ul [data-stream="${leaf.id}"]`)
            .count(),
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

        // Back to Needs me: allow the routed call with a reason.
        await page.locator('[data-view="inbox"]').click();
        const gateCard = `[data-id="${gate.id}"]`;
        // T364: the note is a small "Add a note" affordance that opens an input.
        await page.locator(`${gateCard} [data-testid="gate-add-note"]`).click();
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

        // T364: on the node page a question card has no input of its own (the
        // page's composer answers it, T363), so it is answered from Needs me.
        // T363 re-points this step at the node page's composer.
        expect(await page.locator(`${card} [data-testid="answer-input"]`).count()).toBe(0);
        // T360: the views live in the drawer at phone width.
        await page.locator('[data-testid="rail-toggle"]').click();
        await page.locator('[data-view="inbox"]').click();
        const listed = `[data-testid="inbox"] ${card}`;
        await page.locator(`${listed} [data-testid="answer-input"]`).fill('main');
        await page.locator(`${listed} [data-testid="answer-send"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
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

describe('Needs me and the decision cards (Playwright e2e, T364)', () => {
  browserTest(
    "a question's choices answer with one click, in Needs me and on the node page; j/k and Enter; the filter",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const csv = await cockpit.streams.create('human', { title: 'csv dialect', goal: 'g' });
        const pricing = await cockpit.streams.create('human', { title: 'pricing', goal: 'g' });
        const session = ulid();
        const asked = await cockpit.questions.raise({
          stream: csv.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session,
          text: 'Which delimiter should the parser treat as canonical?',
          options: ['comma', 'semicolon', 'tab'],
        });
        // An older question: its choices are only in its text.
        const written = await cockpit.questions.raise({
          stream: pricing.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session,
          text: 'Which competitor should I start with? (A) Linear (B) Height',
        });
        const gate = await cockpit.gates.request('classifier_review', {
          policy: cockpit.store.getPolicy(),
          stream: pricing.id,
          summary: 'editing a dependency manifest is never automatic',
          call: { tool: 'Edit', path: '/tmp/wt/package.json', fingerprint: '0123456789abcdef' },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-id="${asked.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} .kind`).textContent()).toBe('Question');
        const choices = page.locator(`${card} [data-testid="answer-choice"]`);
        expect(await choices.count()).toBe(3);
        expect(await choices.nth(1).textContent()).toContain('semicolon');
        // Typing is still there in the list, for an answer that isn't a choice.
        expect(await page.locator(`${card} [data-testid="answer-input"]`).count()).toBe(1);

        // The written choices are buttons too, and the text no longer repeats them.
        const other = `[data-testid="inbox"] [data-id="${written.id}"]`;
        expect(await page.locator(`${other} [data-testid="answer-choice"]`).count()).toBe(2);
        expect(
          (await page.locator(`${other} [data-testid="inbox-context"]`).textContent())?.trim(),
        ).toBe('Which competitor should I start with?');

        // The filter: questions, decisions (the gate), all.
        const filter = '[data-testid="inbox-filter"]';
        await page.locator(`${filter} [data-value="decisions"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        expect(await page.locator(`[data-testid="inbox"] [data-id="${gate.id}"]`).count()).toBe(1);
        await page.locator(`${filter} [data-value="all"]`).click();
        await page.locator(card).waitFor({ state: 'visible' });

        // One click answers with the choice's text, verbatim.
        await choices.nth(1).click();
        await waitUntil('the answer to be delivered', () => cockpit.delivered.length > 0);
        expect(cockpit.delivered[0]?.question.id).toBe(asked.id);
        expect(cockpit.delivered[0]?.question.answer).toBe('semicolon');
        await page.locator(card).waitFor({ state: 'detached' });

        // j focuses the first card; Enter opens its node.
        await page.locator('[data-testid="inbox"] h1').click();
        await page.keyboard.press('j');
        const focused = async (id: string): Promise<boolean> =>
          (await page?.evaluate<boolean>(
            `document.activeElement?.getAttribute('data-id') === ${JSON.stringify(id)}`,
          )) === true;
        await waitUntilAsync('j to focus the first card', () => focused(written.id));
        await page.keyboard.press('j');
        await waitUntilAsync('j to move to the next card', () => focused(gate.id));
        await page.keyboard.press('k');
        await page.keyboard.press('Enter');
        await page.locator(`[data-testid="stream-page"][data-stream="${pricing.id}"]`).waitFor();

        // On the node page the card has its choices and no input of its own:
        // the page's composer answers it.
        const full = `[data-testid="stream-needs"] [data-id="${written.id}"]`;
        await page.locator(full).waitFor({ state: 'visible' });
        expect(await page.locator(`${full} [data-testid="answer-input"]`).count()).toBe(0);
        expect(await page.locator(`${full} [data-testid="answer-send"]`).count()).toBe(0);
        expect(await page.locator(`${full} [data-testid="answer-hint"]`).textContent()).toContain(
          'or type your answer below',
        );
        await page.locator(`${full} [data-testid="answer-choice"]`, { hasText: 'Height' }).click();
        await waitUntil('the second answer', () => cockpit.delivered.length > 1);
        expect(cockpit.delivered[1]?.question.answer).toBe('Height');
        await page.locator(full).waitFor({ state: 'detached' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a first run shows the three steps with their state, and each step opens its place',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const empty = '[data-testid="inbox-empty"][data-state="first-run"]';
        await page.locator(empty).waitFor({ state: 'visible' });
        const step = (id: string): string =>
          `${empty} [data-testid="setup-step"][data-step="${id}"]`;
        for (const id of ['repo', 'project', 'node']) {
          expect(await page.locator(step(id)).getAttribute('data-done')).toBe('false');
        }
        // Add a repository opens Settings.
        await page.locator('[data-testid="setup-repo"]').click();
        await page.locator('[data-testid="settings"]').waitFor({ state: 'visible' });
        await page.locator('[data-view="inbox"]').click();
        // Create a project opens the New project dialog.
        await page.locator('[data-testid="setup-project"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'visible' });
        // A project made (here through the service) ticks its step, live.
        await cockpit.projects.create({ name: 'shop' });
        await waitForAttr(page, step('project'), 'data-done', 'true');
        expect(await page.locator(step('repo')).getAttribute('data-done')).toBe('false');
        expect(await page.locator(step('node')).getAttribute('data-done')).toBe('false');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

/** T366: opens an item's side panel on the Knowledge screen (a click on its row); returns its selector. */
async function openKnowledgeItem(page: Page, id: string): Promise<string> {
  const detail = `[data-testid="rules-detail"][data-rule="${id}"]`;
  await page.locator(`[data-testid="rules-row"][data-rule="${id}"]`).waitFor();
  if ((await page.locator(detail).count()) === 0) {
    await page.locator(`[data-testid="rules-row"][data-rule="${id}"] .cr-kn-row-main`).click();
  }
  await page.locator(detail).waitFor();
  return detail;
}

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
        // To review, filtered to that source, is now empty.
        await page.locator('[data-testid="rules-empty"]').waitFor();

        // T366: clear the source filter: To review shows the lesson. Accept
        // it from its row.
        await page.locator('[data-testid="rules-filter-source"] button').click();
        const row = `[data-testid="rules-row"][data-rule="${lesson.id}"]`;
        await page.locator(`${row} [data-testid="rules-accept"]`).click();
        await waitUntil(
          'the lesson to be accepted',
          () => cockpit.store.getKnowledge(lesson.id).status === 'accepted',
        );
        expect(cockpit.store.getKnowledge(lesson.id).decided_by).toBe('human');
        // Every status on All: the lesson reads accepted, and the retired
        // three fold under Retired until asked for.
        await page.locator('[data-testid="rules-tab-all"]').click();
        await waitForAttr(page, row, 'data-status', 'accepted', POLL_DEADLINE_MS);
        expect(await page.locator('[data-testid="rules-row"][data-status="retired"]').count()).toBe(
          0,
        );
        await page.locator('[data-testid="rules-show-retired"]').click();
        await waitForCount(page, '[data-testid="rules-row"][data-status="retired"]', 3);

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
        // T366: the check, its examples and the actions live in the item's panel.
        const detail = await openKnowledgeItem(page, rule.id);
        // A proposal is not evaluated: the button is there but disabled.
        expect(await page.locator(`${detail} [data-testid="rules-test"]`).isDisabled()).toBe(true);

        await page.locator(`${detail} [data-testid="rules-edit"]`).click();
        const editor = '[data-testid="rules-editor"]';
        await page
          .locator(`${editor} [data-testid="rules-edit-question"]`)
          .fill('Does this action add a package to the project?');
        await page
          .locator(`${editor} [data-testid="rules-edit-criteria-true"]`)
          .fill('a package manager adds a dependency');
        await page
          .locator(`${editor} [data-testid="rules-edit-criteria-false"]`)
          .fill('no dependency changes');
        await page.locator(`${editor} [data-testid="rules-edit-add-example"]`).click();
        await page
          .locator(
            `${editor} [data-testid="rules-edit-example"] input[aria-label="Example action"]`,
          )
          .nth(2)
          .fill('npm install left-pad');
        await page.locator(`${editor} [data-testid="rules-edit-save"]`).click();
        await page.locator(editor).waitFor({ state: 'detached' });
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
          `${detail} [data-testid="rules-question"]`,
          'Does this action add a package to the project?',
        );

        await page.locator(`${detail} [data-testid="rules-accept"]`).click();
        await waitForAttr(page, row, 'data-status', 'accepted', POLL_DEADLINE_MS);
        await waitForText(page, `${detail} [data-testid="rules-status"]`, 'Accepted');
        await page.locator(`${detail} [data-testid="rules-test"]`).click();
        await waitForCount(page, `${detail} [data-testid="rules-eval"]`, 3);
        const bands = await page
          .locator(`${detail} [data-testid="rules-eval"]`)
          .evaluateAll((els) =>
            els.map((el) => [el.getAttribute('data-band'), el.getAttribute('data-agree')]),
          );
        expect(bands).toEqual([
          ['deny', 'yes'],
          ['allow', 'yes'],
          ['route', 'no'],
        ]);
        expect(await page.locator(`${detail} [data-testid="rules-evals"]`).textContent()).toContain(
          '2 of 3 examples agree',
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
        // T366: the panel says the pattern in words (the raw spelling is gone).
        const detail = await openKnowledgeItem(page, rule.id);
        await waitForAttr(
          page,
          `${detail} [data-testid="rules-pattern"]`,
          'title',
          'Blocks commands matching "rm -rf", "git reset --hard"',
        );

        // Edit, change everything, Cancel: nothing is sent, the editor closes.
        const editor = '[data-testid="rules-editor"]';
        const before = JSON.stringify(cockpit.store.getKnowledge(rule.id));
        await page.locator(`${detail} [data-testid="rules-edit"]`).click();
        await page.locator(`${editor} [data-testid="rules-edit-text"]`).fill('changed text');
        await page
          .locator(`${editor} [data-testid="rules-edit-pattern-kind"]`)
          .selectOption('no_push');
        await page.locator(`${editor} [data-testid="rules-edit-cancel"]`).click();
        await page.locator(editor).waitFor({ state: 'detached' });
        // Reopened, the draft is the saved rule again, not the discarded one.
        await page.locator(`${detail} [data-testid="rules-edit"]`).click();
        expect(await page.locator(`${editor} [data-testid="rules-edit-text"]`).inputValue()).toBe(
          'never wipe the tree',
        );
        await page.locator(`${editor} [data-testid="rules-edit-text"]`).fill('changed by esc');
        await page.locator(`${editor} [data-testid="rules-edit-text"]`).press('Escape');
        await page.locator(editor).waitFor({ state: 'detached' });
        // Esc left the editor, not the item: its panel is still open.
        await page.locator(detail).waitFor();
        expect(JSON.stringify(cockpit.store.getKnowledge(rule.id))).toBe(before);

        // Editing the pattern's arguments does save.
        await page.locator(`${detail} [data-testid="rules-edit"]`).click();
        await page
          .locator(`${editor} [data-testid="rules-edit-pattern-args"]`)
          .fill('rm -rf\ngit clean -fdx');
        await page.locator(`${editor} [data-testid="rules-edit-save"]`).click();
        await page.locator(editor).waitFor({ state: 'detached' });
        expect(patternOf(cockpit.store.getKnowledge(rule.id))).toEqual({
          kind: 'command_deny',
          args: { patterns: ['rm -rf', 'git clean -fdx'] },
        });

        // Add knowledge: a pattern is an action check only (§14.3), so a
        // ship item is never offered one; an action item is.
        await page.locator('[data-testid="rules-new"]').click();
        const form = '[data-testid="rules-new-form"]';
        await page.locator(`${form} [data-testid="rules-edit-text"]`).fill('keep secrets out');
        await page
          .locator(`${form} [data-testid="rules-edit-enforcement"] [data-value="ship"]`)
          .click();
        expect(await page.locator(`${form} [data-testid="rules-edit-check-by"]`).count()).toBe(0);
        expect(await page.locator(`${form} [data-testid="rules-edit-pattern-kind"]`).count()).toBe(
          0,
        );
        await page
          .locator(`${form} [data-testid="rules-edit-enforcement"] [data-value="action"]`)
          .click();
        await page
          .locator(`${form} [data-testid="rules-edit-check-by"] [data-value="pattern"]`)
          .click();
        await page
          .locator(`${form} [data-testid="rules-edit-pattern-kind"]`)
          .selectOption('path_deny');
        await page.locator(`${form} [data-testid="rules-edit-pattern-args"]`).fill('secrets/**');
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
        // The panel opens on the new item, where it now lives: To review.
        await page
          .locator(`[data-testid="rules-section-review"] [data-rule="${created?.id}"]`)
          .waitFor();
        await waitForAttr(
          page,
          `[data-testid="rules-detail"][data-rule="${created?.id}"] [data-testid="rules-pattern"]`,
          'title',
          `Blocks writes outside the node's own worktree, and to paths matching "secrets/**"`,
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
        const testButton = `[data-testid="rules-detail"][data-rule="${rule.id}"] [data-testid="rules-test"]`;

        page = await openPage();
        await page.goto(`${cockpit.base}/?view=rules`);
        await openKnowledgeItem(page, rule.id);
        await page.locator(testButton).waitFor();
        expect(await page.locator(testButton).isDisabled()).toBe(true);

        await page.locator('[data-view="settings"]').click();
        // T367: Settings is in sections; the key is under Classifier.
        await page.locator('[data-testid="settings-nav-classifier"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'No key');
        await page.locator('[data-testid="settings-key-input"]').fill(fakeKey);
        await page.locator('[data-testid="settings-key-save"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'Key set');
        expect(await page.locator('[data-testid="settings-key-input"]').inputValue()).toBe('');
        expect(await page.content()).not.toContain(fakeKey);

        await page.locator('[data-view="rules"]').click();
        await openKnowledgeItem(page, rule.id);
        await page.locator(testButton).waitFor();
        await waitUntilAsync('Test examples to be enabled', async () =>
          page ? !(await page.locator(testButton).isDisabled()) : false,
        );

        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-nav-classifier"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'Key set');
        // Removing a key you can't see again asks first.
        await page.locator('[data-testid="settings-key-remove"]').click();
        await page.locator('[data-testid="settings-key-remove-dialog-confirm"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'No key');
        await page.locator('[data-view="rules"]').click();
        await openKnowledgeItem(page, rule.id);
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

  browserTest(
    'T326: Settings sets a Jira token write-only; the screen shows "set" and never the token',
    async () => {
      const token = 'fake-t326-jira-token-4455';
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        // T367: the section rides in the URL.
        await page.goto(`${cockpit.base}/?view=settings&section=trackers`);
        await waitForText(page, '[data-testid="settings-tracker-jira-status"]', 'No token');
        await page
          .locator('[data-testid="settings-tracker-jira-base-url"]')
          .fill('https://shop.atlassian.net');
        await page.locator('[data-testid="settings-tracker-jira-email"]').fill('p@example.com');
        await page.locator('[data-testid="settings-tracker-jira-token"]').fill(token);
        await page.locator('[data-testid="settings-tracker-jira-save"]').click();
        await waitForText(page, '[data-testid="settings-tracker-jira-status"]', 'Token set');
        expect(await page.locator('[data-testid="settings-tracker-jira-token"]').inputValue()).toBe(
          '',
        );
        expect(await page.content()).not.toContain(token);

        // A reload reads the status back from the daemon: still "set", still no token
        // (and the URL brings back the Trackers section).
        await page.reload();
        await waitForText(page, '[data-testid="settings-tracker-jira-status"]', 'Token set');
        expect(
          await page.locator('[data-testid="settings-tracker-jira-base-url"]').inputValue(),
        ).toBe('https://shop.atlassian.net');
        expect(await page.content()).not.toContain(token);
        expect(readFileSync(join(cockpit.home, 'config.yaml'), 'utf8')).toContain(token);

        await page.locator('[data-testid="settings-tracker-jira-clear"]').click();
        await page.locator('[data-testid="settings-tracker-jira-clear-dialog-confirm"]').click();
        await waitForText(page, '[data-testid="settings-tracker-jira-status"]', 'No token');
        expect(readFileSync(join(cockpit.home, 'config.yaml'), 'utf8')).not.toContain(token);
        expect(readFileSync(join(cockpit.home, 'log', 'events.jsonl'), 'utf8')).not.toContain(
          token,
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
  /** T340: the streams the Delivery panel's Check now asked about (a stand-in for `PrPoller.pollNow`). */
  prChecks: string[];
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
  // T344: plans as the daemon wires them: an approval (or "Start parts anyway") starts parts.
  const contracts = new ContractService({ store, streams });
  const plans = new PlanService({
    store,
    streams,
    contracts,
    start: (id) => attach.startWithPending(id),
  });
  const inbox = new InboxService({ streams, questions, gates, rules, plans, contracts });
  const prChecks: string[] = [];
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
    prCheck: async (id) => {
      prChecks.push(id);
      return streams.get(id);
    },
    attach,
    repoInPlace: new RepoInPlaceService(store, streams, {
      attach: (id) => attach.attach(id),
      stop: (id) => attach.stop(id),
    }),
    plans,
    contracts,
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
    prChecks,
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

        // ---- answer. T364: the node page's card has no input of its own (its
        // composer answers, T363), so this answers from Needs me and comes back.
        // T363 re-points this step at the node page's composer.
        expect(await page.locator(`${card} [data-testid="answer-input"]`).count()).toBe(0);
        await page.locator('[data-view="inbox"]').click();
        const listed = `[data-testid="inbox"] [data-id="${questionId}"]`;
        await page.locator(`${listed} [data-testid="answer-input"]`).fill('semicolon');
        await page.locator(`${listed} [data-testid="answer-send"]`).click();
        await page.locator(listed).waitFor({ state: 'detached' });
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
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
        await page.locator('[data-testid="settings-nav-agents"]').click();
        const home = (suffix: string) => `[data-testid="settings-session-home${suffix}"]`;
        const contains = async (selector: string, text: string) =>
          waitUntilAsync(`${selector} to contain ${text}`, async () =>
            ((await page?.locator(selector).first().textContent()) ?? '').includes(text),
          );
        // T164: a Global default card, then Per repository, one card per repo (T367).
        await contains(home(''), 'Global default');
        await contains('[data-testid="settings-session-repos-heading"]', 'Per repository');
        await contains(
          '[data-testid="settings-session-repos-heading"]',
          'overrides the global default',
        );
        await contains('[data-testid="settings-session-repo-demo"]', 'demo');
        await contains('[data-testid="settings-session-repo-demo-resolved"]', 'claude');
        await waitForText(page, home('-resolved'), 'claude · claude-opus-5-5 · low effort');
        await page.locator(home('-field-model')).fill('claude-sonnet-4-6');
        await page.locator(home('-field-effort')).selectOption('high');
        await page.locator(home('-save')).click();
        await waitForText(page, home('-resolved'), 'claude · claude-sonnet-4-6 · high effort');
        await waitForText(page, home('-saved'), 'Saved');
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
        for (const action of ['close', 'mark-landed', 'pr-check']) {
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

describe('an open PR on the Delivery panel (Playwright e2e, T340)', () => {
  browserTest(
    'a PR open shows its status, Open PR and Check now, never Merge; a merge seen by the poll shows Landed',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const worktree = join(cockpit.repo, '.worktrees', 's-pr');
        git(['worktree', 'add', '-q', '-b', 's-pr', worktree, 'main'], cockpit.repo);
        writeFileSync(join(worktree, 'pr.txt'), 'pr\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'pr'], worktree);
        const stream = await cockpit.streams.create('human', {
          title: 'pr node',
          goal: 'g',
          repo: 'demo',
        });
        const url = 'https://github.example/acme/shop/pull/2';
        const pr = {
          number: 2,
          url,
          head: 's-pr',
          base: 'main',
          state: 'open' as const,
          draft: false,
          review: 'review_requested' as const,
          checks: 'passing' as const,
          mergeable: 'clean' as const,
          auto_merge: 'enabled' as const,
          last_seen: {},
          polled_at: new Date().toISOString(),
        };
        const at = new Date().toISOString();
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-pr',
          worktree,
          delivery_state: { mode: 'pr', status: 'pr_open', pr, at },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'pr');
        expect(await page.locator('[data-testid="land-before"]').textContent()).toContain(
          'PR #2 into main: review requested · CI passing · auto-merge enabled',
        );
        expect(await page.locator('[data-testid="stream-pr-link"]').getAttribute('href')).toBe(url);
        expect(await page.locator('[data-testid="stream-land"]').count()).toBe(0);

        await page.locator('[data-testid="stream-pr-check"]').click();
        const deadline = Date.now() + 10_000;
        while (cockpit.prChecks.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(cockpit.prChecks).toEqual([stream.id]);

        // The poll sees the merge (auto-merge on GitHub): the panel follows.
        await cockpit.streams.update('daemon', stream.id, {
          delivery_state: { mode: 'pr', status: 'merged', pr: { ...pr, state: 'merged' }, at },
          human: { status: 'landed' },
        });
        await cockpit.streams.appendThread('daemon', stream.id, {
          kind: 'event',
          body: 'PR #2 merged',
        });
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'landed');
        expect(await page.locator('[data-testid="stream-pr-check"]').count()).toBe(0);
        expect(await page.locator('[data-testid="stream-land"]').count()).toBe(0);
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

describe('delivery result tone and PR state (Playwright e2e, T338)', () => {
  browserTest(
    'a pushed PR reads as success with a clickable URL; an open PR shows review, checks and auto-merge',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'pr node',
          goal: 'g',
          repo: 'demo',
        });
        const url = 'https://github.com/o/demo/pull/2';
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-pr',
          delivery_state: {
            mode: 'pr',
            status: 'pr_open',
            at: new Date().toISOString(),
            pr: {
              number: 2,
              url,
              head: 'abc',
              base: 'main',
              state: 'open',
              draft: false,
              review: 'review_requested',
              checks: 'pending',
              mergeable: 'clean',
              auto_merge: 'enabled',
              last_seen: {},
              polled_at: new Date().toISOString(),
            },
          },
        });
        // T340: with the PR open there is no Merge; the push result is pinned on a node
        // before its first deliver.
        const fresh = await cockpit.streams.create('human', {
          title: 'pushing node',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.update('daemon', fresh.id, { branch: 's-fresh' });
        page = await openPage();
        // The land call itself is the daemon's (T224); this pins how its PR outcome reads.
        await page.route(`**/api/streams/${fresh.id}/land`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'pr_open',
              target: 'main',
              pr: { number: 2, url },
              line: `pushed s-pr, opened PR #2 into main: ${url}`,
            }),
          }),
        );
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page
          .locator('[data-testid="land-before"]', { hasText: 'review requested' })
          .waitFor();
        const prLine = (await page.locator('[data-testid="land-before"]').textContent()) ?? '';
        expect(prLine).toContain('CI pending');
        expect(prLine).toContain('auto-merge enabled');
        expect(await page.locator('[data-testid="stream-pr-link"]').getAttribute('href')).toBe(url);
        // T341: the open PR reads once on the panel, not on a second line too.
        expect(await page.locator('[data-testid="delivery-pr"]').count()).toBe(0);

        expect(await page.locator('[data-testid="stream-land"]').count()).toBe(0);

        await page.locator(`[data-testid="stream-tree"] [data-stream="${fresh.id}"]`).click();
        await page.locator('[data-testid="stream-land"]').click();
        await waitForAttr(page, '[data-testid="land-result"]', 'data-status', 'pr_open');
        const result = page.locator('[data-testid="land-result"]');
        expect(await result.getAttribute('class')).toContain('ok');
        expect(await result.getAttribute('class')).not.toContain('bad');
        const link = result.locator(`a[href="${url}"]`);
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Merge wording and hold tone (Playwright e2e, T347)', () => {
  browserTest(
    'the Needs me card for finished work says Merge; a hold reads neutral, a refusal red',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'finished node',
          goal: 'g',
          repo: 'demo',
        });
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-finished',
          agent: { status: 'done' },
        });
        page = await openPage();
        // The land call itself is the daemon's; these pin how a hold and a refusal read.
        const outcomes = [
          {
            status: 'refused',
            reason: 'Every change has a test',
            line: 'delivery held by ship check tests-with-src: Every change has a test',
            held: true,
          },
          {
            status: 'refused',
            reason: 'landing denied at the land gate by human',
            line: 'landing denied at the land gate by human',
          },
        ];
        await page.route(`**/api/streams/${stream.id}/land`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(outcomes.shift()),
          }),
        );
        await page.goto(`${cockpit.base}/`);
        // D7: "Merge", as on the Delivery panel.
        const card = `[data-kind="done"][data-id="${stream.id}"]`;
        await page.locator(`${card} [data-testid="land"]`).waitFor();
        expect(await page.locator(`${card} [data-testid="land"]`).textContent()).toBe('Merge');
        expect(await page.locator(`${card} .kind`).textContent()).toContain('Ready to merge');
        expect(await page.locator(card).textContent()).not.toMatch(/\bland\b/i);

        // D9: a ship-check hold is news (neutral), a real refusal stays red.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator('[data-testid="stream-land"]').click();
        const result = page.locator('[data-testid="land-result"]');
        await result.filter({ hasText: 'held by ship check' }).waitFor();
        expect(await result.getAttribute('class')).toContain('info');
        expect(await result.getAttribute('class')).not.toContain('bad');
        await page.locator('[data-testid="stream-land"]').click();
        await result.filter({ hasText: 'denied at the land gate' }).waitFor();
        expect(await result.getAttribute('class')).toContain('bad');
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
        // T366: and its panel is open on it: what it blocks, in words.
        await waitForAttr(
          page,
          `[data-testid="rules-detail"][data-rule="${rule.id}"] [data-testid="rules-pattern"]`,
          'title',
          'Blocks commands matching "rm -rf"',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('a long agent message collapses (Playwright e2e, T330)', () => {
  browserTest(
    'an agent line past ~12 lines renders collapsed with Show more / Show less',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'plan', goal: 'g' });
        const paragraphs = Array.from(
          { length: 30 },
          (_, i) => `Paragraph ${i}: the plan keeps going across both repos.`,
        );
        const body = `${paragraphs.join('\n\n')}\n\nLONG-TAIL-MARKER`;
        expect(body.length).toBeGreaterThan(1600);
        await cockpit.store.appendThreadEntry(stream.id, {
          ts: new Date().toISOString(),
          by: 'agent:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          kind: 'line',
          body,
        });
        await cockpit.store.appendThreadEntry(stream.id, {
          ts: new Date().toISOString(),
          by: 'agent:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          kind: 'line',
          body: 'a short one',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        const long = page.locator('[data-testid="thread-entry"]', { hasText: 'Paragraph 0' });
        await long.waitFor({ state: 'visible' });
        // One entry, the whole text in it.
        expect(await long.count()).toBe(1);
        expect(await long.textContent()).toContain('LONG-TAIL-MARKER');
        const toggle = long.locator('[data-testid="thread-expand"]');
        expect(await toggle.textContent()).toBe('Show more');
        const bodyBox = long.locator('[data-testid="thread-body"]');
        const clipped = () => bodyBox.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
        expect(await clipped()).toBe(true);

        await toggle.click();
        expect(await toggle.textContent()).toBe('Show less');
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        expect(await clipped()).toBe(false);
        await toggle.click();
        expect(await toggle.textContent()).toBe('Show more');
        expect(await clipped()).toBe(true);

        // A short entry has no toggle.
        const short = page.locator('[data-testid="thread-entry"]', { hasText: 'a short one' });
        expect(await short.locator('[data-testid="thread-expand"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T350: ended sessions collapse ------------------------------------------

describe('ended sessions collapse (Playwright e2e, T350)', () => {
  browserTest(
    '8 ended coordinator sessions fold into one row that expands; the live one stays shown',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', { title: 'waking', goal: 'g' });
        const coordinator = (status: 'stopped' | 'idle') => ({
          id: ulid(),
          vendor: 'claude',
          model: 'm',
          role: 'coordinator' as const,
          status,
        });
        const ended = Array.from({ length: 8 }, () => coordinator('stopped'));
        const live = coordinator('idle');
        await cockpit.store.updateStream('daemon', stream.id, (before) => ({
          ...before,
          sessions: [...ended, live],
        }));

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        const sessions = page.locator('[data-testid="sessions"]');
        const earlier = sessions.locator('[data-testid="sessions-earlier"]');
        await earlier.waitFor();
        // Collapsed: the live session plus one row for the eight ended ones.
        expect(await earlier.textContent()).toBe('8 earlier sessions');
        expect(await earlier.getAttribute('aria-expanded')).toBe('false');
        expect(await sessions.locator('li').count()).toBe(2);
        const rows = sessions.locator('[data-testid="session"]');
        expect(await rows.count()).toBe(1);
        expect(await rows.first().getAttribute('title')).toBe(live.id);
        expect(await rows.first().getAttribute('data-status')).toBe('idle');

        // Expanded: all eight show, and the live one is still there.
        await earlier.click();
        expect(await earlier.getAttribute('aria-expanded')).toBe('true');
        await sessions.locator('[data-testid="session"][data-status="stopped"]').nth(7).waitFor();
        expect(
          await sessions.locator('[data-testid="session"][data-status="stopped"]').count(),
        ).toBe(8);
        expect(await rows.count()).toBe(9);
        expect(await sessions.locator(`[data-testid="session"][title="${live.id}"]`).count()).toBe(
          1,
        );

        // Collapses again.
        await earlier.click();
        expect(await rows.count()).toBe(1);
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
        expect(await page.locator(`${card} .kind`).textContent()).toContain('Decision proposed');

        // The Knowledge screen separates by kind (T366: tabs) and filters by enforcement.
        await page.locator('[data-view="rules"]').click();
        await page.locator('[data-testid="rules-screen"] h1', { hasText: 'Knowledge' }).waitFor();
        await waitForCount(page, '[data-testid="rules-row"]', 2);
        await page.locator('[data-testid="rules-tab-decision"]').click();
        const row = `[data-testid="rules-row"][data-rule="${decision.id}"]`;
        await page.locator(`[data-testid="rules-section-review"] ${row}`).waitFor();
        await waitUntilAsync('the Decisions tab to show the decision alone', async () =>
          page ? (await page.locator('[data-testid="rules-row"]').count()) === 1 : false,
        );
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
    'New node with just a title makes a node with no repo and opens its page',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        // T208: the only project is where a new node files when nothing is open.
        const shop = await cockpit.projects.create({ name: 'shop' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });

        // T360: quick capture is gone; New node with a title alone does the same.
        await page.locator('[data-testid="new-stream-open"]').click();
        // T365: nothing to ask: the only project is implied, and the agent starts by default.
        expect(await page.locator('[data-testid="new-stream-project"]').count()).toBe(0);
        expect(await page.locator('[data-testid="new-stream-start"]').isChecked()).toBe(true);
        await page
          .locator('[data-testid="new-stream-title"]')
          .fill('why is the nightly export slow?');
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-title"]').press('Enter');

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
        await page.locator('[data-testid="stream-filter"]').focus();
        await page.keyboard.press('n');
        expect(await page.locator('[data-testid="new-stream"]').count()).toBe(0);
        await page.locator('[data-testid="stream-filter"]').fill('');
        await page.locator('[data-testid="stream-filter"]').blur();

        await page.keyboard.press('n');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="new-stream-title"]').fill('import CSV');
        await pickParent(page, parent.id);
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-create"]').click();

        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        await waitUntil('the child to exist', () => cockpit.streams.list().length === 3);
        const child = cockpit.streams.list().find((s) => s.parent === parent.id);
        expect(child?.title).toBe('import CSV');
        expect(child?.parent).toBe(parent.id);
        await page
          .locator(`[data-tree-node="${parent.id}"] > ul [data-stream="${child?.id}"]`)
          .waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T353: "New stream" shows the open node as its parent from its first render',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const epic = await cockpit.streams.create('human', {
          title: 'Tracker epic',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = page.locator('[data-testid="stream-tree"]');
        const row = tree.locator(`[data-stream="${epic.id}"]`);
        await row.waitFor({ state: 'visible' });
        const dialog = page.locator('[data-testid="new-stream"]');
        // T365: Parent is a picker; the button names the choice and carries its id.
        const picked = page.locator('[data-testid="new-stream-parent"]');
        for (let i = 0; i < 5; i++) {
          // The last opening had no parent (nothing open)…
          await page.locator('[data-view="inbox"]').click();
          await page.locator('[data-testid="new-stream-open"]').click();
          expect(await picked.getAttribute('data-value')).toBe('');
          expect(await picked.textContent()).toBe('Top level of shop');
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          // …so this one, read at once, must already show the open node, not that stale "none".
          await row.locator('.title').first().click();
          await page.locator('[data-testid="stream-title"]', { hasText: 'Tracker epic' }).waitFor();
          await page.locator('[data-testid="new-stream-open"]').click();
          expect(await picked.getAttribute('data-value')).toBe(epic.id);
          expect(await picked.textContent()).toBe('Tracker epic');
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
        }
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

describe('add a repo from Settings (Playwright e2e, T206, T367)', () => {
  browserTest(
    'fixtures/demo-project registers from Settings and shows in the New stream repo picker; a folder that is not a repo says so',
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
        // Looks like a repo to the folder picker (a `.git` entry), but git says no.
        const fake = join(scratch, 'fake');
        mkdirSync(fake);
        writeFileSync(join(fake, '.git'), '');

        // T365: New node needs a project to file into.
        await cockpit.projects.create({ name: 'shop' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-nav-repos"]').click();
        await page.locator('[data-testid="settings-repos-empty"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="settings-repo-add"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
        const path = page.locator('[data-testid="settings-repo-add-path"]');
        const status = '[data-testid="add-repo-status"]';
        const add = page.locator('[data-testid="settings-repo-add-save"]');

        // A folder inside a repo is not one; the dialog says so and offers the repo.
        await path.fill(join(repo, 'src'));
        await waitForText(
          page,
          status,
          'This folder isn’t a git repository. It’s inside demo-project, which is. Use demo-project',
        );
        expect(await add.isDisabled()).toBe(true);
        const missing = join(scratch, 'nope');
        await path.fill(missing);
        await waitForText(page, status, 'No folder named “nope” here.');
        expect(await add.isDisabled()).toBe(true);
        await path.fill(join(scratch, 'no-such-dir', 'x'));
        await waitForText(page, status, `No such folder: ${join(scratch, 'no-such-dir')}`);

        // The daemon's own refusal shows inline, without its RPC prefix.
        await path.fill(fake);
        await waitForText(page, status, 'fake is a git repository.');
        await add.click();
        await waitForText(
          page,
          '[data-testid="settings-repo-add-error"]',
          `${fake} is not a git repository`,
        );
        expect(cockpit.store.getRepos()).toEqual({});

        await path.fill(join(repo, 'src'));
        await page.locator('[data-testid="add-repo-use-parent"]').click();
        await waitForText(page, status, 'demo-project is a git repository.');
        expect(await page.locator('[data-testid="settings-repo-add-name"]').inputValue()).toBe(
          'demo-project',
        );
        expect(await page.locator('[data-testid="settings-repo-add-error"]').count()).toBe(0);
        await page.locator('[data-testid="settings-repo-add-protected"]').fill('master, release');
        await add.click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        await waitForText(page, '[data-testid="settings-repo-demo-project-main"]', 'master');
        await page
          .locator(
            '[data-testid="settings-repo-demo-project"] [data-testid="repo-icon"][data-kind="local"]',
          )
          .waitFor({ state: 'visible' });
        expect(cockpit.store.getRepos()['demo-project']?.protected_branches).toEqual([
          'master',
          'release',
        ]);

        await page.keyboard.press('n');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        // T365: the Repository picker lists it, with its host's icon.
        await page.locator('[data-testid="new-stream-repo"]').click();
        const option = page.locator(
          '[data-testid="new-stream-repo-option"][data-repo="demo-project"]',
        );
        await option.waitFor({ state: 'visible' });
        expect(await option.locator('[data-testid="repo-icon"]').getAttribute('data-kind')).toBe(
          'local',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T367: add a repo by browsing to it, and find it again from the keyboard',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'agile-repo-browse-e2e-'));
      const userHome = join(scratch, 'home');
      const shop = join(userHome, 'Projects', 'shop');
      mkdirSync(join(userHome, 'Projects', 'notes'), { recursive: true });
      mkdirSync(shop, { recursive: true });
      git(['init', '-q', '-b', 'main'], shop);
      git(
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=T',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        shop,
      );
      const cockpit = await startCockpit({ userHome });
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=repos`);
        await page.locator('[data-testid="settings-repo-add"]').click();
        const browser = '[data-testid="add-repo-browser"]';
        const dir = (name: string) =>
          `${browser} [data-testid="add-repo-dir"][data-name="${name}"]`;
        // It opens on home; a folder opens with a double-click.
        await page.locator(`${browser}[data-path="${userHome}"]`).waitFor({ state: 'visible' });
        await page.locator(dir('Projects')).dblclick();
        await page
          .locator(`${browser}[data-path="${join(userHome, 'Projects')}"]`)
          .waitFor({ state: 'visible' });
        // Repositories are marked; other folders are there but greyed.
        expect(await page.locator(dir('shop')).getAttribute('data-git')).toBe('true');
        expect(await page.locator(dir('notes')).getAttribute('data-git')).toBe('false');
        expect(await page.locator('[data-testid="settings-repo-add-path"]').inputValue()).toBe(
          '~/Projects/',
        );
        await page.locator(dir('shop')).click();
        await waitForText(page, '[data-testid="add-repo-status"]', 'shop is a git repository.');
        expect(await page.locator('[data-testid="settings-repo-add-name"]').inputValue()).toBe(
          'shop',
        );
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        const row = '[data-testid="settings-repo-shop"]';
        await page.locator(`${row} [data-testid="repo-icon"][data-kind="local"]`).waitFor();
        await waitForText(page, '[data-testid="settings-repo-shop-kind"]', 'Local only');
        await waitForText(page, '[data-testid="settings-repo-shop-path"]', '~/Projects/shop');
        expect(cockpit.store.getRepos().shop?.path).toBe(realpathSync(shop));

        // The path field autocompletes: Tab completes, the arrows choose, Enter opens.
        await page.locator('[data-testid="settings-repo-add"]').click();
        const path = page.locator('[data-testid="settings-repo-add-path"]');
        await path.fill('~/Pro');
        // The matches for `Pro` are in (the list is not loading), then Tab completes.
        const settled = `${browser}:not([data-loading])`;
        await page
          .locator(`${settled} [data-testid="add-repo-dir"][data-name="Projects"]`)
          .waitFor();
        await path.press('Tab');
        await page
          .locator(`${browser}[data-path="${join(userHome, 'Projects')}"]`)
          .waitFor({ state: 'visible' });
        expect(await path.inputValue()).toBe('~/Projects/');
        await path.press('ArrowDown');
        await path.press('ArrowDown');
        await path.press('Enter');
        await page.locator(`${browser}[data-path="${shop}"]`).waitFor({ state: 'visible' });
        await waitForText(page, '[data-testid="add-repo-status"]', 'Already added as shop.');
        expect(await page.locator('[data-testid="settings-repo-add-save"]').isDisabled()).toBe(
          true,
        );
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T367: clone from a local bare repo, and see it listed with its icon',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'agile-repo-clone-e2e-'));
      const userHome = join(scratch, 'home');
      mkdirSync(join(userHome, 'Projects'), { recursive: true });
      const work = join(scratch, 'work');
      mkdirSync(work);
      git(['init', '-q', '-b', 'main'], work);
      writeFileSync(join(work, 'README.md'), '# ledger\n');
      git(['add', '-A'], work);
      git(
        ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
        work,
      );
      const bare = join(scratch, 'remote', 'ledger.git');
      mkdirSync(join(scratch, 'remote'));
      git(['clone', '-q', '--bare', work, bare], scratch);
      const cockpit = await startCockpit({ userHome });
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=repos`);
        await page.locator('[data-testid="settings-repo-add"]').click();
        await page.locator('[data-testid="add-repo-mode-clone"]').click();
        await page.locator('[data-testid="add-repo-clone-url"]').fill(bare);
        // The preview reads the URL the way the daemon will: a repo on this machine, "ledger".
        const preview = '[data-testid="add-repo-clone-preview"]';
        await page.locator(`${preview}[data-protocol="file"]`).waitFor({ state: 'visible' });
        expect(await page.locator(preview).textContent()).toContain('ledger');
        expect(await page.locator('[data-testid="add-repo-clone-name"]').inputValue()).toBe(
          'ledger',
        );
        // With nothing registered, it clones into ~/Projects.
        await waitForText(
          page,
          '[data-testid="add-repo-clone-target"]',
          'Creates ~/Projects/ledger',
        );
        await page.locator('[data-testid="add-repo-clone-submit"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        const row = '[data-testid="settings-repo-ledger"]';
        await page.locator(row).waitFor({ state: 'visible' });
        // Its origin is the bare repo: a remote, reached as a file path.
        await page
          .locator(`${row} [data-testid="repo-icon"][data-kind="other"][data-protocol="file"]`)
          .waitFor({ state: 'visible' });
        await waitForText(page, '[data-testid="settings-repo-ledger-path"]', '~/Projects/ledger');
        const cloned = join(userHome, 'Projects', 'ledger');
        expect(cockpit.store.getRepos().ledger?.path).toBe(realpathSync(cloned));
        expect(readFileSync(join(cloned, 'README.md'), 'utf8')).toBe('# ledger\n');
        await page
          .locator('[data-testid="toast"]', { hasText: 'Cloned and added ledger' })
          .waitFor();

        // Again: the name is taken now, so the dialog says so before git runs.
        await page.locator('[data-testid="settings-repo-add"]').click();
        await page.locator('[data-testid="add-repo-mode-clone"]').click();
        await page.locator('[data-testid="add-repo-clone-url"]').fill(bare);
        await waitForText(
          page,
          '[data-testid="add-repo-clone-target"]',
          'A repository named ledger is already registered. Pick another name.',
        );
        expect(await page.locator('[data-testid="add-repo-clone-submit"]').isDisabled()).toBe(true);
        // Under another name, into a folder that is already there: the daemon refuses, readably.
        await page.locator('[data-testid="add-repo-clone-name"]').fill('ledger-copy');
        await waitForText(
          page,
          '[data-testid="add-repo-clone-target"]',
          'Creates ~/Projects/ledger-copy',
        );
        mkdirSync(join(userHome, 'Projects', 'ledger-copy', 'taken'), { recursive: true });
        await page.locator('[data-testid="add-repo-clone-submit"]').click();
        const error = page.locator('[data-testid="add-repo-clone-error"]');
        await error.waitFor({ state: 'visible' });
        expect(await error.textContent()).toContain('already exists and is not empty');
        expect(await error.textContent()).toContain('Pick another name or destination folder.');
        expect(cockpit.store.getRepos()['ledger-copy']).toBeUndefined();
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T367: a URL typed or pasted into the folder field switches to cloning',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=repos`);
        await page.locator('[data-testid="settings-repo-add"]').click();
        const mode = (m: string) =>
          `[data-testid="add-repo-mode"] [data-value="${m}"][aria-checked="true"]`;
        await page.locator(mode('local')).waitFor();
        await page
          .locator('[data-testid="settings-repo-add-path"]')
          .fill('git@github.com:acme/api.git');
        await page.locator(mode('clone')).waitFor();
        await page.locator('[data-testid="add-repo-switched"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="add-repo-clone-url"]').inputValue()).toBe(
          'git@github.com:acme/api.git',
        );
        const preview = '[data-testid="add-repo-clone-preview"]';
        await page.locator(`${preview}[data-kind="github"][data-protocol="ssh"]`).waitFor();
        expect(await page.locator(`${preview} .cr-ar-preview-text`).textContent()).toBe(
          'acme/apiGitHub · SSH',
        );
        // The URL field has the focus: typing goes on in it.
        expect(
          (await page.evaluate('document.activeElement?.dataset?.testid ?? null')) as string,
        ).toBe('add-repo-clone-url');

        // Back to a folder; a pasted GitHub owner/repo switches too.
        await page.locator('[data-testid="add-repo-mode-local"]').click();
        await page.locator(mode('local')).waitFor();
        // A real paste event (the daemon's tsconfig has no DOM types: reach them through globalThis).
        await page.locator('[data-testid="settings-repo-add-path"]').evaluate((el: unknown) => {
          const g = globalThis as unknown as {
            DataTransfer: new () => { setData(type: string, value: string): void };
            ClipboardEvent: new (type: string, init: Record<string, unknown>) => unknown;
          };
          const data = new g.DataTransfer();
          data.setData('text/plain', 'acme/shop');
          const paste = new g.ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          });
          (el as { dispatchEvent(event: unknown): boolean }).dispatchEvent(paste);
        });
        await page.locator(mode('clone')).waitFor();
        expect(await page.locator('[data-testid="add-repo-clone-url"]').inputValue()).toBe(
          'acme/shop',
        );
        await page.locator(`${preview}[data-kind="github"][data-protocol="https"]`).waitFor();
        // Not a URL at all: said under the field, and nothing to clone.
        await page.locator('[data-testid="add-repo-clone-url"]').fill('ftp://example.com/x');
        await page.locator(preview).waitFor({ state: 'detached' });
        expect(await page.locator('[data-testid="add-repo-clone-submit"]').isDisabled()).toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Settings sections (Playwright e2e, T367)', () => {
  browserTest(
    'General picks the theme and names the daemon; the section is in the URL; Permissions says who decides',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings`);
        await page.locator('[data-testid="settings"][data-section="general"]').waitFor();
        await waitForText(page, '[data-testid="settings-daemon-status"]', 'Connected');
        const theme = async () =>
          (await page?.evaluate('document.documentElement.getAttribute("data-theme")')) as
            | string
            | null;
        await page.locator('[data-testid="settings-theme-dark"]').click();
        expect(await theme()).toBe('dark');
        // A per-browser choice: it survives a reload.
        await page.reload();
        await page
          .locator('[data-testid="settings-theme-dark"][aria-checked="true"]')
          .waitFor({ state: 'visible' });
        expect(await theme()).toBe('dark');
        await page.locator('[data-testid="settings-theme-system"]').click();
        expect(await theme()).toBe(null);

        await page.locator('[data-testid="settings-nav-permissions"]').click();
        await page.locator('[data-testid="settings"][data-section="permissions"]').waitFor();
        await waitUntilAsync('the URL to name the section', async () =>
          (page?.url() ?? '').includes('section=permissions'),
        );
        expect(await page.locator('[data-gate]').count()).toBe(3);
        expect(await page.locator('[data-gate="land"]').textContent()).toContain('You');
        // Back to General: its section needs no parameter.
        await page.locator('[data-testid="settings-nav-general"]').click();
        await waitUntilAsync(
          'the section parameter to go',
          async () => !(page?.url() ?? '').includes('section='),
        );
        expect(new URL(page.url()).searchParams.get('view')).toBe('settings');
      } finally {
        await teardown([page]);
        await cockpit.stop();
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
        await page.locator('[data-testid="settings-nav-repos"]').click();
        const row = '[data-testid="settings-repo-api"]';
        await page.locator(`${row}[data-delivery="direct"]`).waitFor({ state: 'visible' });
        // T367: the row says where the repo lives: GitHub, with its owner/name. (Not the
        // protocol: a git `insteadOf` in the environment may turn the SSH URL into https.)
        await page
          .locator(`${row} [data-testid="repo-icon"][data-kind="github"]`)
          .waitFor({ state: 'visible' });
        await waitUntilAsync('the row to name GitHub and acme/api', async () =>
          /^GitHub( · (SSH|HTTPS))? · acme\/api$/.test(
            (await page?.locator('[data-testid="settings-repo-api-kind"]').textContent()) ?? '',
          ),
        );
        // Auto-merge is a pull-request setting: not offered for direct delivery.
        expect(await page.locator('[data-testid="settings-repo-api-auto-merge"]').count()).toBe(0);

        const pr = '[data-testid="settings-repo-api-delivery"] [data-value="pr"]';
        await page.locator(pr).click();
        await waitForText(
          page,
          '[data-testid="settings-repo-api-error"]',
          'pr delivery needs GitHub auth — run `gh auth login` (see `agile daemon status`)',
        );
        expect(cockpit.store.getRepos().api?.delivery).toBe('direct');

        authed = true;
        await page.locator(pr).click();
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

        await page
          .locator('[data-testid="settings-repo-api-delivery"] [data-value="direct"]')
          .click();
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

describe('cockpit gaps (Playwright e2e, T338)', () => {
  browserTest(
    'New project with repos; Director autonomy and tracker on the root; New rule with a name and a picked scope; the event log',
    async () => {
      const cockpit = await startCockpit();
      const repo = mkdtempSync(join(tmpdir(), 'agile-gaps-e2e-'));
      let page: Page | undefined;
      try {
        git(['init', '-q', '-b', 'main'], repo);
        await cockpit.store.addRepo('api', { path: repo });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);

        // New project, with its repos ticked.
        await page.locator('[data-testid="new-project-open"]').click();
        await page.locator('[data-testid="new-project-name"]').fill('shop');
        await page.locator('[data-testid="new-project-repo"][data-repo="api"]').check();
        await page.locator('[data-testid="new-project-create"]').click();
        await waitUntil('the project to exist', () => cockpit.projects.list().length === 1);
        const shop = cockpit.projects.list()[0];
        if (!shop) throw new Error('shop missing');
        expect(shop.repos).toEqual(['api']);

        // The root's page: Director autonomy, and the project's tracker block.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="project-controls"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="project-repos"]').textContent()).toBe(
          'Repos: api',
        );
        await page.locator('[data-testid="director-autonomy-select"]').selectOption('organise');
        await waitUntil(
          'the Director level to be set',
          () => cockpit.projects.get(shop.id).autonomy.director === 'organise',
        );
        expect(cockpit.projects.get(shop.id).autonomy.coordinator).toBe('advise');
        await page.locator('[data-testid="project-tracker-system"]').selectOption('linear');
        await page.locator('[data-testid="project-tracker-push"]').check();
        await page.locator('[data-testid="project-tracker-map-done"]').fill('Shipped');
        await page.locator('[data-testid="project-tracker-save"]').click();
        await waitUntil(
          'the tracker to be set',
          () => cockpit.projects.get(shop.id).tracker !== undefined,
        );
        expect(cockpit.projects.get(shop.id).tracker).toEqual({
          system: 'linear',
          push_status: true,
          status_map: { done: 'Shipped' },
        });
        // Cross-origin writes are refused.
        const cross = await fetch(`${cockpit.base}/api/projects/${shop.id}`, {
          method: 'POST',
          headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
          body: JSON.stringify({ tracker: null }),
        });
        expect(cross.status).toBe(403);

        // Knowledge → Add knowledge: a Name, and the scope picked by name (no ids typed).
        await page.locator('[data-view="rules"]').click();
        await page.locator('[data-testid="rules-new"]').click();
        const form = '[data-testid="rules-new-form"]';
        await page.locator(`${form} [data-testid="rules-edit-name"]`).fill('money-in-cents');
        await page.locator(`${form} [data-testid="rules-edit-text"]`).fill('store money in cents');
        const scope = page.locator(`${form} [data-testid="rules-edit-scope"]`);
        expect(await scope.locator('option').allTextContents()).toContain('Project: shop');
        await scope.selectOption({ label: 'Project: shop' });
        await page.locator(`${form} [data-testid="rules-edit-save"]`).click();
        await page.locator(form).waitFor({ state: 'detached' });
        await waitUntil('the item to be stored', () =>
          cockpit.store.listKnowledge().some((r) => r.name === 'money-in-cents'),
        );
        const item = cockpit.store.listKnowledge().find((r) => r.name === 'money-in-cents');
        expect(item?.scope).toEqual({ kind: 'project', project: shop.id });
        // The list names the scope's project, not its id.
        await waitForText(
          page,
          `[data-testid="rules-row"][data-rule="${item?.id}"] [data-testid="rules-scope"]`,
          'Project shop',
        );

        // The event log: every routed event, subjects by title.
        const node = await cockpit.streams.create('human', {
          title: 'checkout',
          goal: 'g',
          project: shop.id,
        });
        const event = await routeAndEmit(
          cockpit.events,
          { type: 'human_line', subject: node.id, by: 'human', payload: { body: 'hi' } },
          cockpit.streams.list(),
        );
        await page.locator('[data-view="events"]').click();
        const row = `[data-testid="event-log"] [data-event="${event.id}"]`;
        await page.locator(row).waitFor({ state: 'visible' });
        const text = (await page.locator(row).textContent()) ?? '';
        expect(text).toContain('human line · checkout');
        expect(text).not.toContain(node.id);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('project tree and filter (Playwright e2e, T208, T365)', () => {
  browserTest(
    "two projects: each one's nodes show only under it; New project keeps All projects; Show only this project filters and the chip undoes it",
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
          .locator(`[data-tree-node="${shop.root}"] > ul [data-stream="${shopNode.id}"]`)
          .waitFor({ state: 'visible' });

        // "New project" from the rail: T365: the rail stays on All projects (it never
        // switches on its own) and the new project's root page opens.
        await page.locator('[data-testid="new-project-open"]').click();
        await page.locator('[data-testid="new-project-name"]').fill('docs');
        await page.locator('[data-testid="new-project-create"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'detached' });
        await waitUntil('the project to exist', () => cockpit.projects.list().length === 2);
        const docs = cockpit.projects.list().find((p) => p.name === 'docs');
        if (!docs) throw new Error('docs project missing');
        await page
          .locator(`[data-testid="stream-page"][data-stream="${docs.root}"]`)
          .waitFor({ state: 'visible' });
        await page.locator(`${tree} [data-stream="${docs.root}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${shopNode.id}"]`).count()).toBe(1);
        expect(await page.locator('[data-testid="project-filter"]').count()).toBe(0);
        expect(new URL(page.url()).searchParams.get('project')).toBeNull();

        // New node from the docs root files into docs (not the only/first project).
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-title"]').fill('write the guide');
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-create"]').click();
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

        // Show only this project (shop's ⋯): only shop's nodes, and a chip says so.
        await rowMenu(page, shop.root, 'tree-menu-only');
        await page.locator('[data-testid="project-filter"]', { hasText: 'shop' }).waitFor();
        await page
          .locator(`${tree} [data-stream="${captured?.id}"]`)
          .waitFor({ state: 'detached' });
        expect(await page.locator(`${tree} [data-stream="${shopNode.id}"]`).count()).toBe(1);
        expect(await page.locator(`${tree} [data-stream="${docs.root}"]`).count()).toBe(0);

        // The chip switches to another project…
        await page.locator('[data-testid="project-filter-switch"]').click();
        await page.locator('[data-testid="project-filter-option"]', { hasText: /^docs$/ }).click();
        await page.locator(`${tree} [data-stream="${captured?.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${shopNode.id}"]`).count()).toBe(0);

        // …and its × shows both projects' trees again.
        await page.locator('[data-testid="project-filter-clear"]').click();
        await page.locator(`${tree} [data-stream="${shopNode.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${captured?.id}"]`).count()).toBe(1);
        expect(await page.locator('[data-testid="project-filter"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('the open node and project filter live in the URL (Playwright e2e, T348)', () => {
  browserTest(
    'open a node, filter, reload: the same view; back returns to the previous node; a stale id falls back to the inbox',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const docs = await cockpit.projects.create({ name: 'docs' });
        const checkout = await cockpit.streams.create('human', {
          title: 'checkout',
          goal: 'g',
          project: shop.id,
        });
        const refunds = await cockpit.streams.create('human', {
          title: 'refunds',
          goal: 'g',
          project: shop.id,
        });
        const guide = await cockpit.streams.create('human', {
          title: 'guide',
          goal: 'g',
          project: docs.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        const pageOf = (id: string): string => `[data-testid="stream-page"][data-stream="${id}"]`;
        // T365: the filter is "Show only this project" in a project's ⋯, shown as a chip.
        const chip = page.locator('[data-testid="project-filter"]');

        // Open one node, then another, and filter to shop.
        await page.locator(`${tree} [data-stream="${checkout.id}"]`).click();
        await page.locator(pageOf(checkout.id)).waitFor({ state: 'visible' });
        await page.locator(`${tree} [data-stream="${refunds.id}"]`).click();
        await page.locator(pageOf(refunds.id)).waitFor({ state: 'visible' });
        await rowMenu(page, shop.root, 'tree-menu-only');
        await page.locator(`${tree} [data-stream="${guide.id}"]`).waitFor({ state: 'detached' });
        const search = new URL(page.url()).searchParams;
        expect(search.get('node')).toBe(refunds.id);
        expect(search.get('project')).toBe(shop.id);

        // Reload: the same node, the same filter.
        await page.reload();
        await page.locator(pageOf(refunds.id)).waitFor({ state: 'visible' });
        await chip.filter({ hasText: 'shop' }).waitFor({ state: 'visible' });
        await page.locator(`${tree} [data-stream="${checkout.id}"]`).waitFor({ state: 'visible' });
        expect(await page.locator(`${tree} [data-stream="${guide.id}"]`).count()).toBe(0);

        // Back: the previous node (the filter is not a history step). Forward again.
        await page.goBack();
        await page.locator(pageOf(checkout.id)).waitFor({ state: 'visible' });
        await page.goForward();
        await page.locator(pageOf(refunds.id)).waitFor({ state: 'visible' });

        // A shared link opens the same view in a fresh page.
        const shared = page.url();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
        await page.goto(shared);
        await page.locator(pageOf(refunds.id)).waitFor({ state: 'visible' });

        // A stale node and project quietly fall back to the inbox and "All".
        await page.goto(`${cockpit.base}/?node=01ARZ3NDEKTSV4RRFFQ69G5FAV&project=P-gone`);
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
        await page.locator(`${tree} [data-stream="${guide.id}"]`).waitFor({ state: 'visible' });
        expect(await chip.count()).toBe(0);
        expect(new URL(page.url()).search).toBe('');
        expect(await page.locator('[data-testid="stream-page"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('collapsing the rail (Playwright e2e, T331)', () => {
  browserTest(
    'a caret folds a subtree without navigating, the fold survives a reload, and a hidden question still shows',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const root = await cockpit.streams.create('human', { title: 'shop', goal: 'g' });
        const mid = await cockpit.streams.create('human', {
          title: 'ledger export',
          goal: 'g',
          parent: root.id,
        });
        const leaf = await cockpit.streams.create('human', {
          title: 'csv writer',
          goal: 'g',
          parent: mid.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        const rowOf = (id: string): string => `${tree} [data-stream="${id}"]`;
        const caretOf = (id: string): string =>
          `${tree} [data-tree-node="${id}"] > .cr-tree-item > [data-testid="tree-caret"]`;
        await page.locator(rowOf(leaf.id)).waitFor({ state: 'visible' });
        // Only nodes with children carry a caret.
        expect(await page.locator(caretOf(leaf.id)).count()).toBe(0);
        expect(await page.locator(caretOf(root.id)).getAttribute('aria-expanded')).toBe('true');

        // Collapse the root: its subtree goes, and the page stays on the inbox.
        await page.locator(caretOf(root.id)).click();
        await page.locator(rowOf(mid.id)).waitFor({ state: 'detached' });
        expect(await page.locator(rowOf(leaf.id)).count()).toBe(0);
        expect(await page.locator(caretOf(root.id)).getAttribute('aria-expanded')).toBe('false');
        expect(await page.locator('[data-testid="inbox-empty"]').isVisible()).toBe(true);
        expect(
          await page.locator(`${rowOf(root.id)} [data-testid="collapsed-needs-you"]`).count(),
        ).toBe(0);

        // A question deep inside the folded subtree shows on the folded row.
        await cockpit.questions.raise({
          stream: leaf.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'quote every field?',
        });
        await page
          .locator(`${rowOf(root.id)} [data-testid="collapsed-needs-you"]`)
          .waitFor({ state: 'visible' });

        // The fold survives a reload.
        await page.reload();
        await page.locator(rowOf(root.id)).waitFor({ state: 'visible' });
        await page
          .locator(`${rowOf(root.id)} [data-testid="collapsed-needs-you"]`)
          .waitFor({ state: 'visible' });
        expect(await page.locator(rowOf(mid.id)).count()).toBe(0);

        // Expand from the keyboard: the children come back, the marker goes.
        await page.locator(rowOf(root.id)).focus();
        await page.keyboard.press('ArrowRight');
        await page.locator(rowOf(leaf.id)).waitFor({ state: 'visible' });
        expect(
          await page.locator(`${rowOf(root.id)} [data-testid="collapsed-needs-you"]`).count(),
        ).toBe(0);

        // Double-clicking a row folds it too; the caret expands it again.
        await page.locator(rowOf(mid.id)).dblclick();
        await page.locator(rowOf(leaf.id)).waitFor({ state: 'detached' });
        await page.locator(caretOf(mid.id)).click();
        await page.locator(rowOf(leaf.id)).waitFor({ state: 'visible' });

        // Expanded state persists as well.
        await page.reload();
        await page.locator(rowOf(leaf.id)).waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('move a node by dragging it in the rail (Playwright e2e, T333)', () => {
  browserTest(
    'a drop moves the node and the rail re-nests it; a refused drop says why',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'shop' });
        const node = (title: string, parent?: string) =>
          cockpit.streams.create('human', {
            title,
            goal: 'g',
            ...(parent ? { parent, repo: 'api' } : { project: shop.id }),
          });
        const a = await node('prices');
        const b = await node('refunds');
        // A work node: a repo-less child would be a tangent (D33) and leave both conversations.
        const x = await node('api part', a.id);
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        const row = (id: string) => page?.locator(`${tree} [data-stream="${id}"]`);
        await page
          .locator(`[data-tree-node="${a.id}"] > ul [data-stream="${x.id}"]`)
          .waitFor({ state: 'visible' });
        expect(await row(a.id)?.getAttribute('data-role')).toBe('coordinating');
        expect(await row(b.id)?.getAttribute('data-role')).toBe('conversation');

        await row(x.id)?.dragTo(page.locator(`${tree} [data-stream="${b.id}"]`));
        await page
          .locator(`[data-tree-node="${b.id}"] > ul [data-stream="${x.id}"]`)
          .waitFor({ state: 'visible' });
        await waitUntil('the move to land', () => cockpit.streams.get(x.id).parent === b.id);
        await waitUntilAsync(
          'the roles to follow',
          async () =>
            (await row(b.id)?.getAttribute('data-role')) === 'coordinating' &&
            (await row(a.id)?.getAttribute('data-role')) === 'conversation',
        );

        // T365: a drop the rail itself refuses says why: into its own subtree…
        await row(b.id)?.dragTo(page.locator(`${tree} [data-stream="${x.id}"]`));
        await page
          .locator('[data-testid="toast"]', {
            hasText: '“refunds” can’t move under a node inside itself.',
          })
          .waitFor({ state: 'visible' });
        // …or into another project.
        const blog = await cockpit.projects.create({ name: 'blog' });
        await row(blog.root)?.waitFor({ state: 'visible' });
        await row(a.id)?.dragTo(page.locator(`${tree} [data-stream="${blog.root}"]`));
        await page
          .locator('[data-testid="toast"]', { hasText: 'Nodes can’t move between projects.' })
          .waitFor({ state: 'visible' });
        expect(cockpit.streams.get(b.id).parent).toBe(shop.root);
        expect(cockpit.streams.get(a.id).parent).toBe(shop.root);
        expect(await page.locator('[data-testid="move-error"]').count()).toBe(0);

        // refunds' plan awaits approval: dropping on the project is refused, and nothing moves.
        await cockpit.plans.write(b.id, [{ child: x.id, owns: ['api/**'] }]);
        await row(x.id)?.dragTo(page.locator(`${tree} [data-stream="${shop.root}"]`));
        await page.locator('[data-testid="move-error"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="move-error"]').textContent()).toContain(
          'awaiting approval',
        );
        expect(cockpit.streams.get(x.id).parent).toBe(b.id);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("the rail's row menus, Deleted and New project (Playwright e2e, T365)", () => {
  browserTest(
    'Delete asks, archives the subtree, leaves its open page, and Undo brings it back',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const a = await cockpit.streams.create('human', {
          title: 'checkout',
          goal: 'g',
          project: shop.id,
        });
        const b = await cockpit.streams.create('human', { title: 'cart', goal: 'g', parent: a.id });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${b.id}`);
        await page
          .locator(`[data-testid="stream-page"][data-stream="${b.id}"]`)
          .waitFor({ state: 'visible' });
        const tree = '[data-testid="stream-tree"]';

        // A project root has no Delete.
        await page
          .locator(
            `[data-tree-node="${shop.root}"] > .cr-tree-item [data-testid="tree-menu-trigger"]`,
          )
          .click();
        await page
          .locator('[data-testid="tree-menu"] [data-testid="tree-menu-settings"]')
          .waitFor();
        expect(await page.locator('[data-testid="tree-menu-delete"]').count()).toBe(0);
        await page.keyboard.press('Escape');

        await rowMenu(page, a.id, 'tree-menu-delete');
        const dialog = page.locator('[data-testid="delete-dialog"]');
        await dialog.waitFor({ state: 'visible' });
        expect(await dialog.locator('h2').textContent()).toBe(
          'Delete “checkout” and the node under it?',
        );
        expect(await dialog.textContent()).toContain('Branches and worktrees are kept');
        // Cancel keeps everything.
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        expect(cockpit.streams.get(a.id).archived).toBeUndefined();

        await rowMenu(page, a.id, 'tree-menu-delete');
        await page.locator('[data-testid="delete-dialog-confirm"]').click();
        await page.locator(`${tree} [data-stream="${a.id}"]`).waitFor({ state: 'detached' });
        expect(await page.locator(`${tree} [data-stream="${b.id}"]`).count()).toBe(0);
        await waitUntil('both archived', () => cockpit.streams.get(b.id).archived === true);
        // The open node went with it: back to Needs me.
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'detached' });
        expect(new URL(page.url()).searchParams.get('node')).toBeNull();

        const toast = page.locator('[data-testid="toast"]', { hasText: 'Deleted “checkout”' });
        await toast.waitFor({ state: 'visible' });
        await toast.locator('[data-testid="toast-action"]').click();
        await page.locator(`${tree} [data-stream="${a.id}"]`).waitFor({ state: 'visible' });
        await page.locator(`${tree} [data-stream="${b.id}"]`).waitFor({ state: 'visible' });
        expect(cockpit.streams.get(a.id).archived).toBeUndefined();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'Deleted (n) lists what Delete archived, and Restore brings it back',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const a = await cockpit.streams.create('human', {
          title: 'refunds',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${a.id}"]`).waitFor();
        // Nothing deleted: no section.
        expect(await page.locator('[data-testid="deleted-nodes"]').count()).toBe(0);

        await rowMenu(page, a.id, 'tree-menu-delete');
        await page.locator('[data-testid="delete-dialog-confirm"]').click();
        const toggle = page.locator('[data-testid="deleted-toggle"]');
        await toggle.waitFor({ state: 'visible' });
        expect(await toggle.textContent()).toBe('Deleted1');
        // Folded by default.
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        await toggle.click();
        const archived = page.locator(`[data-testid="archived-row"][data-stream="${a.id}"]`);
        await archived.waitFor({ state: 'visible' });
        expect(await archived.textContent()).toContain('refunds');

        await archived.locator('[data-testid="archived-restore"]').click();
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${a.id}"]`)
          .waitFor({ state: 'visible' });
        await page.locator('[data-testid="deleted-nodes"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="toast"]', { hasText: 'Restored “refunds”' }).waitFor();
        expect(cockpit.streams.get(a.id).archived).toBeUndefined();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'Rename (the menu, or F2), Move to…, the row +, right-click, and the arrow keys',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const a = await cockpit.streams.create('human', {
          title: 'prices',
          goal: 'g',
          project: shop.id,
        });
        const b = await cockpit.streams.create('human', {
          title: 'refunds',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        const row = (id: string) => page?.locator(`${tree} [data-stream="${id}"]`);
        await row(a.id)?.waitFor({ state: 'visible' });

        // Rename from the menu.
        await rowMenu(page, a.id, 'tree-menu-rename');
        const input = page.locator('[data-testid="rename-input"]');
        expect(await input.inputValue()).toBe('prices');
        await input.fill('pricing page');
        await page.locator('[data-testid="rename-save"]').click();
        await page.locator('[data-testid="rename-dialog"]').waitFor({ state: 'detached' });
        await waitForText(page, `${tree} [data-stream="${a.id}"] .title`, 'pricing page');
        expect(cockpit.streams.get(a.id)).toMatchObject({ title: 'pricing page', goal: 'g' });

        // F2 on a focused row; Escape cancels.
        await row(b.id)?.focus();
        await page.keyboard.press('F2');
        await page.locator('[data-testid="rename-dialog"]').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="rename-dialog"]').waitFor({ state: 'detached' });

        // Move to…: the valid parents only (not itself), then the tree re-nests.
        await rowMenu(page, b.id, 'tree-menu-move');
        const options = page.locator('[data-testid="move-target-option"]');
        await options.first().waitFor({ state: 'visible' });
        expect(
          await options.evaluateAll((els) => els.map((el) => el.getAttribute('data-node'))),
        ).toEqual([shop.root, a.id]);
        // Its current parent is marked and can't be picked.
        expect(
          await page
            .locator(`[data-testid="move-target-option"][data-node="${shop.root}"]`)
            .isDisabled(),
        ).toBe(true);
        await page.locator(`[data-testid="move-target-option"][data-node="${a.id}"]`).click();
        await page.locator('[data-testid="move-save"]').click();
        await page
          .locator(`[data-tree-node="${a.id}"] > ul [data-stream="${b.id}"]`)
          .waitFor({ state: 'visible' });
        expect(cockpit.streams.get(b.id).parent).toBe(a.id);

        // The row's + opens New node under it.
        await row(b.id)?.hover();
        await page
          .locator(`[data-tree-node="${b.id}"] > .cr-tree-item [data-testid="tree-add"]`)
          .click();
        await waitForAttr(page, '[data-testid="new-stream-parent"]', 'data-value', b.id);
        expect(await page.locator('[data-testid="new-stream"]').textContent()).toContain('In shop');
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });

        // Right-click opens the same menu.
        await row(a.id)?.click({ button: 'right' });
        await page.locator('[data-testid="tree-menu"] [data-testid="tree-menu-rename"]').waitFor();
        await page.keyboard.press('Escape');

        // One tab stop; the arrows walk the rows, Left goes to the parent, Enter opens.
        await row(shop.root)?.focus();
        expect(await row(shop.root)?.getAttribute('tabindex')).toBe('0');
        expect(await row(a.id)?.getAttribute('tabindex')).toBe('-1');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        expect(
          (await page.evaluate('document.activeElement?.dataset?.stream ?? null')) as string,
        ).toBe(b.id);
        await page.keyboard.press('ArrowLeft');
        expect(
          (await page.evaluate('document.activeElement?.dataset?.stream ?? null')) as string,
        ).toBe(a.id);
        await page.keyboard.press('Enter');
        await page
          .locator(`[data-testid="stream-page"][data-stream="${a.id}"]`)
          .waitFor({ state: 'visible' });

        // The open node is never hidden in a folded subtree: opening it unfolds its parents.
        await page
          .locator(`[data-tree-node="${a.id}"] > .cr-tree-item > [data-testid="tree-caret"]`)
          .click();
        await row(b.id)?.waitFor({ state: 'detached' });
        await page.goto(`${cockpit.base}/?node=${b.id}`);
        await row(b.id)?.waitFor({ state: 'visible' });
        expect(await row(b.id)?.getAttribute('aria-current')).toBe('true');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'New project: repositories as a checklist with host icons; two chosen; All projects kept; its root opens',
    async () => {
      const cockpit = await startCockpit();
      const scratch = mkdtempSync(join(tmpdir(), 'agile-new-project-e2e-'));
      let page: Page | undefined;
      try {
        const api = join(scratch, 'api');
        const web = join(scratch, 'web');
        const docs = join(scratch, 'docs');
        for (const dir of [api, web, docs]) {
          mkdirSync(dir);
          git(['init', '-q', '-b', 'main'], dir);
        }
        git(['remote', 'add', 'origin', 'https://github.com/acme/web.git'], web);
        await cockpit.store.addRepo('api', { path: api });
        await cockpit.store.addRepo('web', { path: web });
        await cockpit.store.addRepo('docs', { path: docs });
        const existing = await cockpit.projects.create({ name: 'blog' });
        page = await openPage();
        // Filtered to blog when New project opens: the new project must still show.
        await page.goto(`${cockpit.base}/?project=${existing.id}`);
        await page.locator('[data-testid="project-filter"]', { hasText: 'blog' }).waitFor();

        await page.locator('[data-testid="new-project-open"]').click();
        const list = page.locator('[data-testid="new-project-repos"]');
        await list.locator('[data-testid="new-project-repo"][data-repo="web"]').waitFor();
        // One row per repo, top to bottom, each with its host's icon and where it lives.
        expect(
          await list
            .locator('[data-testid="new-project-repo"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-repo'))),
        ).toEqual(['api', 'docs', 'web']);
        const webRow = list.locator('label', { has: page.locator('[data-repo="web"]') });
        expect(await webRow.locator('[data-testid="repo-icon"]').getAttribute('data-kind')).toBe(
          'github',
        );
        expect(await webRow.textContent()).toContain('GitHub · HTTPS');
        const apiRow = list.locator('label', { has: page.locator('[data-repo="api"]') });
        expect(await apiRow.locator('[data-testid="repo-icon"]').getAttribute('data-kind')).toBe(
          'local',
        );
        expect(await apiRow.textContent()).toContain(api);
        const boxes = await list.locator('[data-testid="new-project-repo"]').first().boundingBox();
        const last = await list.locator('[data-testid="new-project-repo"]').last().boundingBox();
        // Vertical: the rows stack, one above the other.
        expect((last?.y ?? 0) > (boxes?.y ?? 0) + 20).toBe(true);
        expect(Math.abs((last?.x ?? 0) - (boxes?.x ?? 0))).toBeLessThan(2);

        await page.locator('[data-testid="new-project-name"]').fill('shop');
        await list.locator('[data-testid="new-project-repo"][data-repo="api"]').check();
        await list.locator('[data-testid="new-project-repo"][data-repo="web"]').check();
        await page.locator('[data-testid="new-project-create"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'detached' });
        await waitUntil('the project to exist', () => cockpit.projects.list().length === 2);
        const shop = cockpit.projects.list().find((p) => p.name === 'shop');
        expect(shop?.repos).toEqual(['api', 'web']);
        // Its root opens; the rail shows All projects (both roots), with no chip.
        await page
          .locator(`[data-testid="stream-page"][data-stream="${shop?.root}"]`)
          .waitFor({ state: 'visible' });
        await page.locator('[data-testid="project-filter"]').waitFor({ state: 'detached' });
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${existing.root}"]`)
          .waitFor();
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop?.root}"]`).waitFor();
        expect(new URL(page.url()).searchParams.get('project')).toBeNull();
        await page.locator('[data-testid="toast"]', { hasText: 'Project shop created' }).waitFor();

        // New node from its root lists its repos first.
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-repo"]').click();
        expect(
          await page
            .locator('[data-testid="new-stream-repo-option"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-repo'))),
        ).toEqual(['', 'api', 'web', 'docs']);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'the rail marks a node whose agent never ran, and the legend explains every dot',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        // No projects: the rail says what to do.
        await page.locator('[data-testid="tree-empty"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="tree-empty-new-project"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');

        const shop = await cockpit.projects.create({ name: 'shop' });
        const idle = await cockpit.streams.create('human', {
          title: 'research pricing',
          goal: 'g',
          project: shop.id,
        });
        const row = page.locator(`[data-testid="stream-tree"] [data-stream="${idle.id}"]`);
        await row.waitFor({ state: 'visible' });
        expect(await row.getAttribute('data-status')).toBe('not_started');
        expect(await row.locator('.cr-dot').getAttribute('aria-label')).toBe('Not started');
        expect(await row.getAttribute('title')).toContain('Not started');

        await page.locator('[data-testid="tree-legend-open"]').click();
        const legend = page.locator('[data-testid="tree-legend"]');
        await legend.locator('.cr-legend-body').waitFor({ state: 'visible' });
        const text = (await legend.textContent()) ?? '';
        for (const label of ['Needs you', 'Ready to merge', 'Working', 'Not started', 'Stopped']) {
          expect(text).toContain(label);
        }
        expect(
          await legend.locator('[data-status="not_started"] .cr-dot').getAttribute('data-status'),
        ).toBe('not_started');
        await page.keyboard.press('Escape');
        await legend.waitFor({ state: 'detached' });
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
        // T365: the goal leads; its first line is the title.
        await page
          .locator('[data-testid="new-stream-goal"]')
          .fill('import CSV\nBank exports, with a header row.');
        expect(await page.locator('[data-testid="new-stream-title"]').inputValue()).toBe(
          'import CSV',
        );
        await pickRepo(page, 'demo');
        expect(await page.locator('[data-testid="new-stream"]').textContent()).toContain(
          'Work: writes code on its own branch in demo',
        );
        // T365: the agent starts by default, and the dialog names the model it will use.
        expect(await page.locator('[data-testid="new-stream-start"]').isChecked()).toBe(true);
        await waitForText(
          page,
          '[data-testid="new-stream-model"]',
          'claude-opus-5-5 · claude · low effortChange',
        );
        // Cmd/Ctrl+Enter in the goal creates it.
        await page.locator('[data-testid="new-stream-goal"]').press('Control+Enter');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });

        const created = cockpit.streams.list().find((x) => x.title === 'import CSV');
        expect(created?.goal).toBe('import CSV\nBank exports, with a header row.');
        expect(created?.repo).toBe('demo');
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
    "T365: New node's Change starts the agent with the picked effort",
    async () => {
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        page = await openPage();
        const traffic = recordTraffic(page);
        await page.goto(`${cockpit.base}/`);
        // From the project's root page: a node at its top level.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-goal"]').fill('tidy the README');
        await page.locator('[data-testid="new-stream-model-change"]').click();
        await page.locator('[data-testid="new-stream-session-effort"]').selectOption('high');
        await waitForText(
          page,
          '[data-testid="new-stream-model"]',
          'claude-opus-5-5 · claude · high effort',
        );
        await page.locator('[data-testid="new-stream-create"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });
        const created = cockpit.streams.list().find((x) => x.title === 'tidy the README');
        await waitForRunningWorker(page, cockpit, created?.id ?? '', traffic);
        const sessions = cockpit.streams.get(created?.id ?? '').sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ role: 'worker', effort: 'high' });
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
    'New node with its agent switched off files a node and starts no session',
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
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-title"]').fill('why is export slow?');
        // T365: "Start the agent now" is on by default; off is the old Start later.
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        expect(await page.locator('[data-testid="new-stream-model"]').textContent()).toContain(
          'Start its agent from its page',
        );
        await page.locator('[data-testid="new-stream-create"]').click();
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

        // T336: once the node has had a coordinator, the split's parts wait for its plan.
        await cockpit.store.updateStream('daemon', node.id, (before) => ({
          ...before,
          sessions: [
            { id: ulid(), vendor: 'claude', model: 'm', role: 'coordinator', status: 'stopped' },
          ],
        }));
        // The split writes this on each part when the node has a coordinator (repo-in-place.ts).
        for (const part of parts) {
          await cockpit.streams.appendThread('daemon', part.id, {
            kind: 'event',
            body: `${WAITING_FOR_PLAN}this part starts when "Sale prices"'s plan is approved`,
          });
        }
        for (const part of parts) {
          await page
            .locator(
              `[data-testid="stream-tree"] [data-stream="${part.id}"] [data-testid="waiting-for-plan"]`,
            )
            .waitFor();
        }
        // T347 (D36 D11): the badge sits under the title, which is not cut off.
        for (const part of parts) {
          const row = `[data-testid="stream-tree"] [data-stream="${part.id}"]`;
          const title = await page.locator(`${row} .title`).boundingBox();
          const badge = await page.locator(`${row} [data-testid="waiting-for-plan"]`).boundingBox();
          expect(badge && title ? badge.y >= title.y + title.height - 1 : false).toBe(true);
          expect(
            await page.locator(`${row} .title`).evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        }
        await page.locator(`[data-testid="stream-tree"] [data-stream="${parts[0]?.id}"]`).click();
        await page
          .locator('[data-testid="stream-status"]', { hasText: 'waiting for the plan' })
          .waitFor();
        // T347 (D36 D12): the split's "read it by id" pointer is for the agent, not this view.
        await page.locator('[data-testid="thread"]', { hasText: 'waiting for the plan' }).waitFor();
        expect(await page.locator('[data-testid="thread"]').textContent()).not.toContain(
          'read it by id',
        );
        expect(
          cockpit.streams
            .readThread(parts[0]?.id as string, { limit: 50 })
            .entries.some((e) => e.agent_only === true && e.body.endsWith('read it by id')),
        ).toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('waiting for the plan (Playwright e2e, T344)', () => {
  browserTest(
    'parts wait on a stopped coordinator: a card with Wake coordinator and Start parts anyway',
    async () => {
      const hang: FakeAgentScript = { steps: [{ type: 'hang' }] };
      // The coordinator (Wake), then the two parts (Start parts anyway).
      const cockpit = await startStreamCockpit([hang, hang, hang]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'Sale prices',
          goal: 'g',
          project: shop.id,
        });
        const parts = [];
        for (const repo of ['demo', 'web']) {
          parts.push(
            await cockpit.streams.create('human', {
              title: `${repo} part`,
              goal: 'g',
              project: shop.id,
              parent: node.id,
              repo,
            }),
          );
        }
        // The coordinator ended its turn without a plan; the split made the parts wait.
        await cockpit.store.updateStream('daemon', node.id, (before) => ({
          ...before,
          sessions: [
            { id: ulid(), vendor: 'claude', model: 'm', role: 'coordinator', status: 'stopped' },
          ],
        }));
        for (const part of parts) {
          await cockpit.streams.appendThread('daemon', part.id, {
            kind: 'event',
            body: `${WAITING_FOR_PLAN}this part starts when "Sale prices"'s plan is approved`,
          });
        }

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-kind="plan_waiting"][data-id="${node.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} .kind`).textContent()).toContain('Waiting for the plan');
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'demo part, web part wait for the plan',
        );

        // Wake coordinator: the node's coordinator runs, and the card goes while it does.
        await page.locator(`${card} [data-testid="plan-wake"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        const woken = cockpit.streams.get(node.id).sessions.at(-1);
        expect(woken?.role).toBe('coordinator');
        expect(woken?.status).not.toBe('stopped');

        // Stopped again with no plan: the card is back.
        await cockpit.attach.stop(node.id, undefined, { detach: true });
        await page.locator(card).waitFor({ state: 'visible' });

        // Start parts anyway: both parts get their worker, and the card goes.
        await page.locator(`${card} [data-testid="plan-start-parts"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        for (const part of parts) {
          await waitUntil(`${part.title} started`, () =>
            cockpit.streams.get(part.id).sessions.some((s) => s.role === 'worker'),
          );
        }

        // A part that ran and was detached is not waiting again: the card stays gone.
        const first = parts[0] as (typeof parts)[number];
        await cockpit.attach.stop(first.id, undefined, { detach: true });
        await waitUntil(
          'the part detached',
          () => cockpit.streams.get(first.id).agent.status === 'idle',
        );
        await page.locator('[data-testid="inbox"]').waitFor();
        await Bun.sleep(300);
        expect(await page.locator(card).count()).toBe(0);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${first.id}"]`).waitFor();
        expect(
          await page
            .locator(
              `[data-testid="stream-tree"] [data-stream="${first.id}"] [data-testid="waiting-for-plan"]`,
            )
            .count(),
        ).toBe(0);
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

        // T349: a child waiting on your answer reads "question" with the amber dot…
        await cards.refresh(
          await cockpit.streams.update('daemon', api.id, { agent: { status: 'question' } }),
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale?' });
        await waitForAttr(page, card, 'data-state', 'question');
        await waitForText(page, `${card} [data-testid="status-card-state"]`, 'question');
        await waitForAttr(page, `${card} [data-testid="status-card-dot"]`, 'data-dot', 'amber');
        // …and a real block still reads "blocked", with no needs-you dot.
        await cards.refresh(
          await cockpit.streams.update('daemon', api.id, { agent: { status: 'blocked' } }),
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale.' });
        await waitForAttr(page, card, 'data-state', 'blocked');
        expect(await page.locator(`${card} [data-testid="status-card-dot"]`).count()).toBe(0);
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

describe('a direct merge reads "merged" (Playwright e2e, T347)', () => {
  browserTest(
    'Activity and Repos call a direct merge "merged" and a PR merge "pr merged"',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const node = (title: string) =>
          cockpit.streams.create('human', { title, goal: 'g', project: shop.id, repo: 'api' });
        const direct = await node('api: direct change');
        const viaPr = await node('api: pr change');
        const emit = (subject: string, payload: Record<string, unknown>) =>
          routeAndEmit(
            cockpit.events,
            { type: 'pr_merged', subject, repo: 'api', payload, by: 'daemon' },
            cockpit.streams.list(),
          );
        const merged = await emit(direct.id, { repo: 'api', sha: 'abc123' });
        const prMerged = await emit(viaPr.id, { pr: 4, repo: 'api', sha: 'def456' });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${direct.id}"]`).click();
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        const row = `[data-testid="activity"] [data-event="${merged.id}"]`;
        await waitForText(page, `${row} [data-testid="activity-because"]`, 'self');
        expect(await page.locator(`${row} [data-testid="activity-type"]`).textContent()).toBe(
          'merged',
        );

        await page.locator('[data-view="repos"]').click();
        const repoEvent = (id: string) =>
          `[data-testid="repo-view"] [data-repo="api"] [data-event="${id}"]`;
        await waitForText(page, repoEvent(merged.id), 'merged · api: direct change');
        expect(await page.locator(repoEvent(merged.id)).textContent()).not.toContain('pr merged');
        await waitForText(page, repoEvent(prMerged.id), 'pr merged · api: pr change');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('conversation tangents (Playwright e2e, T332)', () => {
  browserTest(
    "Branch off a line makes a seeded tangent; its finished summary reaches the parent's thread",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const talk = await cockpit.streams.create('human', {
          title: 'Why are prices slow?',
          goal: 'g',
          project: shop.id,
        });
        await cockpit.streams.appendThread('human', talk.id, {
          kind: 'line',
          body: 'TANGENT-SEED is it the cache?',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${talk.id}"]`).click();
        const line = page.locator('[data-testid="thread-entry"]', { hasText: 'TANGENT-SEED' });
        await line.locator('[data-testid="branch-off"]').click();
        await page.locator('[data-testid="branch-question"]').fill('Does the cache help?');
        await page.locator('[data-testid="branch-start"]').click();

        // The tangent opens: a conversation child, its thread starting with the quoted line.
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'Branched off Why are prices slow?' })
          .first()
          .waitFor();
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'TANGENT-SEED is it the cache?' })
          .first()
          .waitFor();
        const tangent = cockpit.streams.list().find((s) => s.parent === talk.id);
        expect(tangent?.goal).toBe('Does the cache help?');
        expect(tangent?.title).toBe('Does the cache help?');
        expect(tangent?.repo).toBeUndefined();
        const rows = () => cockpit.streams.list();
        const roleOf = (id: string) =>
          nodeRole(cockpit.streams.get(id), liveChildrenOf(id, rows()), rows());
        expect(roleOf(talk.id)).toBe('conversation');

        // The tangent finishes: its last agent line goes to the parent, quoted.
        const producing: StreamService = new StreamService(cockpit.store, {
          onUpdated: (before, after): Promise<void> =>
            emitTransitions(makeEmitter(cockpit.events, producing), producing)(before, after),
        });
        const id = tangent?.id as string;
        await producing.appendThread(
          'agent',
          id,
          { kind: 'line', body: 'TANGENT-SUMMARY yes, it halves p95' },
          ulid(),
        );
        await producing.update('daemon', id, { agent: { status: 'done' } });

        await page.locator(`[data-testid="stream-tree"] [data-stream="${talk.id}"]`).click();
        await page
          .locator('[data-testid="thread-entry"]', {
            hasText: 'tangent finished: Does the cache help?',
          })
          .first()
          .waitFor();
        await page
          .locator('[data-testid="thread-entry"]', {
            hasText: 'TANGENT-SUMMARY yes, it halves p95',
          })
          .first()
          .waitFor();
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        await page
          .locator('[data-testid="activity-type"]', { hasText: 'tangent summary' })
          .waitFor();
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
        // T338: labelled parts: an Owners heading listing parts by title, each contract under "Contract".
        const planText = (await page.locator('[data-testid="plan"]').textContent()) ?? '';
        expect(planText).toContain('Owners');
        expect(planText).not.toContain(api.id);
        const owner = `[data-testid="plan-owner"][data-child="${api.id}"]`;
        expect(await page.locator(`${owner} a[data-node="${api.id}"]`).textContent()).toBe(
          'api: add salePrice',
        );
        expect(await page.locator(`${owner} [data-testid="plan-owner-paths"]`).textContent()).toBe(
          'prices.ts',
        );
        const c = `[data-contract="${contract.id}"]`;
        expect(await page.locator(`${c} h3`).textContent()).toContain('Contract: GET /price/:id');
        expect(await page.locator(`${c} [data-testid="contract-parties"]`).textContent()).toBe(
          'Parties: api: add salePrice, web: show salePrice',
        );
        await page.locator(`${c} a[data-node="${web.id}"]`).click();
        await waitForText(page, '[data-testid="stream-title"]', 'web: show salePrice');

        // T338 (render-time names): an id in thread text reads as the node's title and opens it;
        // a contract id reads as its title; a URL is a new-tab link. The stored line keeps the ids.
        await cockpit.streams.appendThread('daemon', web.id, {
          kind: 'event',
          body: `waits on ${api.id}; relies on ${contract.id}; see https://example.com/pr/2`,
        });
        const line = '[data-testid="thread"] [data-testid="thread-entry"]:last-child';
        await waitForText(page, `${line} a[data-node="${api.id}"]`, 'api: add salePrice');
        expect(await page.locator(`${line} a[data-node="${node.id}"]`).textContent()).toBe(
          'GET /price/:id',
        );
        expect(
          await page.locator(`${line} a[href="https://example.com/pr/2"]`).getAttribute('rel'),
        ).toBe('noopener noreferrer');
        expect(await page.locator(line).textContent()).not.toContain(api.id);
        await page.locator(`${line} a[data-node="${api.id}"]`).click();
        await waitForText(page, '[data-testid="stream-title"]', 'api: add salePrice');
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
        // T347: the parts have a repo, so the node is coordinating (not a conversation).
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const child = (title: string) =>
          cockpit.streams.create('human', {
            title,
            goal: 'g',
            project: shop.id,
            parent: node.id,
            repo: 'api',
          });
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

        // T347 (D36 D6): a work node has no coordinator, so no picker; the root has one.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${api.id}"]`).click();
        await page
          .locator('[data-testid="stream-title"]', { hasText: 'api: add salePrice' })
          .waitFor();
        expect(await page.locator('[data-testid="autonomy"]').count()).toBe(0);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="stream-title"]', { hasText: 'Shop' }).waitFor();
        await page.locator('[data-testid="autonomy"]').waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('tracker link field (Playwright e2e, T321)', () => {
  browserTest(
    'Link on the stream page pulls the goal from the (fake) issue; Unlink clears it',
    async () => {
      const linear = await startFakeLinear();
      linear.addIssue({
        key: 'SHOP-11',
        title: 'Show sale prices',
        description: 'AC: struck through',
      });
      const cockpit = await startCockpit({
        trackerLinks: (streams) =>
          new TrackerLinks({
            streams,
            configured: () => ['linear'],
            tracker: () => createLinear({ api_url: linear.apiUrl, token: linear.token }),
          }),
      });
      let page: Page | undefined;
      try {
        // T347 (D36 D1): the field shows only in a project with a tracker, behind "Tracker issue…".
        const blog = await cockpit.projects.create({ name: 'Blog' });
        const plain = await cockpit.streams.create('human', {
          title: 'Draft',
          goal: 'tbd',
          project: blog.id,
        });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        await cockpit.projects.update(shop.id, {
          tracker: { system: 'linear', push_status: false },
        });
        const node = await cockpit.streams.create('human', {
          title: 'Sale',
          goal: 'tbd',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${plain.id}"]`).click();
        await page.locator('[data-testid="stream-title"]', { hasText: 'Draft' }).waitFor();
        await page.locator('[data-testid="link-wait"]', { hasText: 'Waits on…' }).waitFor();
        expect(await page.locator('[data-testid="tracker-link-open"]').count()).toBe(0);
        expect(await page.locator('[data-testid="tracker-link-form"]').count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Link', exact: true }).count()).toBe(0);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page
          .locator('[data-testid="tracker-link-open"]', { hasText: 'Tracker issue…' })
          .click();
        await page.locator('[data-testid="tracker-link-input"]').fill('SHOP-11');
        await page.locator('[data-testid="tracker-link-form"] button[type="submit"]').click();
        await page.locator('[data-testid="tracker-link"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="tracker-link"]').textContent()).toContain(
          'SHOP-11',
        );
        expect(cockpit.streams.get(node.id).goal).toContain('AC: struck through');
        expect(await page.content()).not.toContain(linear.token);
        await page.locator('[data-testid="tracker-unlink"]').click();
        await page.locator('[data-testid="tracker-link-form"]').waitFor({ state: 'visible' });
        expect(cockpit.streams.get(node.id).external_link).toBeUndefined();
      } finally {
        await teardown([page]);
        await cockpit.stop();
        linear.stop();
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

describe('the Director draft tree (Playwright e2e, T301)', () => {
  browserTest(
    'at Advise a draft renders as a tree; Create builds it',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const out = await cockpit.autonomy.act('director', 'director', 'agent:test', {
          action: 'create_tree',
          tree: {
            project: shop.id,
            title: 'Show sale prices',
            goal: 'sale prices on product pages',
            parts: [
              { title: 'api: add salePrice', goal: 'expose it' },
              { title: 'web: show salePrice', goal: 'render it', after: [0] },
            ],
          },
        });
        expect(out.applied).toBe(false);
        const id = out.applied ? '' : out.proposal.id;

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="director"]').click();
        const card = `[data-testid="director-proposal"][data-id="${id}"]`;
        await page.locator(`${card} [data-testid="director-draft-tree"]`).waitFor();
        expect(await page.locator(`${card} [data-testid="director-draft-part"]`).count()).toBe(2);
        expect(
          await page.locator(`${card} [data-testid="director-draft-part"]`).nth(1).textContent(),
        ).toContain('waits on api: add salePrice');
        await page.locator(`${card} [data-testid="director-create"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });

        const node = cockpit.streams.list().find((s) => s.title === 'Show sale prices');
        expect(node?.parent).toBe(shop.root);
        const parts = cockpit.streams.list().filter((s) => s.parent === node?.id);
        expect(parts.map((p) => p.title).sort()).toEqual([
          'api: add salePrice',
          'web: show salePrice',
        ]);
        expect(cockpit.autonomy.get(id).status).toBe('applied');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});
