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
  type AgentId,
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type Question,
  type KnowledgeItem as Rule,
  SEND_UP_MAX_CHARS,
  START_ON_GOAL,
  type Stream,
  classifierQuestion,
  examplesOf,
  liveChildrenOf,
  nodeRole,
  patternOf,
  repoProposalRef,
  ulid,
  validateClassifierConfig,
} from '@agile-agents/shared';
import {
  type Browser,
  type Page,
  type WebSocketRoute,
  type Worker,
  chromium,
} from 'playwright-core';
import { AttachService, VerbService } from '../attach';
import { Bus } from '../bus';
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
import { HookService } from '../hook';
import { type HttpServerHandle, startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { KnowledgeService, type RuleRpcEvalDeps, ensureBuiltinKnowledge } from '../knowledge';
import { startFakeLinear } from '../trackers/fake-linear';
import { createLinear } from '../trackers/linear';
import { TrackerLinks } from '../trackers/link';

/** Proposals the home migration carried over from a seed import are batched under this source. */
const SEED_PROVENANCE = 'migration';
import { ProjectService } from '../projects';
import { QuestionService } from '../questions';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { buildEvent } from '../store/events';
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
  /** `page.route` never sees what the service worker fetches: block it where a test stubs the daemon. */
  serviceWorkers?: 'block';
  /** T388: permissions the page's context starts with (`['notifications']`). */
  permissions?: string[];
  /**
   * T470: Needs me shows rows, each expanding to its card. The tests that
   * act on cards start with "Expand all" on (a per-browser setting of the
   * app); the T470 test passes `false` for the rows as a new browser has them.
   */
  inboxExpandAll?: boolean;
}): Promise<Page> {
  const { inboxExpandAll = true, ...pageOptions } = options ?? {};
  const acquired = await acquireBrowserPage({
    label: 'control-room e2e',
    cached: sharedBrowser,
    launch: () => chromium.launch({ executablePath }),
    openPage: (browser) => browser.newPage(pageOptions),
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
  if (inboxExpandAll) {
    await acquired.page.addInitScript(() => {
      try {
        localStorage.setItem('agile.inbox.expandAll', '1');
      } catch {
        // No storage: the rows stay folded.
      }
    });
  }
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

/** T423: a select's chosen option, as it reads. */
async function selectedText(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate(
      (el) =>
        (el as unknown as { selectedOptions: ArrayLike<{ textContent: string | null }> })
          .selectedOptions[0]?.textContent ?? '',
    );
}

/** T423: the model list's checked row (`<testid>`) and its effort, as the picker shows them. */
async function pickedModel(
  page: Page,
  testid: string,
): Promise<{ vendor: string; model: string; effort: string; label: string } | undefined> {
  const row = page.locator(
    `[data-testid="${testid}"] [data-testid="model-option"][aria-checked="true"]`,
  );
  // The list fills in once the session defaults arrive (a fetch after the dialog opens):
  // wait for the pick, as a reader would, rather than read the empty first render.
  await row
    .first()
    .waitFor({ state: 'attached', timeout: POLL_DEADLINE_MS })
    .catch(() => {});
  if ((await row.count()) === 0) return undefined;
  const effort = page.locator(`[data-testid="${testid}-effort"] [aria-checked="true"]`);
  return {
    vendor: (await row.getAttribute('data-vendor')) ?? '',
    model: (await row.getAttribute('data-model')) ?? '',
    effort: (await effort.count()) > 0 ? ((await effort.getAttribute('data-value')) ?? '') : '',
    label: (await row.textContent()) ?? '',
  };
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

/**
 * T416: the header's Merge. The first Merge in a browser asks "Merge <node>
 * into <target>?" (finding 38); this answers Merge without ticking "Don't
 * ask again", so every click in a test asks and is answered the same way.
 */
async function clickMerge(page: Page): Promise<void> {
  await page.locator('[data-testid="stream-land"]').click();
  await page.locator('[data-testid="merge-confirm"]').waitFor();
  await page.locator('[data-testid="merge-confirm-confirm"]').click();
  await page.locator('[data-testid="merge-confirm"]').waitFor({ state: 'detached' });
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
  const events = new RoutedEventService(store);
  // T446: an applied change is recorded as an `autonomy_applied` event, as the daemon wires it.
  const autonomy = new AutonomyService({
    store,
    streams,
    plans,
    contracts,
    emit: makeEmitter(events, streams),
  });
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
        // The row names the stream by its full path (§3.2); T416: one separator, "›", everywhere.
        expect(
          await page
            .locator(
              `[data-testid="inbox-row"][data-item="${question.id}"] [data-testid="inbox-subject"]`,
            )
            .textContent(),
        ).toBe('ledger-lite › import CSV › parser');
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
        // T363: nothing inside the node's page is wider than it either (the main column clips).
        expect(
          await page
            .locator('[data-testid="stream-page"]')
            .evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(0);

        // T364: the node page's question card has no input of its own;
        // T363: the page's composer answers it.
        expect(await page.locator(`${card} [data-testid="answer-input"]`).count()).toBe(0);
        await page.locator('[data-testid="composer-answering"]').waitFor();
        await page.locator('[data-testid="composer-input"]').fill('main');
        await page.locator('[data-testid="composer-send"]').click();
        await page.locator(card).waitFor({ state: 'detached' });
        // T360: the views live in the drawer at phone width.
        await page.locator('[data-testid="rail-toggle"]').click();
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

        // j focuses the first card; Enter opens its node. Both cards are on
        // `pricing`, ordered by time and then id: raised in the same
        // millisecond (a fast runner), the gate's `HIL-` id sorts first.
        const order = await page
          .locator('[data-testid="inbox"] .cr-card')
          .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-id') ?? ''));
        expect([...order].sort()).toEqual([written.id, gate.id].sort());
        const [first = '', second = ''] = order;
        await page.locator('[data-testid="inbox"] h1').click();
        await page.keyboard.press('j');
        const focused = async (id: string): Promise<boolean> =>
          (await page?.evaluate<boolean>(
            `document.activeElement?.getAttribute('data-item') === ${JSON.stringify(id)}`,
          )) === true;
        await waitUntilAsync('j to focus the first card', () => focused(first));
        await page.keyboard.press('j');
        await waitUntilAsync('j to move to the next card', () => focused(second));
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
        // T445 (audit r7 #10): Add a repository opens its dialog here, over Needs me.
        await page.locator('[data-testid="setup-repo"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
        expect(await page.locator(empty).isVisible()).toBe(true);
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
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
        ).toContain('3 proposed knowledge items imported from the old rules');

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
        // T426: Save as proposal keeps it for review (Add would apply it at once).
        await page.locator(`${form} [data-testid="rules-edit-propose"]`).click();
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
    'T454: Accepted decisions — the Jev switch needs the key, then saves on change',
    async () => {
      const cockpit = await startCockpit({ classifierKey: true });
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=classifier`);
        const toggle = page.locator('[data-testid="settings-knowledge-wake-switch"]');
        await waitForText(page, '[data-testid="settings-key-status"]', 'No key');
        await waitForText(
          page,
          '[data-testid="settings-knowledge-wake-note"]',
          'Needs the TypeSafe key above.',
        );
        expect(await toggle.isDisabled()).toBe(true);

        await page.locator('[data-testid="settings-key-input"]').fill('fake-t454-playwright-key');
        await page.locator('[data-testid="settings-key-save"]').click();
        await waitForText(page, '[data-testid="settings-key-status"]', 'Key set');
        await waitUntilAsync('the switch to be enabled', async () =>
          page ? !(await toggle.isDisabled()) : false,
        );
        expect(await page.locator('[data-testid="settings-knowledge-wake-note"]').count()).toBe(0);
        expect(await toggle.isChecked()).toBe(false);
        // A controlled switch: it turns on once the daemon says so.
        await toggle.click();
        await waitUntilAsync(
          'knowledge_wake saved',
          async () => cockpit.store.getHomeConfig().knowledge_wake === 'jev',
        );
        // A reload shows it on.
        await page.reload();
        await waitUntilAsync('the switch to read on', async () =>
          page ? await toggle.isChecked() : false,
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
    // T379: the frame's projects, as the daemon wires them.
    projects: new ProjectService(store, streams),
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
        // T363: Start agent is one click with the defaults; its chevron (T423: Start with…)
        // opens the picker (T170), prefilled with the D17 built-in, the models by name.
        expect(await page.locator('[data-testid="attach-options"]').getAttribute('title')).toBe(
          'Start with…',
        );
        await page.locator('[data-testid="attach-options"]').click();
        await page.locator('[data-testid="session-picker"][data-role="worker"]').waitFor();
        expect(await pickedModel(page, 'picker-model')).toEqual({
          vendor: 'claude',
          model: 'claude-opus-5-5',
          effort: 'low',
          label: 'Claude Opus 5.5Default',
        });
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
        // The stream page shows the question whole — the tail the inbox clips. T416: once, in
        // its chat line; the card at the end of the chat holds only what answers it.
        const card = `[data-testid="stream-needs"] [data-id="${questionId}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(
          await page
            .locator('[data-testid="thread-entry"][data-open-question="true"]')
            .textContent(),
        ).toContain('TAIL-MARKER-7');
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).count()).toBe(0);
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

        // ---- answer, on the stream page. T364: its card has no input of its own;
        // T363: the composer answers the open question.
        expect(await page.locator(`${card} [data-testid="answer-input"]`).count()).toBe(0);
        // T416: the chip says it answers "the question above"; the question is its tooltip.
        await page
          .locator('[data-testid="composer-answering"][title*="two conventions"]', {
            hasText: 'Answering the question above',
          })
          .waitFor();
        await page.locator('[data-testid="composer-input"]').fill('semicolon');
        await page.locator('[data-testid="composer-send"]').click();
        await page.locator(card).waitFor({ state: 'detached' });
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'continuing with semicolon' })
          .waitFor();
        await waitUntil(
          'the worker to finish',
          () => cockpit.streams.get(stream.id).agent.status === 'done',
        );
        await page
          .locator('[data-testid="stream-status"]', { hasText: 'Agent finished' })
          .waitFor();
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

        // ---- findings: Review attaches a reviewer, which reports one (T363: from the ⋯ menu).
        await page.locator('[data-testid="node-menu-trigger"]').click();
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
        // T465: the worker rests after its finished turn (the merge ends it); the reviewer ends.
        await waitUntil('the reviewer to stop', () =>
          cockpit.streams
            .get(stream.id)
            .sessions.every((s) =>
              s.role === 'reviewer'
                ? s.status === 'stopped' || s.status === 'error'
                : s.status !== 'running',
            ),
        );

        // ---- land: first refused (a dirty main), the reason on the page…
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'yes');
        writeFileSync(join(cockpit.repo, 'README.md'), '# edited by the operator\n');
        await clickMerge(page);
        const result = page.locator('[data-testid="land-result"]');
        await result.waitFor({ state: 'visible' });
        expect(await result.getAttribute('data-status')).toBe('refused');
        expect(await result.textContent()).toContain('uncommitted changes');
        expect(cockpit.streams.get(stream.id).human.status).toBe('open');

        // …then landed once main is clean again.
        git(['checkout', '--', 'README.md'], cockpit.repo);
        await clickMerge(page);
        await waitForAttr(page, '[data-testid="land-result"]', 'data-status', 'landed');
        expect(cockpit.streams.get(stream.id).human.status).toBe('landed');
        expect(existsSync(join(cockpit.repo, 'parser.ts'))).toBe(true);
        await page.locator('[data-testid="stream-status"]', { hasText: 'Merged' }).waitFor();
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

        // …and whole on the stream page the card opens: T416, once, in its chat line (the card
        // there repeats none of it).
        await page.locator(`${card} [data-testid="open-stream"]`).click();
        const full = `[data-testid="stream-needs"] [data-id="${question.id}"]`;
        await page.locator(full).waitFor({ state: 'visible' });
        await waitForText(
          page,
          '[data-testid="thread-entry"][data-open-question="true"] .cr-msg-body .cr-md',
          LONG_QUESTION,
        );
        expect(await page.locator(`${full} [data-testid="inbox-context"]`).count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T363: a node's page is a chat -----------------------------------------

describe("a node's page is a chat (Playwright e2e, T363)", () => {
  browserTest(
    'a question sits at the end of the chat, above the composer, and the composer answers it',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const node = await cockpit.streams.create('human', { title: 'csv dialect', goal: 'g' });
        await cockpit.streams.appendThread('human', node.id, {
          kind: 'line',
          body: 'CHAT-MARKER please look at the export files',
        });
        const session = ulid();
        const first = await cockpit.questions.raise({
          stream: node.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session,
          text: 'comma or semicolon for the CSV dialect?',
        });
        const second = await cockpit.questions.raise({
          stream: node.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session,
          text: 'quote every field, or only when needed?',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        const firstCard = `[data-testid="stream-needs"] [data-id="${first.id}"]`;
        await page.locator(firstCard).waitFor({ state: 'visible' });
        await page.locator(`[data-testid="stream-needs"] [data-id="${second.id}"]`).waitFor();

        // The cards are at the end of the conversation, right above the composer.
        const line = await page
          .locator('[data-testid="thread-entry"]', { hasText: 'CHAT-MARKER' })
          .boundingBox();
        const card = await page.locator(firstCard).boundingBox();
        const composer = await page.locator('[data-testid="composer-input"]').boundingBox();
        expect(line && card ? card.y > line.y : false).toBe(true);
        expect(card && composer ? card.y + card.height <= composer.y : false).toBe(true);
        // Your line is a bubble on the right; nothing like the old "Needs you" block sits on top.
        expect(
          await page
            .locator('[data-testid="thread-entry"][data-by="human"]', { hasText: 'CHAT-MARKER' })
            .getAttribute('data-variant'),
        ).toBe('you');

        // The composer answers the oldest question by default, and says so. T416: the chat
        // reads each question once, on its own line; the chip says which one it answers
        // ("question 1 of 2", its whole text in the tooltip), and each card a line of its own.
        const chip = page.locator('[data-testid="composer-answering"]');
        await chip.waitFor();
        expect(await chip.getAttribute('data-question')).toBe(first.id);
        expect(await chip.getAttribute('title')).toContain('comma or semicolon');
        expect(await chip.textContent()).toContain('Answering question 1 of 2');
        expect(await page.locator('[data-testid="composer-hint"]').textContent()).toContain(
          'Answers the question',
        );
        expect(
          await page.locator(`${firstCard} [data-testid="inbox-context"]`).textContent(),
        ).toContain('comma or semicolon');

        // A click on the other question's card makes it the one Send answers…
        const secondCard = `[data-testid="stream-needs"] [data-id="${second.id}"]`;
        await page.locator(`${secondCard} [data-testid="inbox-context"]`).click();
        await waitForAttr(page, '[data-testid="composer-answering"]', 'data-question', second.id);
        expect(await chip.textContent()).toContain('Answering question 2 of 2');
        // …and the chip's menu picks too: back to the first, then the second again.
        await page.locator('[data-testid="composer-answering-pick"]').click();
        await page
          .locator('[data-testid="composer-answering-menu"] [role="menuitem"]', {
            hasText: 'comma or semicolon',
          })
          .click();
        await waitForAttr(page, '[data-testid="composer-answering"]', 'data-question', first.id);
        await page.locator('[data-testid="composer-answering-pick"]').click();
        await page
          .locator('[data-testid="composer-answering-menu"] [role="menuitem"]', {
            hasText: 'quote every field',
          })
          .click();
        await waitForAttr(page, '[data-testid="composer-answering"]', 'data-question', second.id);
        await page.locator('[data-testid="composer-input"]').fill('only when needed');
        await page.locator('[data-testid="composer-input"]').press('Enter');
        await waitUntil('the answer to be delivered', () => cockpit.delivered.length > 0);
        expect(cockpit.delivered[0]?.question.id).toBe(second.id);
        expect(cockpit.delivered[0]?.question.answer).toBe('only when needed');
        await page
          .locator(`[data-testid="stream-needs"] [data-id="${second.id}"]`)
          .waitFor({ state: 'detached' });
        // Your answer reads as a bubble tagged Answer.
        await page
          .locator('[data-testid="thread-entry"][data-kind="answer"][data-by="human"]', {
            hasText: 'only when needed',
          })
          .waitFor();

        // "Write a message instead": Send writes a plain line, and the question stays open.
        // One question is left: the chip answers "the question above".
        await chip.waitFor();
        await waitForAttr(page, '[data-testid="composer-answering"]', 'data-question', first.id);
        expect(await chip.textContent()).toContain('Answering the question above');
        expect(await chip.getAttribute('title')).toContain('comma or semicolon');
        await page.locator('[data-testid="composer-answer-cancel"]').click();
        await chip.waitFor({ state: 'detached' });
        await page.locator('[data-testid="composer-answer-resume"]').waitFor();
        await page.locator('[data-testid="composer-input"]').fill('a side note, not an answer');
        await page.locator('[data-testid="composer-send"]').click();
        await page
          .locator('[data-testid="thread-entry"][data-kind="line"]', {
            hasText: 'a side note, not an answer',
          })
          .waitFor();
        expect(cockpit.delivered).toHaveLength(1);
        await page.locator(firstCard).waitFor({ state: 'visible' });

        // Back to answering: the last question, from the composer.
        await page.locator('[data-testid="composer-answer-resume"]').click();
        await page.locator('[data-testid="composer-input"]').fill('semicolon');
        await page.locator('[data-testid="composer-send"]').click();
        await waitUntil('the second answer', () => cockpit.delivered.length > 1);
        expect(cockpit.delivered[1]?.question.id).toBe(first.id);
        await page.locator(firstCard).waitFor({ state: 'detached' });
        await page.locator('[data-testid="composer-answering"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="stream-needs"]').waitFor({ state: 'hidden' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a message to a node whose agent never ran starts it with the defaults',
    async () => {
      const promptLog = join(tmpdir(), `agile-t363-prompts-${ulid()}.jsonl`);
      const cockpit = await startStreamCockpit([
        {
          logFile: promptLog,
          steps: [{ type: 'agent_text', text: 'STARTED-REPLY on it' }, { type: 'end_turn' }],
        },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'why is export slow?',
          goal: 'find out why the export is slow',
          project: shop.id,
        });
        expect(cockpit.streams.get(node.id).sessions).toEqual([]);

        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await page.locator('[data-testid="node-status"]', { hasText: 'Not started' }).waitFor();
        await page.locator('[data-testid="chat-empty"]').waitFor();
        await waitForText(
          page,
          '[data-testid="composer-hint"]',
          'Starts the agent with Claude Opus 5.5 · low.',
        );
        await page.locator('[data-testid="composer-input"]').fill('SEND-STARTS profile the export');
        await page.locator('[data-testid="composer-send"]').click();

        // The line is on the thread, an agent starts, and the line reaches it once.
        await page
          .locator('[data-testid="thread-entry"][data-by="human"]', { hasText: 'SEND-STARTS' })
          .waitFor();
        await page.locator('[data-testid="session"][data-role="worker"]').waitFor();
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: 'STARTED-REPLY' })
          .waitFor();
        const sessions = cockpit.streams.get(node.id).sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ role: 'worker', model: 'claude-opus-5-5' });
        await waitUntil('the prompt log', () => existsSync(promptLog));
        const prompts = readFileSync(promptLog, 'utf8');
        // One turn, its brief carrying the line (T361: not a second prompt with it).
        expect(prompts).toContain('SEND-STARTS profile the export');
        expect(prompts.split('\n').filter((l) => l.includes('"session/prompt"'))).toHaveLength(1);
        // The empty state has made way for the conversation.
        expect(await page.locator('[data-testid="chat-empty"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(promptLog, { force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "T438: a start that failed shows its warning in words, and no 'Tell the agent what to do'",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'sync prices',
          goal: 'sync prices from Stripe',
          project: shop.id,
        });
        await cockpit.streams.appendThread('daemon', node.id, {
          kind: 'event',
          body: "could not start the agent: Claude Code can't start: `claude` is not on the daemon's PATH.",
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await page
          .locator('[data-testid="thread"]', {
            hasText: "The agent couldn’t start: Claude Code can't start",
          })
          .waitFor();
        expect(await page.locator('[data-testid="thread"]').textContent()).toContain(
          'Fix its install or login, then send a message to start it again.',
        );
        expect(await page.locator('[data-testid="chat-empty"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T423: the model chip picks what the next message runs; a pick starts nothing; Send starts with it, and restarts a live agent with another',
    async () => {
      const firstLog = join(tmpdir(), `agile-t423-first-${ulid()}.jsonl`);
      const secondLog = join(tmpdir(), `agile-t423-second-${ulid()}.jsonl`);
      const cockpit = await startStreamCockpit([
        // The first agent stays mid-turn, so the second pick restarts a live one.
        {
          logFile: firstLog,
          steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }],
        },
        {
          logFile: secondLog,
          steps: [{ type: 'agent_text', text: 'SECOND-REPLY switched' }, { type: 'end_turn' }],
        },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'which model?',
          goal: 'try a model',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        const chip = page.locator('[data-testid="composer-model"]');
        // T468: the model on the left, its effort on the right.
        await waitForText(page, '[data-testid="composer-model"]', 'Claude Opus 5.5');
        await waitForText(page, '[data-testid="composer-effort"]', 'Low');
        expect(await chip.getAttribute('title')).toContain('resets to the default after you send');

        // One place to pick: not in Details, not in ⋯ (the header keeps Start with…).
        expect(await page.locator('[data-testid="node-details"]').textContent()).not.toMatch(
          /Choose model|Restart with/,
        );
        await page.locator('[data-testid="node-menu-trigger"]').click();
        const menu = (await page.locator('[data-testid="node-menu"]').textContent()) ?? '';
        expect(menu).not.toContain('Choose the model');
        expect(menu).not.toContain('another model');
        await page.keyboard.press('Escape');

        // The chip opens a popover (never a dialog): models by name, grouped by vendor.
        await chip.click();
        const popover = page.locator('[data-testid="model-popover"]');
        await popover.waitFor();
        expect(await page.locator('[data-testid="session-picker-dialog"]').count()).toBe(0);
        expect(await popover.locator('.cr-mpick-group-hd').allTextContents()).toEqual([
          'Claude',
          'Other agents',
        ]);
        expect(await pickedModel(page, 'model-choice')).toEqual({
          vendor: 'claude',
          model: 'claude-opus-5-5',
          effort: 'low',
          label: 'Claude Opus 5.5Default',
        });
        await popover.locator('[data-model="claude-sonnet-4-6"]').click();
        await popover.locator('[data-testid="effort-high"]').click();
        // A vendor without effort says so instead of offering it.
        await popover.locator('[data-vendor="gemini"]').click();
        expect(await popover.locator('[data-testid="model-choice-no-effort"]').textContent()).toBe(
          'Gemini has no effort setting.',
        );
        await popover.locator('[data-model="claude-sonnet-4-6"]').click();
        await page.keyboard.press('Escape');
        await popover.waitFor({ state: 'detached' });

        // Picking started nothing; the chip and the hint say what Send will do.
        await Bun.sleep(300);
        expect(cockpit.streams.get(node.id).sessions).toEqual([]);
        await waitForText(page, '[data-testid="composer-model"]', 'Claude Sonnet 4.6');
        await waitForText(page, '[data-testid="composer-effort"]', 'High');
        expect(await chip.getAttribute('data-chosen')).toBe('true');
        expect(await page.locator('[data-testid="composer-hint"]').textContent()).toBe(
          'Starts the agent with Claude Sonnet 4.6 · high.',
        );

        // Send: the agent starts with the pick, the line its first prompt.
        await page.locator('[data-testid="composer-input"]').fill('PICKED-START go');
        await page.locator('[data-testid="composer-send"]').click();
        await waitUntil(
          'the first agent to run',
          () => cockpit.streams.get(node.id).sessions[0]?.status === 'running',
        );
        expect(cockpit.streams.get(node.id).sessions).toMatchObject([
          { role: 'worker', model: 'claude-sonnet-4-6', effort: 'high' },
        ]);
        await waitUntil(
          'the first prompt',
          () => existsSync(firstLog) && readFileSync(firstLog, 'utf8').includes('PICKED-START go'),
        );
        // The pick lasted one message: the chip names what runs now.
        await waitUntilAsync('the chip to name the live agent', async () =>
          page ? (await chip.getAttribute('data-live')) === 'true' : false,
        );
        expect(await chip.textContent()).toBe('Claude Sonnet 4.6');
        expect(await page.locator('[data-testid="composer-effort"]').textContent()).toBe('High');

        // Another model for a live agent: nothing happens until you send.
        await chip.click();
        await popover.waitFor();
        expect(
          await popover.locator('[data-model="claude-sonnet-4-6"] .cr-mpick-tag').textContent(),
        ).toBe('Running');
        await popover.locator('[data-model="claude-haiku-4-5"]').click();
        await page.keyboard.press('Escape');
        await waitForText(
          page,
          '[data-testid="composer-hint"]',
          'Stops Claude’s current step, restarts the agent with Claude Haiku 4.5 · high, then sends this.',
        );
        await Bun.sleep(300);
        expect(cockpit.streams.get(node.id).sessions).toHaveLength(1);
        await page.locator('[data-testid="composer-input"]').fill('SWITCH-LINE use haiku');
        await page.locator('[data-testid="composer-send"]').click();

        // Send restarted it with the pick and delivered the line to the new agent.
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: 'SECOND-REPLY' })
          .waitFor();
        const sessions = cockpit.streams.get(node.id).sessions;
        expect(sessions).toHaveLength(2);
        expect(sessions[0]?.status).toBe('stopped');
        expect(sessions[1]).toMatchObject({ model: 'claude-haiku-4-5', effort: 'high' });
        expect(readFileSync(secondLog, 'utf8')).toContain('SWITCH-LINE use haiku');
        expect(readFileSync(firstLog, 'utf8')).not.toContain('SWITCH-LINE');
        // T464: the node keeps what it last ran on for the next message, not the default.
        await waitForText(page, '[data-testid="composer-model"]', 'Claude Haiku 4.5');
        await waitForText(page, '[data-testid="composer-effort"]', 'High');
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(firstLog, { force: true });
        rmSync(secondLog, { force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'Start agent is one click; Delete node… confirms, goes to Needs me, and Undo brings it back',
    async () => {
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'throwaway',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();

        // One click: no picker, the defaults.
        await page.locator('[data-testid="attach"]').click();
        await page
          .locator('[data-testid="session"][data-role="worker"][data-status="running"]')
          .waitFor();
        expect(await page.locator('[data-testid="session-picker"]').count()).toBe(0);
        await page.locator('[data-testid="thinking"]').waitFor();
        await page.locator('[data-testid="stop"]').waitFor();
        await waitForText(
          page,
          '[data-testid="composer-hint"]',
          'Queued — Claude reads it after its current step.',
        );

        // Delete node…: a confirmation, then the node leaves and Needs me opens.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="stream-delete"]').click();
        await page.locator('[data-testid="delete-node-confirm"]').click();
        await page.locator('[data-testid="inbox"]').waitFor();
        await waitUntil('the node archived', () => cockpit.streams.get(node.id).archived === true);
        expect(cockpit.streams.get(node.id).sessions.every((s) => s.status !== 'running')).toBe(
          true,
        );
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`)
          .waitFor({ state: 'detached' });

        // Undo restores it and reopens its page.
        await page.locator('[data-testid="toast"]', { hasText: 'to the trash' }).waitFor();
        await page.locator('[data-testid="toast-action"]', { hasText: 'Undo' }).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await waitUntil(
          'the node restored',
          () => cockpit.streams.get(node.id).archived === undefined,
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('rename and re-goal a node in place (Playwright e2e, T385)', () => {
  browserTest(
    'a click on the title renames the node; Edit on the goal changes it and says so in the chat',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        // A work node (D42: a conversation's goal is its first message, edited in Details).
        const node = await cockpit.streams.create('human', {
          title: 'csv thing',
          goal: 'import CSV',
          project: shop.id,
          repo: 'demo',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();

        // Esc leaves it as it was; Enter saves.
        await page.locator('[data-testid="stream-title"] button').click();
        await page.locator('[data-testid="title-input"]').fill('never mind');
        await page.locator('[data-testid="title-input"]').press('Escape');
        await waitForText(page, '[data-testid="stream-title"]', 'csv thing');
        await page.locator('[data-testid="stream-title"] button').click();
        await page.locator('[data-testid="title-input"]').fill('Import CSV files');
        await page.locator('[data-testid="title-input"]').press('Enter');
        await waitUntil(
          'the title saved',
          () => cockpit.streams.get(node.id).title === 'Import CSV files',
        );
        await waitForText(page, '[data-testid="stream-title"]', 'Import CSV files');
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`, {
            hasText: 'Import CSV files',
          })
          .waitFor();

        await page.locator('[data-testid="goal-edit"]').click();
        await page
          .locator('[data-testid="goal-input"]')
          .fill('Import CSV and TSV, with a header row.');
        await page.locator('[data-testid="goal-save"]').click();
        await page.locator('[data-testid="goal-input"]').waitFor({ state: 'detached' });
        expect(cockpit.streams.get(node.id).goal).toBe('Import CSV and TSV, with a header row.');
        await page
          .locator('[data-testid="goal-card"]', { hasText: 'Import CSV and TSV' })
          .waitFor();
        // The agent reads it on its thread; the chat shows it as a system row.
        await page
          .locator('[data-testid="stream-page"]', {
            hasText: 'Goal changed: Import CSV and TSV, with a header row.',
          })
          .waitFor();
        const events = cockpit.streams
          .readThread(node.id)
          .entries.filter((e) => e.kind === 'event' && e.body.startsWith('goal changed'));
        expect(events.map((e) => [e.by, e.body])).toEqual([
          ['human', 'goal changed: Import CSV and TSV, with a header row.'],
        ]);

        // T413: a goal that only repeats the title is no card; it reads, and changes, in Details.
        await page.locator('[data-testid="goal-edit"]').click();
        await page.locator('[data-testid="goal-input"]').fill('Import CSV files');
        await page.locator('[data-testid="goal-save"]').click();
        await page.locator('[data-testid="goal-card"]').waitFor({ state: 'detached' });
        const about = '[data-testid="node-details"] [data-testid="about-goal"]';
        await waitForText(page, `${about} [data-testid="about-goal-text"]`, 'Import CSV files');
        await page.locator(`${about} [data-testid="goal-edit"]`).click();
        await page.locator('[data-testid="goal-input"]').fill('Import CSV files, and TSV too.');
        await page.locator('[data-testid="goal-save"]').click();
        await waitUntil(
          'the goal saved from Details',
          () => cockpit.streams.get(node.id).goal === 'Import CSV files, and TSV too.',
        );
        // Saying more than the title again, it is the chat's card once more.
        await page.locator('[data-testid="goal-card"]', { hasText: 'and TSV too' }).waitFor();
        expect(await page.locator(about).count()).toBe(0);
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
      // The worker stays mid-turn, so the composer's lines below queue for it (no second start).
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'tool_call', toolCallId: 'w-1', title: 'read' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const stream = await cockpit.streams.create('human', {
          title: 'defaults',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        // T436 (audit r6 #25): Notifications' copy names replies too (T429 notifies them).
        await page
          .locator('[data-testid="settings-notifications"]', { hasText: 'or a reply' })
          .waitFor();
        await page.locator('[data-testid="settings-nav-agents"]').click();
        const home = (suffix: string) => `[data-testid="settings-session-home${suffix}"]`;
        const contains = async (selector: string, text: string) =>
          waitUntilAsync(`${selector} to contain ${text}`, async () =>
            ((await page?.locator(selector).first().textContent()) ?? '').includes(text),
          );
        // T164: a Global default card, then (T436) Per project, then Per repository, one card
        // per repo (T367) — those that set nothing folded into one row.
        await contains(home(''), 'Global default');
        await contains('[data-testid="settings-session-repos-heading"]', 'Per repository');
        await contains(
          '[data-testid="settings-session-repos-heading"]',
          'overrides the global default',
        );
        const projectsFirst = (await page.evaluate(`(() => {
          const projects = document.querySelector('[data-testid="settings-session-projects-heading"]');
          const repos = document.querySelector('[data-testid="settings-session-repos-heading"]');
          return !!projects && !!repos && !!(projects.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING);
        })()`)) as unknown;
        expect(projectsFirst).toBe(true);
        // demo and web set nothing of their own: one row says so, and opens to their cards.
        await contains(
          '[data-testid="settings-session-repos-fold"]',
          '2 repositories use the global default',
        );
        expect(await page.locator('[data-testid="settings-session-repo-demo"]').count()).toBe(0);
        await page.locator('[data-testid="settings-session-repos-fold-toggle"]').click();
        await contains('[data-testid="settings-session-repo-demo"]', 'demo');
        // T382: the default reads in words, as the composer says it; the ids are on hover.
        await contains('[data-testid="settings-session-repo-demo-resolved"]', 'Claude');
        await waitForText(page, home('-resolved'), 'Claude Opus 5.5 · low');
        // T423: models by name, what an unset field inherits in words, and no Save: a change saves.
        expect(await selectedText(page, home('-field-vendor'))).toBe('Inherits Claude');
        expect(await selectedText(page, home('-field-model'))).toBe('Inherits Claude Opus 5.5');
        expect(await selectedText(page, home('-field-effort'))).toBe('Inherits Low');
        expect(await page.locator(`${home('')} button`, { hasText: 'Save' }).count()).toBe(0);
        await page.locator(home('-field-model')).selectOption('claude-sonnet-4-6');
        expect(await selectedText(page, home('-field-model'))).toBe('Claude Sonnet 4.6');
        await waitForText(page, home('-saved'), 'Saved');
        await page.locator(home('-field-effort')).selectOption('high');
        await waitForText(page, home('-resolved'), 'Claude Sonnet 4.6 · high');
        expect(
          await page
            .locator('.cr-set-resolved', { has: page.locator(home('-resolved')) })
            .getAttribute('title'),
        ).toBe('What a new agent here starts with: claude/claude-sonnet-4-6 · high effort');
        await waitForText(page, home('-saved'), 'Saved');
        expect(readFileSync(join(cockpit.home, 'config.yaml'), 'utf8')).toContain(
          'default_model: claude-sonnet-4-6',
        );

        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        // T363: the composer's model chip names what Send would start.
        await page
          .locator('[data-testid="composer-model"]', { hasText: 'Claude Sonnet 4.6' })
          .waitFor();
        await page.locator('[data-testid="composer-effort"]', { hasText: 'High' }).waitFor();
        expect(await page.locator('[data-testid="composer-hint"]').textContent()).toBe(
          'Starts the agent with Claude Sonnet 4.6 · high.',
        );

        // T363: Start agent's chevron opens the picker, prefilled with the new default.
        await page.locator('[data-testid="attach-options"]').click();
        await page.locator('[data-testid="session-picker"]').waitFor();
        await waitUntilAsync(
          'the picker to prefill',
          async () =>
            page !== undefined &&
            (await pickedModel(page, 'picker-model'))?.model === 'claude-sonnet-4-6',
        );
        expect((await pickedModel(page, 'picker-model'))?.effort).toBe('high');
        await page.locator('[data-testid="picker-start"]').click();
        // T382: the details panel's session row reads the model as the composer does.
        await page
          .locator('[data-testid="session"][data-role="worker"]', {
            hasText: 'Claude Sonnet 4.6 · high',
          })
          .waitFor();
        expect(
          await page
            .locator('[data-testid="session"][data-role="worker"] [data-testid="session-model"]')
            .getAttribute('title'),
        ).toBe('claude/claude-sonnet-4-6 · high effort');
        expect(cockpit.streams.get(stream.id).sessions[0]).toMatchObject({
          model: 'claude-sonnet-4-6',
          effort: 'high',
        });

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
        expect(cockpit.streams.get(stream.id).sessions).toHaveLength(1);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T456: If the agent fails — retry, the agents to try in order, and hookless — each saves',
    async () => {
      const cockpit = await startStreamCockpit([{ steps: [{ type: 'hang' }] }]);
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=agents`);
        const card = (suffix: string) => `[data-testid="settings-vendor-failure${suffix}"]`;
        const contains = async (selector: string, text: string) =>
          waitUntilAsync(`${selector} to contain ${text}`, async () =>
            ((await page?.locator(selector).first().textContent()) ?? '').includes(text),
          );
        await contains(card(''), 'If the agent fails');
        await waitForText(page, card('-none'), 'No other agent');
        const config = () => cockpit.store.getHomeConfig().vendor_failure;
        const saved = async (want: unknown) =>
          waitUntilAsync(`vendor_failure to be ${JSON.stringify(want)}`, async () =>
            Bun.deepEquals(config(), want),
          );
        // Retry once is on by default; off saves at once.
        expect(await page.locator(card('-retry')).isChecked()).toBe(true);
        await page.locator(card('-retry')).uncheck();
        await saved({ retry: false });
        await waitForText(page, card('-saved'), 'Saved');
        // Then try: added in order, moved up, each a save; a vendor with no hooks says so.
        await page.locator(card('-add')).selectOption('gemini');
        await contains(card('-item-gemini'), 'No hooks');
        await page.locator(card('-add')).selectOption('pi');
        await saved({ retry: false, fallback: ['gemini', 'pi'] });
        expect(await page.locator(card('-item-pi')).textContent()).not.toContain('No hooks');
        await page.locator(card('-up-pi')).click();
        await saved({ retry: false, fallback: ['pi', 'gemini'] });
        await page.locator(card('-remove-gemini')).click();
        await saved({ retry: false, fallback: ['pi'] });
        await page.locator(card('-hookless')).check();
        await saved({ retry: false, fallback: ['pi'], allow_hookless: true });
        expect(readFileSync(join(cockpit.home, 'config.yaml'), 'utf8')).toContain(
          'vendor_failure:',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "T379: a project's own defaults in Settings are what its nodes start with",
    async () => {
      const cockpit = await startStreamCockpit([{ steps: [{ type: 'hang' }] }]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
          repos: ['demo'],
        });
        const stream = await cockpit.streams.create('human', {
          title: 'project defaults',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-nav-agents"]').click();
        const card = (suffix: string) =>
          `[data-testid="settings-session-project-${shop.id}${suffix}"]`;
        await page
          .locator('[data-testid="settings-session-projects-heading"]', { hasText: 'Per project' })
          .waitFor();
        await page.locator(card(''), { hasText: 'shop' }).waitFor();
        await waitForText(page, card('-resolved'), 'Claude Opus 5.5 · low');
        await page.locator(card('-field-model')).selectOption('claude-haiku-4-5');
        await page.locator(card('-field-effort')).selectOption('max');
        await waitForText(page, card('-saved'), 'Saved');
        await waitForText(page, card('-resolved'), 'Claude Haiku 4.5 · max');
        expect(cockpit.store.getProject(shop.id).session).toEqual({
          model: 'claude-haiku-4-5',
          effort: 'max',
        });

        // The composer names the project's model, and Send starts exactly that.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await page
          .locator('[data-testid="composer-model"]', { hasText: 'Claude Haiku 4.5' })
          .waitFor();
        await page.locator('[data-testid="composer-effort"]', { hasText: 'Max' }).waitFor();
        await page.locator('[data-testid="composer-input"]').fill('go');
        await page.locator('[data-testid="composer-input"]').press('Enter');
        await waitUntil(
          'the worker to start',
          () => cockpit.streams.get(stream.id).sessions.length === 1,
        );
        expect(cockpit.streams.get(stream.id).sessions[0]).toMatchObject({
          model: 'claude-haiku-4-5',
          effort: 'max',
        });

        // Back to inherit: the project's block is cleared, not left empty.
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-nav-agents"]').click();
        await page.locator(card('-field-model')).selectOption('');
        await page.locator(card('-field-effort')).selectOption('');
        await waitForText(page, card('-resolved'), 'Claude Opus 5.5 · low');
        await waitUntil(
          'the project session cleared',
          () => cockpit.store.getProject(shop.id).session === undefined,
        );

        // T401: a vendor with no effort setting: the level can't be picked, and the label drops it.
        expect(await selectedText(page, card('-field-model'))).toBe('Inherits Claude Opus 5.5');
        await page.locator(card('-field-vendor')).selectOption('gemini');
        // T402: Gemini doesn't inherit a Claude model.
        expect(await selectedText(page, card('-field-model'))).toBe(
          'Inherits Gemini default model',
        );
        const effort = page.locator(card('-field-effort'));
        expect(await effort.isDisabled()).toBe(true);
        expect(await effort.getAttribute('title')).toBe(
          'Gemini has no effort setting; the level is not used',
        );
        await waitForText(page, card('-resolved'), 'Gemini default model');
        expect(cockpit.store.getProject(shop.id).session).toEqual({ vendor: 'gemini' });

        // T423: a model typed by hand (Other…) saves when you're done typing, not per key.
        await page.locator(card('-field-model')).selectOption('other model');
        const typed = page.locator(card('-field-model-other'));
        await typed.fill('gemini-3-pro');
        expect(cockpit.store.getProject(shop.id).session).toEqual({ vendor: 'gemini' });
        await typed.press('Enter');
        await waitForText(page, card('-resolved'), 'gemini-3-pro');
        await waitUntil(
          'the typed model saved',
          () => cockpit.store.getProject(shop.id).session?.model === 'gemini-3-pro',
        );
        expect(await selectedText(page, card('-field-model'))).toBe('gemini-3-pro');
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
    'nothing waits on you: no decision cards; a branch merged by hand is marked landed; Close closes as human',
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
        // T363: with nothing waiting, the decision cards above the composer are simply absent.
        await page.locator('[data-testid="stream-needs"]').waitFor({ state: 'hidden' });
        expect(await page.locator('[data-testid="stream-needs"] .cr-card').count()).toBe(0);
        await waitForAttr(page, '[data-testid="land-before"]', 'data-ready', 'merged');
        expect(await page.locator('[data-testid="land-before"]').textContent()).toContain(
          'Already merged into main',
        );
        expect(await page.locator('[data-testid="stream-land"]').count()).toBe(0);
        await page.locator('[data-testid="stream-mark-landed"]').click();
        await page.locator('[data-testid="stream-status"]', { hasText: 'Merged' }).waitFor();
        expect(cockpit.streams.get(merged.id).human.status).toBe('landed');
        // T363: Close lives in the ⋯ menu, and a merged node has none.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="node-menu"]').waitFor();
        expect(await page.locator('[data-testid="stream-close"]').count()).toBe(0);
        await page.keyboard.press('Escape');

        // Close, on another stream: from the ⋯ menu, confirmed.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${other.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${other.id}"]`).waitFor();
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="stream-close"]').click();
        await page.locator('[data-testid="close-node-confirm"]').click();
        await page.locator('[data-testid="stream-status"]', { hasText: 'Closed' }).waitFor();
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

describe('finished with nothing to merge (Playwright e2e, T380)', () => {
  browserTest(
    'a finished node with no commits reads "No changes" and its card closes it, not merges it',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const worktree = join(cockpit.repo, '.worktrees', 's-nothing');
        git(['worktree', 'add', '-q', '-b', 's-nothing', worktree, 'main'], cockpit.repo);
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const stream = await cockpit.streams.create('human', {
          title: 'nothing to do',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-nothing',
          worktree,
          agent: { status: 'done' },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-kind="done"][data-id="${stream.id}"]`;
        // The first frame may still say Merge; the git check lands off the frame's path.
        await page.locator(`${card} [data-testid="close-empty"]`).waitFor();
        expect(await page.locator(`${card} .kind`).textContent()).toBe('Finished, no changes');
        expect(await page.locator(`${card} [data-testid="land"]`).count()).toBe(0);
        await page
          .locator(`${card} [data-testid="inbox-context"]`, { hasText: 'nothing to merge' })
          .waitFor();

        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await waitForText(page, '[data-testid="node-status"]', 'No changes');

        await page.locator(`${card} [data-testid="close-empty"]`).click();
        await waitUntil(
          'the node closed',
          () => cockpit.streams.get(stream.id).human.status === 'closed',
        );
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
        // T363: Merge shows when the branch has something to merge.
        const freshTree = join(cockpit.repo, '.worktrees', 's-fresh');
        git(['worktree', 'add', '-q', '-b', 's-fresh', freshTree, 'main'], cockpit.repo);
        writeFileSync(join(freshTree, 'fresh.txt'), 'fresh\n');
        git(['add', '-A'], freshTree);
        git(['commit', '-q', '-m', 'fresh'], freshTree);
        await cockpit.streams.update('daemon', fresh.id, {
          branch: 's-fresh',
          worktree: freshTree,
        });
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
        await clickMerge(page);
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
        // T363: Merge shows when the branch has something to merge.
        const worktree = join(cockpit.repo, '.worktrees', 's-finished');
        git(['worktree', 'add', '-q', '-b', 's-finished', worktree, 'main'], cockpit.repo);
        writeFileSync(join(worktree, 'finished.txt'), 'finished\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'finished'], worktree);
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-finished',
          worktree,
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

        // T410: the card says how much it merges; View changes opens the Changes tab.
        const size = page.locator(`${card} [data-testid="card-diffstat"]`);
        await size.waitFor();
        expect(await size.getAttribute('title')).toBe(
          '1 file changed, 1 line added, 0 lines removed',
        );
        await page.locator(`${card} [data-testid="view-changes"]`).click();
        await page
          .locator(
            '[data-testid="stream-page"] .cr-node-tabs button[data-tab="diff"][aria-current="page"]',
          )
          .waitFor();
        await page.locator('[data-view="inbox"]').click();

        // D9: a ship-check hold is news (neutral), a real refusal stays red.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${stream.id}"]`).click();
        await clickMerge(page);
        const result = page.locator('[data-testid="land-result"]');
        await result.filter({ hasText: 'held by ship check' }).waitFor();
        expect(await result.getAttribute('class')).toContain('info');
        expect(await result.getAttribute('class')).not.toContain('bad');
        await clickMerge(page);
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

describe('one verdict on a finished branch (Playwright e2e, T412)', () => {
  browserTest(
    'a branch merged by hand reads "Already merged" with Mark as merged; one that waits on another node has no Merge',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        // In a project: a node outside one is a project root, which never merges.
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const finish = async (title: string, branch: string) => {
          const stream = await cockpit.streams.create('human', {
            title,
            goal: 'g',
            repo: 'demo',
            project: shop.id,
          });
          const worktree = join(cockpit.repo, '.worktrees', branch);
          git(['worktree', 'add', '-q', '-b', branch, worktree, 'main'], cockpit.repo);
          writeFileSync(join(worktree, `${branch}.txt`), `${branch}\n`);
          git(['add', '-A'], worktree);
          git(['commit', '-q', '-m', branch], worktree);
          await cockpit.streams.update('daemon', stream.id, {
            branch,
            worktree,
            agent: { status: 'done' },
          });
          return stream;
        };
        // Merged into main by hand, outside the cockpit.
        const byHand = await finish('merged by hand', 's-by-hand');
        git(['merge', '-q', '--no-ff', '-m', 'by hand', 's-by-hand'], cockpit.repo);
        // Finished, but waits on a node that hasn't started.
        const later = await cockpit.streams.create('human', {
          title: 'the docs',
          goal: 'g',
          project: shop.id,
        });
        const waiting = await finish('the api', 's-waiting');
        await cockpit.streams.wait('human', waiting.id, later.id);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const merged = `[data-kind="done"][data-id="${byHand.id}"]`;
        await waitForText(page, `${merged} .kind`, 'Already merged');
        expect(await page.locator(`${merged} [data-testid="land"]`).count()).toBe(0);
        const waits = `[data-kind="done"][data-id="${waiting.id}"]`;
        await waitForText(page, `${waits} .kind`, 'Finished, waiting to merge');
        expect(
          await page.locator(`${waits} [data-testid="inbox-context"]`).textContent(),
        ).toContain('It merges after the docs merges.');
        expect(await page.locator(`${waits} [data-testid="land"]`).count()).toBe(0);
        // The tree reads the same verdicts.
        const dot = (id: string) =>
          page?.locator(`[data-testid="stream-tree"] [data-stream="${id}"][data-status]`).first();
        expect(await dot(byHand.id)?.getAttribute('data-status')).toBe('merged_outside');
        expect(await dot(waiting.id)?.getAttribute('data-status')).toBe('waiting');

        // Mark as merged finishes it.
        await page.locator(`${merged} [data-testid="mark-merged"]`).click();
        await waitUntil(
          'the node marked merged',
          () => cockpit.streams.get(byHand.id).human.status === 'landed',
        );
        // Open <the node it waits on> goes there.
        await page.locator(`${waits} [data-testid="waited-open"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${later.id}"]`).waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('review the diff with the agent (Playwright e2e, T393)', () => {
  browserTest(
    'comments on two lines collect in the review bar; Add to message fills the composer and opens the chat; Send puts the review on the thread',
    async () => {
      const promptLog = join(tmpdir(), `agile-t393-prompts-${ulid()}.jsonl`);
      const cockpit = await startStreamCockpit([
        {
          logFile: promptLog,
          steps: [{ type: 'agent_text', text: 'REVIEW-READ on it' }, { type: 'end_turn' }],
        },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const stream = await cockpit.streams.create('human', {
          title: 'csv import',
          goal: 'import a csv',
          repo: 'demo',
          project: shop.id,
        });
        // The agent's work, committed on the node's branch.
        const worktree = join(cockpit.repo, '.worktrees', 's-review');
        git(['worktree', 'add', '-q', '-b', 's-review', worktree, 'main'], cockpit.repo);
        mkdirSync(join(worktree, 'src'));
        writeFileSync(
          join(worktree, 'src', 'import.ts'),
          'export function importCsv(text: string) {\n  const rows = text.split(",");\n  return rows;\n}\n',
        );
        writeFileSync(join(worktree, 'README.md'), '# fixture\n\nImports CSV files.\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'import'], worktree);
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-review',
          worktree,
          agent: { status: 'done' },
        });

        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/?node=${stream.id}`);
        await p.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        const file = (path: string) => p.locator(`[data-testid="diff-file"][data-path="${path}"]`);
        await file('src/import.ts').waitFor();
        expect(await p.locator('[data-testid="diff-file"]').count()).toBe(2);
        expect(
          await p
            .locator('[data-testid="diff"] [data-line="add"]', { hasText: 'text.split' })
            .count(),
        ).toBe(1);
        expect(await p.locator('[data-testid="review-bar"]').count()).toBe(0);

        // T415: frames are held here and let go after the next line has focus, as a
        // slow runner does, so focus returning to the line just commented can't take
        // the keyboard back from it.
        // (Strings, as elsewhere in this file: the daemon's tsconfig has no DOM types.)
        await p.evaluate(`{
          const raf = window.requestAnimationFrame.bind(window);
          const held = [];
          window.requestAnimationFrame = (cb) => {
            held.push(cb);
            return 0;
          };
          window.releaseFrames = () => {
            window.requestAnimationFrame = raf;
            for (const cb of held.splice(0)) raf(cb);
          };
        }`);
        // One comment from the gutter's +, added with the button.
        const splitLine = file('src/import.ts').locator('[data-line="add"]', {
          hasText: 'text.split',
        });
        await splitLine.hover();
        await splitLine.locator('[data-testid="diff-comment-add"]').click();
        // T413: the box opens on that file, and says so.
        await waitForText(
          p,
          '[data-testid="diff-file"][data-path="src/import.ts"] [data-testid="diff-comment-where"]',
          'Comment on src/import.ts:2',
        );
        await p
          .locator('[data-testid="diff-comment-input"]')
          .fill('Quoted fields can hold commas.');
        await p.locator('[data-testid="diff-comment-submit"]').click();
        await p.locator('[data-testid="diff-comment"]', { hasText: 'Quoted fields' }).waitFor();
        await waitForText(p, '[data-testid="review-count"]', '1 comment on 1 file');
        // One from the keyboard: the focused line, C, then Ctrl+Enter.
        const readmeLine = file('README.md').locator('[data-line="add"]', {
          hasText: 'Imports CSV',
        });
        await readmeLine.focus();
        await p.evaluate(
          'new Promise((done) => { window.releaseFrames(); requestAnimationFrame(() => done()); })',
        );
        await p.keyboard.press('c');
        // T413: the box opened under README's line before a word is typed.
        const readmeInput = file('README.md').locator('[data-testid="diff-comment-input"]');
        await readmeInput.waitFor();
        expect(
          await file('src/import.ts').locator('[data-testid="diff-comment-input"]').count(),
        ).toBe(0);
        // T426: Shift+Enter is a new line, Enter adds (as in the composer).
        await readmeInput.fill('Say which');
        await p.keyboard.press('Shift+Enter');
        await p.keyboard.type('delimiter.');
        expect(await readmeInput.inputValue()).toBe('Say which\ndelimiter.');
        await p.keyboard.press('Enter');
        await p.locator('[data-testid="diff-comment"]', { hasText: 'delimiter.' }).waitFor();
        await waitForText(p, '[data-testid="review-count"]', '2 comments on 2 files');
        // The count on the tab says what it counts.
        expect(await p.locator('[data-tab="diff"] .cr-tab-count').getAttribute('title')).toBe(
          '2 review comments not sent yet',
        );

        // Esc drops a comment being written; nothing is added.
        await splitLine.hover();
        await splitLine.locator('[data-testid="diff-comment-add"]').click();
        await p.locator('[data-testid="diff-comment-input"]').fill('never mind');
        await p.keyboard.press('Escape');
        await p.locator('[data-testid="diff-comment-input"]').waitFor({ state: 'detached' });
        expect(await p.locator('[data-testid="diff-comment"]').count()).toBe(2);

        // They outlive a tab switch, counted on the Changes tab.
        await p.locator('.cr-tabs [data-tab="activity"]').click();
        await waitForText(p, '.cr-tabs [data-tab="diff"] .cr-tab-count', '2');
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        await p.locator('[data-testid="diff-comment"]', { hasText: 'Quoted fields' }).waitFor();
        await waitForText(p, '[data-testid="review-count"]', '2 comments on 2 files');

        // Add to message: one message in the composer, in diff order; the chat opens; nothing sent.
        await p.locator('[data-testid="review-add"]').click();
        await p.locator('.cr-tabs [data-tab="thread"][aria-current="page"]').waitFor();
        const review = [
          'Review of the changes:',
          '',
          '1. `README.md:3`',
          '   `Imports CSV files.`',
          // A comment's own lines keep the item's indent.
          '   Say which',
          '   delimiter.',
          '2. `src/import.ts:2`',
          '   `const rows = text.split(",");`',
          '   Quoted fields can hold commas.',
        ].join('\n');
        expect(await p.locator('[data-testid="composer-input"]').inputValue()).toBe(review);
        await p.waitForFunction("document.activeElement?.dataset?.testid === 'composer-input'");
        expect(
          await p
            .locator('[data-testid="thread-entry"]', { hasText: 'Review of the changes' })
            .count(),
        ).toBe(0);
        expect(await p.locator('.cr-tabs [data-tab="diff"] .cr-tab-count').count()).toBe(0);

        // Send: the thread line is the review, as one numbered list; the agent gets it.
        await p.locator('[data-testid="composer-send"]').click();
        const line = p.locator('[data-testid="thread-entry"][data-by="human"]', {
          hasText: 'Review of the changes:',
        });
        await line.waitFor();
        expect(await line.locator('ol > li').count()).toBe(2);
        // The comment's second line reads as a second line, under the quote.
        expect(await line.locator('ol > li').first().innerText()).toMatch(
          /README\.md:3\s+Imports CSV files\.\s+Say which\ndelimiter\./,
        );
        expect(await line.locator('code', { hasText: 'src/import.ts:2' }).count()).toBe(1);
        await p
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: 'REVIEW-READ' })
          .waitFor();
        await waitUntil(
          "the review in the agent's prompt",
          () =>
            existsSync(promptLog) &&
            /Say which\\n {3}delimiter\./.test(readFileSync(promptLog, 'utf8')),
        );

        // The Changes tab starts clean; Discard asks before dropping a review.
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        await p.locator('[data-testid="diff-hint"]').waitFor();
        expect(await p.locator('[data-testid="diff-comment"]').count()).toBe(0);
        await splitLine.hover();
        await splitLine.locator('[data-testid="diff-comment-add"]').click();
        await p.locator('[data-testid="diff-comment-input"]').fill('scratch that');
        await p.locator('[data-testid="diff-comment-submit"]').click();
        await p.locator('[data-testid="review-discard"]').click();
        await p.locator('[data-testid="discard-review-confirm"]').click();
        await p.locator('[data-testid="review-bar"]').waitFor({ state: 'detached' });
        expect(await p.locator('[data-testid="diff-comment"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(promptLog, { force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('a comment being written stays on its file (Playwright e2e, T413)', () => {
  browserTest(
    'a new comment on another file leaves the text where it was written, as a comment, and names its file',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const stream = await cockpit.streams.create('human', {
          title: 'csv import',
          goal: 'import a csv',
          repo: 'demo',
          project: shop.id,
        });
        const worktree = join(cockpit.repo, '.worktrees', 's-draft');
        git(['worktree', 'add', '-q', '-b', 's-draft', worktree, 'main'], cockpit.repo);
        mkdirSync(join(worktree, 'src'));
        writeFileSync(
          join(worktree, 'src', 'import.ts'),
          'export const a = 1;\nexport const b = 2;\n',
        );
        writeFileSync(join(worktree, 'src', 'ledger.ts'), 'export const cents = 100;\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'two files'], worktree);
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-draft',
          worktree,
          agent: { status: 'done' },
        });

        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/?node=${stream.id}`);
        await p.locator(`[data-testid="stream-page"][data-stream="${stream.id}"]`).waitFor();
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        const file = (path: string) => p.locator(`[data-testid="diff-file"][data-path="${path}"]`);
        const line = (path: string, text: string) =>
          file(path).locator('[data-line="add"]', { hasText: text });
        const plus = async (path: string, text: string) => {
          await line(path, text).hover();
          await line(path, text).locator('[data-testid="diff-comment-add"]').click();
        };
        await file('src/ledger.ts').waitFor();

        // Type on import.ts:1, then + on ledger.ts:1: the text does not come along.
        await plus('src/import.ts', 'const a');
        await file('src/import.ts')
          .locator('[data-testid="diff-comment-input"]')
          .fill('IMPORT-NOTE');
        await plus('src/ledger.ts', 'cents');
        const ledgerInput = file('src/ledger.ts').locator('[data-testid="diff-comment-input"]');
        await ledgerInput.waitFor();
        expect(await ledgerInput.inputValue()).toBe('');
        await waitForText(
          p,
          '[data-testid="diff-file"][data-path="src/ledger.ts"] [data-testid="diff-comment-where"]',
          'Comment on src/ledger.ts:1',
        );
        // …it stayed on import.ts, added as a comment there.
        await file('src/import.ts')
          .locator('[data-testid="diff-comment"]', { hasText: 'IMPORT-NOTE' })
          .waitFor();
        expect(await file('src/ledger.ts').locator('[data-testid="diff-comment"]').count()).toBe(0);
        await waitForText(p, '[data-testid="review-count"]', '1 comment on 1 file');

        // Shift on the next line of the same file carries the text: one comment on a range.
        await ledgerInput.fill('LEDGER-NOTE');
        await plus('src/import.ts', 'const a');
        await file('src/import.ts')
          .locator('[data-testid="diff-comment-input"]')
          .fill('RANGE-NOTE');
        await line('src/import.ts', 'const b').hover();
        await line('src/import.ts', 'const b')
          .locator('[data-testid="diff-comment-add"]')
          .click({ modifiers: ['Shift'] });
        await waitForText(
          p,
          '[data-testid="diff-file"][data-path="src/import.ts"] [data-testid="diff-comment-where"]',
          'Comment on src/import.ts:1–2',
        );
        expect(
          await file('src/import.ts').locator('[data-testid="diff-comment-input"]').inputValue(),
        ).toBe('RANGE-NOTE');
        await file('src/import.ts')
          .locator('[data-testid="diff-comment-input"]')
          .press('Control+Enter');
        await waitForText(p, '[data-testid="review-count"]', '3 comments on 2 files');
        await file('src/ledger.ts')
          .locator('[data-testid="diff-comment"]', { hasText: 'LEDGER-NOTE' })
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
        // A part (D42: it has a repo; a repo-less child would be a conversation).
        await cockpit.streams.create('human', {
          title: 'child',
          goal: 'g',
          parent: parent.id,
          repo: 'demo',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${parent.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${parent.id}"]`).waitFor();
        // T363: Start agent is one click, with the defaults.
        await page.locator('[data-testid="attach"]').click();
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
        await clickMerge(page);
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
        await clickMerge(page);
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
    'an agent line past ~12 lines opens whole (T475); Show less folds it and the fold is kept',
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
        // T475: it opens whole; Show less folds it, and the fold is kept for that message.
        const toggle = long.locator('[data-testid="thread-expand"]');
        expect(await toggle.textContent()).toBe('Show less');
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        const bodyBox = long.locator('[data-testid="thread-body"]');
        const clipped = () => bodyBox.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
        expect(await clipped()).toBe(false);

        await toggle.click();
        expect(await toggle.textContent()).toBe('Show more');
        expect(await clipped()).toBe(true);
        // Away and back: still folded.
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        await page.locator('.cr-tabs [data-tab="thread"]').click();
        await long.waitFor({ state: 'visible' });
        expect(await long.locator('[data-testid="thread-expand"]').textContent()).toBe('Show more');
        await long.locator('[data-testid="thread-expand"]').click();
        expect(await long.locator('[data-testid="thread-expand"]').textContent()).toBe('Show less');
        expect(await clipped()).toBe(false);

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

// ---- T392: the agent's steps ---------------------------------------------------

describe("the agent's steps in the chat (Playwright e2e, T392)", () => {
  browserTest(
    'while a turn runs its steps show live with their status; after it, a folded row before the reply opens to them',
    async () => {
      const release = join(tmpdir(), `agile-steps-e2e-${ulid()}`);
      const worker: FakeAgentScript = {
        steps: [
          // T411: the vendor says how full its context is.
          { type: 'usage_update', used: 46_000, size: 200_000 },
          {
            type: 'tool_call',
            toolCallId: 'read-1',
            kind: 'read',
            title: 'Read src/parser.ts',
            status: 'pending',
          },
          { type: 'delay', ms: 5 },
          { type: 'tool_call_update', toolCallId: 'read-1', status: 'completed' },
          {
            type: 'tool_call',
            toolCallId: 'run-1',
            kind: 'execute',
            title: '`bun test`',
            status: 'in_progress',
          },
          { type: 'delay', ms: 5 },
          { type: 'tool_call_update', toolCallId: 'run-1', status: 'failed' },
          {
            type: 'tool_call',
            toolCallId: 'edit-1',
            kind: 'edit',
            title: 'Edit `src/parser.ts`',
            status: 'in_progress',
          },
          // The turn hangs here, mid-step, until the test lets it go.
          { type: 'wait_for_file', path: release, timeoutMs: 60_000 },
          { type: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' },
          { type: 'delay', ms: 20 },
          { type: 'agent_text', text: 'Fixed the delimiter; the tests pass.' },
          { type: 'end_turn' },
        ],
      };
      const cockpit = await startStreamCockpit([worker]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'csv parser',
          goal: 'fix the delimiter',
          repo: 'demo',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await page.locator('[data-testid="attach"]').click();

        // Live: the three steps under "Claude is working", each with its status.
        const live = page.locator('[data-testid="thinking"] [data-testid="step"]');
        const statusesOf = (steps: typeof live) =>
          steps.evaluateAll((els) =>
            els.map((el) => [el.getAttribute('data-kind'), el.getAttribute('data-status')]),
          );
        const expectLive = async () => {
          await page
            ?.locator('[data-testid="thinking"] [data-testid="step"][data-kind="edit"]')
            .waitFor();
          await waitUntilAsync('the live steps', async () => (await live.count()) === 3);
          expect(await statusesOf(live)).toEqual([
            ['read', 'done'],
            ['execute', 'failed'],
            ['edit', 'running'],
          ]);
        };
        await expectLive();
        expect(await page.locator('[data-testid="thinking"]').textContent()).toContain(
          'Claude is working',
        );
        // T411: the composer says how full the agent's context is.
        const meter = page.locator('.cr-compose-chips [data-testid="context-meter"]');
        await meter.waitFor();
        expect(await meter.getAttribute('data-percent')).toBe('23');
        expect(await meter.getAttribute('title')).toBe('Context: 46k of 200k tokens used (23%)');
        // T405: and for how long, from the line that started the turn.
        expect(
          await page
            .locator('[data-testid="thinking"] [data-testid="thinking-time"]')
            .textContent(),
        ).toMatch(/^\d+s$/);
        // A command and a path read as code; the failed one says so.
        expect(await live.nth(1).locator('code').textContent()).toBe('bun test');
        expect(await live.nth(1).locator('[aria-label="Failed"]').count()).toBe(1);
        expect(await live.nth(2).locator('code').textContent()).toBe('src/parser.ts');
        expect(await page.locator('[data-testid="steps-fold"]').count()).toBe(0);

        // A reload mid-turn reads them from the daemon and keeps following.
        await page.reload();
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await expectLive();

        // The turn ends: the reply, with its steps folded to one row before its words.
        writeFileSync(release, '');
        const reply = page.locator('[data-testid="thread-entry"][data-by="agent"]', {
          hasText: 'Fixed the delimiter',
        });
        await reply.waitFor();
        await page.locator('[data-testid="thinking"]').waitFor({ state: 'detached' });
        const fold = reply.locator('[data-testid="steps-fold"]');
        const toggle = fold.locator('[data-testid="steps-toggle"]');
        await waitUntilAsync(
          'the folded steps',
          async () =>
            (await toggle.count()) === 1 &&
            (await toggle.textContent()) === 'Worked through 3 steps · 1 failed',
        );
        expect(
          await fold.evaluate((el) => {
            const words = el.parentElement?.querySelector('.cr-msg-body');
            return (
              words !== null &&
              words !== undefined &&
              // 4: DOCUMENT_POSITION_FOLLOWING, the words come after the fold.
              (el.compareDocumentPosition(words) & 4) !== 0
            );
          }),
        ).toBe(true);
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await fold.locator('[data-testid="step"]').count()).toBe(0);
        await toggle.click();
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        expect(await statusesOf(fold.locator('[data-testid="step"]'))).toEqual([
          ['read', 'done'],
          ['execute', 'failed'],
          ['edit', 'done'],
        ]);
        await toggle.click();
        expect(await fold.locator('[data-testid="step"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(release, { force: true });
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
        expect(await tab.textContent()).toContain('Knowledge');
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
        // T426: a short list (no search box) still takes typing: "demo", Enter picks it.
        await page.keyboard.type('demo');
        await page.keyboard.press('Enter');
        await waitForAttr(page, '[data-testid="new-stream-repo"]', 'data-value', 'demo-project');
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
    'T373: New project → Add a repository… adds it on top and brings it back ticked; nothing else submits',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'agile-newproject-repo-e2e-'));
      const userHome = join(scratch, 'home');
      const blog = join(userHome, 'Projects', 'blog');
      mkdirSync(blog, { recursive: true });
      git(['init', '-q', '-b', 'main'], blog);
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
        blog,
      );
      const cockpit = await startCockpit({ userHome });
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="new-project-open"]').click();
        await page.locator('[data-testid="new-project-name"]').fill('Writing');
        await page.locator('[data-testid="new-project-add-repo"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
        // Escape closes only the dialog on top.
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        expect(await page.locator('[data-testid="new-project"]').isVisible()).toBe(true);

        await page.locator('[data-testid="new-project-add-repo"]').click();
        const browser = '[data-testid="add-repo-browser"]';
        const dir = (name: string) =>
          `${browser} [data-testid="add-repo-dir"][data-name="${name}"]`;
        await page.locator(`${browser}[data-path="${userHome}"]`).waitFor({ state: 'visible' });
        await page.locator(dir('Projects')).dblclick();
        await page.locator(dir('blog')).click();
        await waitForText(page, '[data-testid="add-repo-status"]', 'blog is a git repository.');
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });

        // The repo is registered and ticked; the project was not created by that submit.
        expect(cockpit.store.getRepos().blog?.path).toBe(realpathSync(blog));
        expect(cockpit.projects.list().some((p) => p.name === 'Writing')).toBe(false);
        const box = page.locator('[data-testid="new-project-repo"][data-repo="blog"]');
        await box.waitFor({ state: 'visible' });
        expect(await box.isChecked()).toBe(true);

        await page.locator('[data-testid="new-project-create"]').click();
        await page.locator('[data-testid="new-project"]').waitFor({ state: 'detached' });
        await waitUntil('the project with its repo', () =>
          cockpit.projects.list().some((p) => p.name === 'Writing' && p.repos.includes('blog')),
        );

        // T426: a taken name (ignoring case) says so under Name as you type; Create waits.
        await page.locator('[data-testid="new-project-open"]').click();
        await page.locator('[data-testid="new-project-name"]').fill('writing');
        await waitForText(
          page,
          '[data-testid="new-project"] .cr-field-error',
          'A project named “Writing” already exists.',
        );
        expect(await page.locator('[data-testid="new-project-create"]').isDisabled()).toBe(true);
        await page.locator('[data-testid="new-project-name"]').fill('Writing 2');
        await page.locator('[data-testid="new-project"] .cr-field-error').waitFor({
          state: 'detached',
        });
        expect(await page.locator('[data-testid="new-project-create"]').isDisabled()).toBe(false);
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T408: New node → Add a repository… opens on demand and picks the repo it added',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'agile-newnode-repo-e2e-'));
      const userHome = join(scratch, 'home');
      const shop = join(userHome, 'shop');
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
        await cockpit.projects.create({ name: 'Store' });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-add-repo"]').click();
        const browser = '[data-testid="add-repo-browser"]';
        await page.locator(`${browser}[data-path="${userHome}"]`).waitFor({ state: 'visible' });
        await page.locator(`${browser} [data-testid="add-repo-dir"][data-name="shop"]`).click();
        await waitForText(page, '[data-testid="add-repo-status"]', 'shop is a git repository.');
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        // Registered, and New node (still open) is now on it.
        expect(cockpit.store.getRepos().shop?.path).toBe(realpathSync(shop));
        await page.locator('[data-testid="new-stream-repo"][data-value="shop"]').waitFor();
        // Opened again, the dialog starts fresh.
        await page.locator('[data-testid="new-stream-add-repo"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        expect(await page.locator('[data-testid="new-stream-repo"]').isVisible()).toBe(true);
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
    'General picks the theme, names the daemon and says what is always yours; the section is in the URL',
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

        // T416: who decides is one note in General ("Always yours"), from the policy.
        const decisions = '[data-testid="settings-decisions"]';
        expect(await page.locator(`${decisions} [data-gate]`).count()).toBe(3);
        await waitForAttr(page, `${decisions} [data-gate="land"]`, 'data-owner', 'human');
        const note =
          (await page.locator('[data-testid="settings-decisions-note"]').textContent()) ?? '';
        expect(note).toContain('Merging');
        expect(note).toContain('accepting knowledge');
        expect(note).toContain('answering questions');
        expect(await page.locator('[data-testid="settings-nav-permissions"]').count()).toBe(0);

        // T434: Quick drafts has a switch; with no `claude` command here, it says why it's off.
        await waitForText(page, '[data-testid="settings-quick-drafts-status"]', 'Not available');
        expect(
          await page.locator('[data-testid="settings-quick-drafts-switch"]').isDisabled(),
        ).toBe(true);

        // The section is in the URL; back to General, it needs no parameter.
        await page.locator('[data-testid="settings-nav-trackers"]').click();
        await page.locator('[data-testid="settings"][data-section="trackers"]').waitFor();
        await waitUntilAsync('the URL to name the section', async () =>
          (page?.url() ?? '').includes('section=trackers'),
        );
        await page.locator('[data-testid="settings-nav-general"]').click();
        await waitUntilAsync(
          'the section parameter to go',
          async () => !(page?.url() ?? '').includes('section='),
        );
        expect(new URL(page.url()).searchParams.get('view')).toBe('settings');
        // An old Permissions link opens General, where the note now is.
        await page.goto(`${cockpit.base}/?view=settings&section=permissions`);
        await page.locator('[data-testid="settings"][data-section="general"]').waitFor();
        await page.locator(decisions).waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T388: browser notifications -----------------------------------------------

/**
 * T388: the page's Notification API, recorded (a headless browser shows
 * none), and a switch for being away (another tab or app):
 * `window.__setAway(true)` makes `visibilityState` "hidden" and `hasFocus()`
 * false, and fires the events a real switch fires. `real` keeps the
 * browser's own permission (the context's grant); `denied` and `dismiss`
 * play a blocked browser and a closed prompt; `missing` is a browser with
 * no Notification API at all.
 *
 * T394: a notification shown through the service worker
 * (`registration.showNotification`) is recorded too (`via: 'worker'`, with
 * its `data`), and still really shown, so the worker can be clicked
 * (`clickLastNote`). Its closes are recorded where the cockpit makes them
 * — the page's `close()` on it, the worker's on a click — and a newer one
 * under its tag replaces it (`needsMeNotes`). The page's own is `via: 'page'`.
 */
function notifyStub(mode: 'real' | 'denied' | 'dismiss' | 'missing' = 'real'): string {
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    if (mode === 'missing') {
      delete window.Notification;
      return;
    }
    const Real = window.Notification;
    window.__notes = [];
    window.__focused = 0;
    window.focus = () => {
      window.__focused++;
    };
    class Recorded {
      constructor(title, options = {}) {
        this.title = title;
        this.body = options.body ?? '';
        this.tag = options.tag ?? '';
        this.via = 'page';
        this.closed = false;
        this.onclick = null;
        window.__notes.push(this);
      }
      close() {
        this.closed = true;
      }
      static get permission() {
        return mode === 'denied' ? 'denied' : mode === 'dismiss' ? 'default' : Real.permission;
      }
      static requestPermission() {
        if (mode === 'denied') return Promise.resolve('denied');
        if (mode === 'dismiss') return Promise.resolve('default');
        return Real.requestPermission();
      }
    }
    window.Notification = Recorded;
    // The page closes a worker's notification through the objects getNotifications() hands it.
    window.__closedNotes = [];
    const close = Real.prototype.close;
    Real.prototype.close = function () {
      if (this.data?.__note !== undefined) window.__closedNotes.push(this.data.__note);
      return close.call(this);
    };
    const show = ServiceWorkerRegistration.prototype.showNotification;
    let shownByWorker = 0;
    ServiceWorkerRegistration.prototype.showNotification = function (title, options = {}) {
      const id = ++shownByWorker;
      const note = {
        title,
        body: options.body ?? '',
        tag: options.tag ?? '',
        data: options.data,
        via: 'worker',
        id,
      };
      // Recorded once the browser shows it, so a recorded one is open until closed.
      return show
        .call(this, title, { ...options, data: { ...options.data, __note: id } })
        .then(() => {
          window.__notes.push(note);
        });
    };
    let away = false;
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => (away ? 'hidden' : 'visible'),
    });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => away });
    Document.prototype.hasFocus = () => !away;
    window.__setAway = (next) => {
      away = next;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(next ? 'blur' : 'focus'));
    };
  })();`;
}

interface RecordedNote {
  title: string;
  body: string;
  tag: string;
  closed: boolean;
}

/**
 * T388: the Needs me notifications the page raised, oldest first. T394: one
 * the worker showed is closed once the page or the worker closed it, or a
 * newer one under its tag replaced it.
 */
async function needsMeNotes(page: Page): Promise<RecordedNote[]> {
  const worker = page.context().serviceWorkers()[0];
  const inWorker = worker ? ((await worker.evaluate('self.__closedNotes ?? []')) as number[]) : [];
  return (await page.evaluate(`((inWorker) => {
    const closed = new Set([...window.__closedNotes, ...inWorker]);
    const notes = window.__notes.filter((n) => n.tag === 'agile-needs-me');
    return notes.map((n, i) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      closed:
        n.via === 'worker'
          ? closed.has(n.id) || notes.slice(i + 1).some((later) => later.via === 'worker')
          : n.closed,
    }));
  })(${JSON.stringify(inWorker)})`)) as RecordedNote[];
}

/** T394: how the last Needs me notification was shown: `worker` or `page`. */
async function lastNoteVia(page: Page): Promise<string | undefined> {
  return (await page.evaluate(
    `window.__notes.filter((n) => n.tag === 'agile-needs-me').at(-1)?.via`,
  )) as string | undefined;
}

/**
 * T388: clicks the last Needs me notification (what the OS does on a click).
 * T394: one the worker showed is clicked in the worker (`sw.js`'s
 * `notificationclick`), which counts its tries to bring the tab forward in
 * `self.__focused` and records what it closes in `self.__closedNotes`.
 */
async function clickLastNote(page: Page): Promise<void> {
  if ((await lastNoteVia(page)) === 'worker') {
    const worker = await pageWorker(page);
    await worker.evaluate(`(async () => {
      if (self.__focused === undefined) {
        self.__focused = 0;
        const focus = WindowClient.prototype.focus;
        WindowClient.prototype.focus = function () {
          self.__focused++;
          return focus.call(this);
        };
        self.__closedNotes = [];
        const close = Notification.prototype.close;
        Notification.prototype.close = function () {
          if (this.data?.__note !== undefined) self.__closedNotes.push(this.data.__note);
          return close.call(this);
        };
      }
      const [note] = await self.registration.getNotifications({ tag: 'agile-needs-me' });
      self.dispatchEvent(new NotificationEvent('notificationclick', { notification: note }));
    })()`);
    return;
  }
  await page.evaluate(
    `window.__notes.filter((n) => n.tag === 'agile-needs-me').at(-1).onclick(new Event('click'))`,
  );
}

/** T394: how often a click tried to bring the cockpit forward: the page's `window.focus`, and the worker's. */
async function focusTries(page: Page): Promise<number> {
  const inPage = (await page.evaluate('window.__focused')) as number;
  const worker = page.context().serviceWorkers()[0];
  const inWorker = worker ? ((await worker.evaluate('self.__focused ?? 0')) as number) : 0;
  return inPage + inWorker;
}

/** T394: the page's active service worker (the cockpit registers it on load). */
async function pageWorker(page: Page): Promise<Worker> {
  await page.evaluate('navigator.serviceWorker.ready.then(() => true)');
  const [worker] = page.context().serviceWorkers();
  return worker ?? (await page.context().waitForEvent('serviceworker'));
}

describe('browser notifications (Playwright e2e, T388)', () => {
  browserTest(
    'turned on in Settings, a new item while away notifies with what and where and a click opens it; nothing at load or while visible; several become one',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const ledger = await cockpit.streams.create('human', {
          title: 'Ledger export format',
          goal: 'g',
        });
        const csv = await cockpit.streams.create('human', { title: 'Add CSV import', goal: 'g' });
        const raise = (stream: string, text: string): Promise<Question> =>
          cockpit.questions.raise({ stream, raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001', text });
        await raise(ledger.id, 'Already waiting at load: tabs or commas?');

        page = await openPage({ permissions: ['notifications'] });
        await page.addInitScript(notifyStub());
        await page.goto(`${cockpit.base}/?view=settings`);
        // T394: with the service worker active, notifications go through it (as on a phone).
        await pageWorker(page);
        const status = '[data-testid="settings-notify-status"]';
        const toggle = page.locator('[data-testid="settings-notify"]');
        // Off by default; on asks the browser, which (granted here) allows it. T416: the
        // switch says On or Off; a status pill only says what it can't (Blocked, Not available).
        await page.locator('[data-testid="settings-notifications"]').waitFor();
        expect(await toggle.isChecked()).toBe(false);
        expect(await page.locator(status).count()).toBe(0);
        expect(await page.locator('[data-testid="settings-notify-test"]').count()).toBe(0);
        await toggle.click();
        await waitUntilAsync('the switch to turn on', () => toggle.isChecked());
        expect(await page.locator(status).count()).toBe(0);
        // Send a test: one notification under its own tag, the way a real one goes.
        await page.locator('[data-testid="settings-notify-test"]').click();
        await page.locator('[data-testid="settings-notify-sent"]').waitFor();
        expect(
          (await page.evaluate('window.__notes.map((n) => `${n.tag} via ${n.via}`)')) as string[],
        ).toEqual(['agile-test via worker']);
        // Kept in this browser: a reload leaves it on.
        await page.reload();
        await waitUntilAsync('the switch to read on after a reload', () =>
          page
            ? page.locator('[data-testid="settings-notify"]').isChecked()
            : Promise.resolve(false),
        );
        await waitForText(page, '[data-testid="inbox-badge"]', '1');
        await pageWorker(page);

        // Visible and focused: a new question shows in the count, and nothing more.
        await raise(csv.id, 'Asked while you look: which encoding?');
        await waitForText(page, '[data-testid="inbox-badge"]', '2');
        await page.waitForTimeout(300);
        expect(await needsMeNotes(page)).toEqual([]);

        // Away: the next one notifies, naming what and where, in words.
        await page.evaluate('window.__setAway(true)');
        await raise(ledger.id, 'Which **date format** should the export use?');
        await waitUntilAsync(
          'a notification',
          async () => page !== undefined && (await needsMeNotes(page)).length > 0,
        );
        expect(await needsMeNotes(page)).toEqual([
          {
            title: 'Question on Ledger export format',
            body: 'Which date format should the export use?',
            tag: 'agile-needs-me',
            closed: false,
          },
        ]);
        // T394: shown by the worker, carrying the node a click opens.
        expect(await lastNoteVia(page)).toBe('worker');
        expect((await page.evaluate('window.__notes.at(-1).data')) as unknown).toEqual({
          node: ledger.id,
        });
        // A click (in the worker) brings the window forward and opens the node.
        await clickLastNote(page);
        await page.locator(`[data-testid="stream-page"][data-stream="${ledger.id}"]`).waitFor();
        expect(await focusTries(page)).toBeGreaterThan(0);
        expect((await needsMeNotes(page)).at(-1)?.closed).toBe(true);
        await page.evaluate('window.__setAway(false)');

        // Several while away: one notification that counts them; a click opens Needs me.
        await page.evaluate('window.__setAway(true)');
        await raise(csv.id, 'Which delimiter?');
        await raise(ledger.id, 'Which currency?');
        await waitUntilAsync(
          'one notification for both',
          async () =>
            page !== undefined &&
            (await needsMeNotes(page)).at(-1)?.title === '2 new things need you',
        );
        const both = (await needsMeNotes(page)).at(-1);
        expect(both?.body).toContain('Question on Add CSV import');
        expect(both?.body).toContain('Question on Ledger export format');
        expect((await page.evaluate('window.__notes.at(-1).data')) as unknown).toEqual({
          view: 'inbox',
        });
        await clickLastNote(page);
        await page.locator('[data-testid="inbox"]').waitFor();
        await page.evaluate('window.__setAway(false)');

        // What was there at load, and what came while visible, never notified.
        const all = await needsMeNotes(page);
        expect(all[0]?.title).toBe('Question on Ledger export format');
        expect(all.length).toBeLessThanOrEqual(3);
        const words = all.map((n) => `${n.title} ${n.body}`).join('\n');
        expect(words).not.toContain('Already waiting');
        expect(words).not.toContain('encoding');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a blocked browser, a closed prompt and a browser without notifications are said in words, and the switch stays off',
    async () => {
      const cockpit = await startCockpit();
      const pages: Page[] = [];
      try {
        const open = async (mode: 'denied' | 'dismiss' | 'missing'): Promise<Page> => {
          const page = await openPage();
          pages.push(page);
          await page.addInitScript(notifyStub(mode));
          await page.goto(`${cockpit.base}/?view=settings`);
          return page;
        };
        const status = '[data-testid="settings-notify-status"]';
        const note = '[data-testid="settings-notify-note"]';
        const toggle = '[data-testid="settings-notify"]';

        // Blocked: how to allow it; turning it on leaves it off.
        const denied = await open('denied');
        await waitForText(denied, status, 'Blocked');
        expect(await denied.locator(note).textContent()).toContain(
          'Your browser blocks notifications from the cockpit',
        );
        await denied.locator(toggle).click();
        await waitForText(denied, status, 'Blocked');
        expect(await denied.locator(toggle).isChecked()).toBe(false);
        expect(await denied.locator('[data-testid="settings-notify-test"]').count()).toBe(0);

        // The prompt closed without an answer: say so, stay off (the switch says Off; no pill).
        const dismissed = await open('dismiss');
        await dismissed.locator(toggle).waitFor();
        expect(await dismissed.locator(toggle).isChecked()).toBe(false);
        expect(await dismissed.locator(status).count()).toBe(0);
        expect(await dismissed.locator(note).count()).toBe(0);
        await dismissed.locator(toggle).click();
        await dismissed.locator(note).waitFor();
        expect(await dismissed.locator(note).textContent()).toContain('wasn’t given permission');
        expect(await dismissed.locator(toggle).isChecked()).toBe(false);
        expect(
          (await dismissed.evaluate('localStorage.getItem("agile.notify")')) as string | null,
        ).toBe(null);

        // No Notification API at all: not available, and the switch can't be turned on.
        const missing = await open('missing');
        await waitForText(missing, status, 'Not available');
        expect(await missing.locator(note).textContent()).toContain('can’t show notifications');
        expect(await missing.locator(toggle).isDisabled()).toBe(true);
      } finally {
        await teardown(pages);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T394: resilience -----------------------------------------------------------

describe('resilience (Playwright e2e, T394)', () => {
  browserTest(
    'without a service worker, notifications fall back to the page’s own: the test, a new item while away, and a click that opens its node',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const ledger = await cockpit.streams.create('human', {
          title: 'Ledger export format',
          goal: 'g',
        });
        page = await openPage({ permissions: ['notifications'], serviceWorkers: 'block' });
        await page.addInitScript(notifyStub());
        await page.goto(`${cockpit.base}/?view=settings`);
        const toggle = page.locator('[data-testid="settings-notify"]');
        await toggle.click();
        // T416: the switch says it is on (no status pill beside it).
        await waitUntilAsync('the switch to turn on', () => toggle.isChecked());
        await page.locator('[data-testid="settings-notify-test"]').click();
        await page.locator('[data-testid="settings-notify-sent"]').waitFor();
        expect(
          (await page.evaluate('window.__notes.map((n) => `${n.tag} via ${n.via}`)')) as string[],
        ).toEqual(['agile-test via page']);

        await page.evaluate('window.__setAway(true)');
        await cockpit.questions.raise({
          stream: ledger.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          text: 'Tabs or commas?',
        });
        await waitUntilAsync(
          'a notification',
          async () => page !== undefined && (await needsMeNotes(page)).length > 0,
        );
        expect(await lastNoteVia(page)).toBe('page');
        expect((await needsMeNotes(page)).at(-1)?.title).toBe('Question on Ledger export format');
        await clickLastNote(page);
        await page.locator(`[data-testid="stream-page"][data-stream="${ledger.id}"]`).waitFor();
        expect(await focusTries(page)).toBeGreaterThan(0);
        expect((await needsMeNotes(page)).at(-1)?.closed).toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a page that throws shows a card in words; the sidebar still works, navigating resets it, and Copy details and Try again work',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const ledger = await cockpit.streams.create('human', {
          title: 'Ledger export format',
          goal: 'g',
        });
        const csv = await cockpit.streams.create('human', { title: 'Add CSV import', goal: 'g' });
        // The routes below stub the daemon; a worker's fetches would pass them by.
        page = await openPage({
          permissions: ['clipboard-read', 'clipboard-write'],
          serviceWorkers: 'block',
        });
        // A page payload of the wrong shape (a daemon and a page from different
        // builds): valid JSON, so it loads, and the node page throws rendering it.
        const broken = `**/api/streams/${ledger.id}`;
        await page.route(broken, (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
        );
        await page.goto(`${cockpit.base}/?node=${ledger.id}`);
        const card = '[data-testid="error-boundary"]';
        await page.locator(card).waitFor();
        expect(await page.locator(card).getAttribute('data-area')).toBe('page');
        expect(await page.locator(card).getAttribute('data-kind')).toBe('error');
        expect(await page.locator('[data-testid="error-boundary-title"]').textContent()).toBe(
          'Something went wrong on this page',
        );
        expect(
          await page.locator('[data-testid="error-boundary-message"]').textContent(),
        ).toContain('Cannot read properties of undefined');
        expect(await page.locator(`${card} button`).allTextContents()).toEqual([
          'Try again',
          'Reload',
          'Copy details',
        ]);

        // The sidebar still works: Needs me opens, and the card is gone.
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        expect(await page.locator(card).count()).toBe(0);
        // Another node opens as usual.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${csv.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${csv.id}"]`).waitFor();
        expect(await page.locator(card).count()).toBe(0);

        // Back on the broken one: Copy details has the message, the stack and where.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${ledger.id}"]`).click();
        await page.locator(card).waitFor();
        await page.locator('[data-testid="error-boundary-copy"]').click();
        await waitForText(page, '[data-testid="error-boundary-copy"]', 'Copied');
        const copied = (await page.evaluate('navigator.clipboard.readText()')) as string;
        expect(copied).toStartWith('TypeError: Cannot read properties of undefined');
        expect(copied).toContain(`node=${ledger.id}`);
        expect(copied).toContain('Stack:');
        expect(copied).toContain('Components:');

        // Fixed behind the page: Try again shows it.
        await page.unroute(broken);
        await page.locator('[data-testid="error-boundary-retry"]').click();
        await page.locator(`[data-testid="stream-page"][data-stream="${ledger.id}"]`).waitFor();
        expect(await page.locator(card).count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a node’s tab that throws keeps the header, the tabs and the other tabs working',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const ledger = await cockpit.streams.create('human', {
          title: 'Ledger export format',
          goal: 'g',
        });
        page = await openPage({ serviceWorkers: 'block' });
        // One Activity row with no event in it: the tab throws rendering it.
        await page.route(`**/api/streams/${ledger.id}/activity`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"activity":[{}]}',
          }),
        );
        await page.goto(`${cockpit.base}/?node=${ledger.id}`);
        const node = `[data-testid="stream-page"][data-stream="${ledger.id}"]`;
        await page.locator(`${node} [data-tab-body="thread"]`).waitFor();
        await page.locator(`${node} .cr-node-tabs [data-tab="activity"]`).click();
        const card = `${node} [data-testid="error-boundary"]`;
        await page.locator(card).waitFor();
        expect(await page.locator(card).getAttribute('data-area')).toBe('tab');
        expect(await page.locator('[data-testid="error-boundary-title"]').textContent()).toBe(
          'Something went wrong in this tab',
        );
        // The node's header is still there, and another tab resets it.
        expect(await page.locator(`${node} .cr-node-tabs`).count()).toBe(1);
        await page.locator(`${node} .cr-node-tabs [data-tab="thread"]`).click();
        await page.locator(`${node} [data-tab-body="thread"]`).waitFor();
        expect(await page.locator(card).count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a view whose code is gone after a rebuild says a new version is available, and Reload opens it',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage({ serviceWorkers: 'block' });
        // Settings loads on demand; a rebuild deleted the chunk this page names.
        const gone = '**/control-room/assets/Settings-*.js';
        await page.route(gone, (route) => route.fulfill({ status: 404, body: 'not found' }));
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        await page.locator('[data-view="settings"]').click();
        const card = '[data-testid="error-boundary"][data-kind="update"]';
        await page.locator(card).waitFor();
        expect(await page.locator('[data-testid="error-boundary-title"]').textContent()).toBe(
          'A new version of the cockpit is available',
        );
        expect(await page.locator('[data-testid="error-boundary-message"]').count()).toBe(0);
        // The sidebar still works.
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        expect(await page.locator(card).count()).toBe(0);

        // The new build is there: Reload opens the view.
        await page.unroute(gone);
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="error-boundary-reload"]').click();
        await page.locator('[data-testid="settings"]').waitFor();
        expect(await page.locator('[data-testid="error-boundary"]').count()).toBe(0);
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
      const local = mkdtempSync(join(tmpdir(), 'agile-delivery-e2e-local-'));
      try {
        git(['init', '-q', '-b', 'main'], repo);
        git(['remote', 'add', 'origin', 'git@github.com:acme/api.git'], repo);
        await cockpit.store.addRepo('api', { path: repo });
        // T384: a repo with no remote can't open pull requests: the option says why.
        git(['init', '-q', '-b', 'main'], local);
        await cockpit.store.addRepo('scratch', { path: local });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="settings"]').click();
        await page.locator('[data-testid="settings-nav-repos"]').click();
        const row = '[data-testid="settings-repo-api"]';
        const pr0 = '[data-testid="settings-repo-api-delivery"] [data-value="pr"]';
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
        const localPr = '[data-testid="settings-repo-scratch-delivery"] [data-value="pr"]';
        await page.locator(localPr).waitFor({ state: 'visible' });
        expect(await page.locator(localPr).isDisabled()).toBe(true);
        expect(await page.locator(localPr).getAttribute('title')).toContain('GitHub remote');
        expect(await page.locator(pr0).isDisabled()).toBe(false);

        const pr = pr0;
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
        rmSync(local, { recursive: true, force: true });
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
        // T377: the project's repositories are a checklist on the root's details.
        // T423: one Save for the group (repositories and tracker), once something changed.
        const apiBox = page.locator(
          '[data-testid="project-repos"] [data-testid="project-repo"][data-repo="api"]',
        );
        expect(await apiBox.isChecked()).toBe(true);
        expect(await page.locator('[data-testid="project-save"]').count()).toBe(0);
        expect(await selectedText(page, '[data-testid="project-tracker-system"]')).toBe('None');
        await apiBox.uncheck();
        await page.locator('[data-testid="project-save"]').click();
        await waitUntil(
          'the repo to leave the project',
          () => cockpit.projects.get(shop.id).repos.length === 0,
        );
        await page.locator('[data-testid="project-repos"] [data-testid="project-repo"]').check();
        await page.locator('[data-testid="project-save"]').click();
        await waitUntil('the repo back in the project', () =>
          cockpit.projects.get(shop.id).repos.includes('api'),
        );
        await page.locator('[data-testid="project-save"]').waitFor({ state: 'detached' });
        // T423: the Director's level reads as on its own panel, and Organise saves at once.
        expect(await selectedText(page, '[data-testid="director-autonomy-select"]')).toBe(
          'Advise — proposes, you apply',
        );
        expect(await page.locator('[data-testid="director-autonomy-hint"]').textContent()).toBe(
          'Drafts work; you press Create.',
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
        await page.locator('[data-testid="project-save"]').click();
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
        // T426: yours, so Add applies it at once.
        await waitUntil(
          'it to be accepted',
          () =>
            cockpit.store.listKnowledge().find((r) => r.name === 'money-in-cents')?.status ===
            'accepted',
        );
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
        // T368: the event in words, its node by title, and who was told (by title too).
        expect(await page.locator(`${row} [data-testid="event-log-type"]`).textContent()).toBe(
          'You wrote',
        );
        expect(await page.locator(`${row} [data-testid="event-log-node"]`).textContent()).toBe(
          'checkout',
        );
        expect(
          await page.locator(`${row} [data-testid="event-log-routing"]`).textContent(),
        ).toContain('checkout');
        const text = (await page.locator(row).textContent()) ?? '';
        expect(text).toContain('hi');
        expect(text).not.toContain(node.id);
        // The type filter and the search narrow the log; a miss says so.
        await page.locator('[data-testid="event-log-family"] [data-value="delivery"]').click();
        await page.locator(row).waitFor({ state: 'detached' });
        await page.locator('[data-testid="event-log-family"] [data-value="messages"]').click();
        await page.locator(row).waitFor({ state: 'visible' });
        await page.locator('[data-testid="event-log-search"]').fill('no such words');
        await page.locator('[data-testid="event-log"] .cr-empty').waitFor({ state: 'visible' });
        await page.locator('[data-testid="event-log-search"]').fill('checkout');
        await page.locator(row).waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Ask from anywhere (Playwright e2e, T419, D42)', () => {
  browserTest(
    'a on a work node asks about it in a new conversation under it, and the node stays work; its ⋯ menu opens Ask too',
    async () => {
      const cockpit = await startStreamCockpit([{ steps: [{ type: 'end_turn' }] }]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        // T435 (#20): a closed node, listed last in the picker.
        const old = await cockpit.streams.create('human', {
          title: 'Old experiment',
          goal: 'g',
          project: shop.id,
        });
        await cockpit.streams.close('human', old.id);
        const work = await cockpit.streams.create('human', {
          title: 'Add CSV import',
          goal: 'import CSV files into the ledger',
          project: shop.id,
          repo: 'demo',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${work.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${work.id}"]`).waitFor();

        // `a`: the box opens aimed at the open node.
        await page.keyboard.press('a');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="ask-target"]').getAttribute('data-value')).toBe(
          work.id,
        );
        const question = 'Why does the importer read the whole file into memory?';
        await page.locator('[data-testid="ask-input"]').fill(question);
        await page.locator('[data-testid="ask-input"]').press('Enter');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'detached' });

        // A conversation under the node, open on its chat, the question as your first message.
        await waitUntil('the conversation to exist', () =>
          cockpit.streams.list().some((s) => s.parent === work.id),
        );
        const asked = cockpit.streams.list().find((s) => s.parent === work.id);
        expect(asked?.goal).toBe(question);
        expect(asked?.repo).toBeUndefined();
        await page.locator(`[data-testid="stream-page"][data-stream="${asked?.id}"]`).waitFor();
        // T435 (#10): in the thread's own list, after "Node created", under one day divider.
        const bubble = page.locator(
          '[data-testid="thread"] [data-testid="chat-question"][data-variant="you"] .cr-bubble',
        );
        await bubble.waitFor();
        expect(await bubble.textContent()).toContain(question);
        expect(await page.locator('[data-testid="goal-card"]').count()).toBe(0);
        expect(await page.locator('.cr-chat .cr-day').count()).toBe(1);
        const firstRows = await page
          .locator('[data-testid="thread"] > li:not(.cr-day)')
          .evaluateAll((els) => els.slice(0, 2).map((el) => el.textContent ?? ''));
        expect(firstRows[0]).toContain('Node created');
        expect(firstRows[1]).toContain(question);
        // T435 (#20): straight on to its composer, for a follow-up.
        await page.waitForFunction("document.activeElement?.dataset?.testid === 'composer-input'");
        // The node it is about is still work (D42), in the tree too.
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${work.id}"][data-role="work"]`)
          .waitFor();
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${asked?.id}"][data-role="conversation"]`,
          )
          .waitFor();

        // The node's ⋯ menu opens it too.
        await page.goto(`${cockpit.base}/?node=${work.id}`);
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="ask-about"]').click();
        await page.locator('[data-testid="ask"]').waitFor({ state: 'visible' });
        // T435 (#20): its picker shows each node's status dot, the closed one last.
        await page.locator('[data-testid="ask-target"]').click();
        const targets = page.locator('[data-testid="ask-target-option"]');
        await targets.first().waitFor();
        const order = await targets.evaluateAll((els) =>
          els.map((el) => [el.getAttribute('data-target'), el.querySelector('.cr-dot') !== null]),
        );
        expect(order[0]).toEqual(['director', false]);
        expect(order.at(-1)).toEqual([old.id, true]);
        expect(order.slice(1).every(([, dot]) => dot === true)).toBe(true);
        expect(await targets.last().locator('.cr-dot').getAttribute('data-status')).toBe('closed');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'detached' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'from Needs me, Ask is about the Director: the line goes to its thread',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor();
        await page.keyboard.press('a');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="ask-target"]').getAttribute('data-value')).toBe(
          'director',
        );
        await page.locator('[data-testid="ask-input"]').fill('What needs me today?');
        await page.locator('[data-testid="ask-send"]').click();
        await page.locator('[data-testid="director-page"]').waitFor();
        await page
          .locator('[data-testid="director-thread"] [data-testid="thread-entry"]', {
            hasText: 'What needs me today?',
          })
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

describe('Send to parent (Playwright e2e, T421, D42)', () => {
  browserTest(
    'a reply in a conversation goes up to the node it is about as your line; the conversation says so',
    async () => {
      const reply = 'Stream it: the files reach 2 GB.';
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'agent_text', text: reply }, { type: 'end_turn' }] },
        { steps: [{ type: 'end_turn' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const work = await cockpit.streams.create('human', {
          title: 'Add CSV import',
          goal: 'import CSV files',
          project: shop.id,
          repo: 'demo',
        });
        const side = await cockpit.streams.create('human', {
          title: 'Why buffer the file?',
          goal: 'why does the importer read the whole file?',
          parent: work.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${side.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${side.id}"]`).waitFor();
        await page.locator('[data-testid="attach"]').click();
        const answer = page.locator('[data-testid="thread-entry"][data-by="agent"]', {
          hasText: reply,
        });
        await answer.waitFor();

        // T435 (#16): answered, its header offers what follows, not Restart (⋯ keeps it).
        await page.locator('[data-testid="header-send-up"]').waitFor();
        await page.locator('[data-testid="header-turn-into-work"]').waitFor();
        expect(await page.locator('[data-testid="attach"]').count()).toBe(0);
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="restart"]').waitFor();
        await page.keyboard.press('Escape');

        // T435 (#2): the header's Send to starts from the last reply; near the cap it counts,
        // past it Send is off and says how to fix it (Enter doesn't send either).
        await page.locator('[data-testid="header-send-up"]').click();
        const input = page.locator('[data-testid="send-up-input"]');
        await input.waitFor();
        expect(await input.inputValue()).toBe(reply);
        expect(await page.locator('[data-testid="send-up-count"]').count()).toBe(0);
        await input.fill('x'.repeat(SEND_UP_MAX_CHARS + 1));
        const count = page.locator('[data-testid="send-up-count"][data-over="true"]');
        await count.waitFor();
        expect(await count.textContent()).toContain('Shorten it, or send the key point.');
        expect(await count.textContent()).toContain('3,001 / 3,000');
        expect(await page.locator('[data-testid="send-up-send"]').isDisabled()).toBe(true);
        await input.press('Enter');
        await page.waitForTimeout(200);
        expect(await page.locator('[data-testid="send-up"]').count()).toBe(1);
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="send-up"]').waitFor({ state: 'detached' });

        // The reply's hover action opens the box with its words; T435 (#12): Shift+Enter is a
        // new line, Enter sends them to the parent.
        await answer.hover();
        await answer.locator('[data-testid="send-up-line"]').click();
        await page.locator('[data-testid="send-up"]').waitFor({ state: 'visible' });
        expect(await input.inputValue()).toBe(reply);
        await input.press('End');
        await input.press('Shift+Enter');
        await input.pressSequentially('Worth it before merge.');
        expect(await page.locator('[data-testid="send-up"]').count()).toBe(1);
        await input.press('Enter');
        await page.locator('[data-testid="send-up"]').waitFor({ state: 'detached' });
        await waitUntil('the line on the parent', () =>
          cockpit.streams
            .readThread(work.id)
            .entries.some(
              (e) =>
                e.by === 'human' &&
                e.body ===
                  `From the conversation “Why buffer the file?”:\n\n${reply}\nWorth it before merge.`,
            ),
        );
        await page
          .locator('[data-testid="thread-entry"]', { hasText: 'Sent to Add CSV import' })
          .waitFor();
        // The node it is about is still work, not a coordinator.
        expect(cockpit.streams.get(work.id).sessions.every((s) => s.role !== 'coordinator')).toBe(
          true,
        );

        // T435 (#19): a closed parent takes nothing: no Send to on hover, in the header or ⋯.
        await cockpit.attach.stop(work.id).catch(() => {});
        await cockpit.streams.close('human', work.id);
        await page.locator('[data-testid="header-send-up"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="header-turn-into-work"]').waitFor();
        await answer.hover();
        expect(await answer.locator('[data-testid="send-up-line"]').count()).toBe(0);
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="turn-into-work-menu"]').waitFor();
        expect(await page.locator('[data-testid="send-up"]').count()).toBe(0);
        await page.keyboard.press('Escape');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Turn into work (Playwright e2e, T422, D42)', () => {
  browserTest(
    'a conversation becomes the work it concluded, in place: goal from its last reply, a repo, its agent started on it',
    async () => {
      const reply = 'Stream the upload in 1 MB chunks so 2 GB files import.';
      const cockpit = await startStreamCockpit([
        // The conversation's agent: answers, then idles.
        {
          turns: [[{ type: 'agent_text', text: reply }, { type: 'end_turn' }]],
          steps: [{ type: 'end_turn' }],
        },
        // Restarted in its worktree once it has a repo.
        { steps: [{ type: 'end_turn' }] },
        // The research conversation's agent.
        { steps: [{ type: 'end_turn' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const convo = await cockpit.streams.create('human', {
          title: 'Why buffer the file?',
          goal: 'why does the importer read the whole file?',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${convo.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${convo.id}"]`).waitFor();
        await page.locator('[data-testid="attach"]').click();
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: reply })
          .waitFor();

        // T435 (#16): answered, its header offers Turn into work… and Send to its parent (here
        // the project's root).
        expect(await page.locator('[data-testid="header-send-up"]').textContent()).toBe(
          'Send to shop',
        );
        await page.locator('[data-testid="header-turn-into-work"]').click();
        const goal = page.locator('[data-testid="turn-into-work-goal"]');
        // No cheap model offline: the goal starts as its last reply, yours to edit.
        await waitUntilAsync('the drafted goal', async () => (await goal.inputValue()) === reply);
        const newGoal = `${reply}\nDone when the 2 GB fixture imports.`;
        await goal.fill(newGoal);
        // T435 (#13): New node's grouping; a repo outside the project says it joins it.
        await page.locator('[data-testid="turn-into-work-repo"]').click();
        const groups = await page
          .locator('[data-testid="turn-into-work-repo-list"] .cr-picklist-group')
          .allTextContents();
        expect(groups).toEqual(['Repositories']);
        await page.locator('[data-testid="turn-into-work-repo-option"][data-repo="demo"]').click();
        await page.locator('[data-testid="turn-into-work-joins"]').waitFor();
        expect(await page.locator('[data-testid="turn-into-work-joins"]').textContent()).toBe(
          'Also adds demo to shop’s repositories.',
        );
        // At the top level there is nowhere else to put it.
        expect(await page.locator('[data-testid="turn-into-work-where"]').count()).toBe(0);
        // T435 (#12): Enter starts.
        await goal.press('Enter');
        await page.locator('[data-testid="turn-into-work"]').waitFor({ state: 'detached' });

        // Same node, same thread: now work on demo, its goal changed, its agent told to start.
        await waitUntil('the work node', () => {
          const node = cockpit.streams.get(convo.id);
          return (
            node.repo === 'demo' &&
            nodeRole(
              node,
              liveChildrenOf(node.id, cockpit.streams.list()),
              cockpit.streams.list(),
            ) === 'work' &&
            cockpit.streams
              .readThread(convo.id)
              .entries.some((e) => e.by === 'human' && e.body === START_ON_GOAL)
          );
        });
        expect(cockpit.streams.get(convo.id).goal).toBe(newGoal);
        await page.locator('[data-testid="node-role"][data-role="work"]').waitFor();
        // T435 (#27): its title was its question; now the goal's first line (the cheap model
        // names it better where there is one). T435 (#13): demo is one of the project's now.
        expect(cockpit.streams.get(convo.id).title).toBe(
          'Stream the upload in 1 MB chunks so 2 GB files import.',
        );
        expect(cockpit.store.getProject(shop.id).repos).toEqual(['demo']);
        // Its goal is a Goal card now: it is work. T441: and the question you asked still opens
        // the chat, kept on the record.
        await page.locator('[data-testid="goal-card"]').waitFor();
        expect(cockpit.streams.get(convo.id).question).toBe(
          'why does the importer read the whole file?',
        );
        expect(await page.locator('[data-testid="chat-question"]').textContent()).toContain(
          'why does the importer read the whole file?',
        );

        // No repository: it stays a conversation, researching the goal.
        const research = await cockpit.streams.create('human', {
          title: 'Import limits',
          goal: 'what limits the importer?',
          project: shop.id,
        });
        await page.goto(`${cockpit.base}/?node=${research.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${research.id}"]`).waitFor();
        // T431: a slow draft (a model call) never blocks the box nor overwrites what you typed.
        let release: () => void = () => {};
        const held = new Promise<void>((done) => {
          release = done;
        });
        await page.route('**/draft-goal', async (route) => {
          await held;
          await route.continue();
        });
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="turn-into-work-menu"]').click();
        await page.locator('[data-testid="turn-into-work-goal"][data-drafting="true"]').waitFor();
        await goal.fill('Find the largest file the importer takes and why.');
        release();
        // Nothing said yet: the draft is its question, offered, not forced.
        await page.locator('[data-testid="turn-into-work-use-draft"]').waitFor();
        expect(await goal.inputValue()).toBe('Find the largest file the importer takes and why.');
        await page.locator('[data-testid="turn-into-work-use-draft"]').click();
        expect(await goal.inputValue()).toBe('what limits the importer?');
        await goal.fill('Find the largest file the importer takes and why.');
        await page.locator('[data-testid="turn-into-work-start"]').click();
        await waitUntil('the research start', () =>
          cockpit.streams
            .readThread(research.id)
            .entries.some((e) => e.by === 'human' && e.body === START_ON_GOAL),
        );
        const after = cockpit.streams.get(research.id);
        expect(after.repo).toBeUndefined();
        expect(after.goal).toBe('Find the largest file the importer takes and why.');
        // T435 (#27): a title that isn't its question is yours: it stays.
        expect(after.title).toBe('Import limits');
        expect(cockpit.attachErrors).toEqual([]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('where the work goes under a work node (Playwright e2e, T435)', () => {
  browserTest(
    'Turn into work under a work node puts it next to that node by default, which stays work; Add repository and New node say it would coordinate',
    async () => {
      const reply = 'Strip the BOM and split on CRLF.';
      const cockpit = await startStreamCockpit([
        // The conversation's agent: answers, then idles.
        {
          turns: [[{ type: 'agent_text', text: reply }, { type: 'end_turn' }]],
          steps: [{ type: 'end_turn' }],
        },
        // Restarted in its worktree once it has a repo.
        { steps: [{ type: 'end_turn' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
          repos: ['demo'],
        });
        const work = await cockpit.streams.create('human', {
          title: 'Add CSV import',
          goal: 'import CSV files',
          project: shop.id,
          repo: 'demo',
        });
        const convo = await cockpit.streams.create('human', {
          title: 'Does import handle Excel files?',
          goal: 'does the importer take files saved by Excel?',
          parent: work.id,
        });
        const other = await cockpit.streams.create('human', {
          title: 'Why buffer the file?',
          goal: 'why does the importer read the whole file?',
          parent: work.id,
        });
        page = await openPage();

        // ⋯ Add repository on a conversation under a work node says what it does to that node.
        await page.goto(`${cockpit.base}/?node=${other.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${other.id}"]`).waitFor();
        await page.locator('[data-testid="node-role"]').waitFor();
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="add-repo"]').click();
        await page.locator('[data-testid="add-repo-coordinates"]').waitFor();
        expect(await page.locator('[data-testid="add-repo-coordinates"]').textContent()).toBe(
          'Add CSV import will coordinate it; its agent restarts as a coordinator.',
        );
        await page.keyboard.press('Escape');

        await page.goto(`${cockpit.base}/?node=${convo.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${convo.id}"]`).waitFor();
        await page.locator('[data-testid="attach"]').click();
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: reply })
          .waitFor();
        await page.locator('[data-testid="header-turn-into-work"]').click();
        const goal = page.locator('[data-testid="turn-into-work-goal"]');
        await waitUntilAsync('the drafted goal', async () => (await goal.inputValue()) === reply);
        // The other way: its parent's own agent does it.
        expect(await page.locator('[data-testid="turn-into-work-send-up"]').textContent()).toBe(
          'To have Add CSV import’s agent do it instead, use Send to Add CSV import.',
        );
        // Research under it changes nothing there: no Where until a repository is picked.
        expect(await page.locator('[data-testid="turn-into-work-where"]').count()).toBe(0);
        await page.locator('[data-testid="turn-into-work-repo"]').click();
        expect(
          await page
            .locator('[data-testid="turn-into-work-repo-list"] .cr-picklist-group')
            .allTextContents(),
        ).toEqual(['In shop', 'Other repositories']);
        await page.locator('[data-testid="turn-into-work-repo-option"][data-repo="demo"]').click();
        await page
          .locator('[data-testid="turn-into-work-where-next-to"][data-checked="true"]')
          .waitFor();
        expect(
          await page.locator('[data-testid="turn-into-work-where-under"]').textContent(),
        ).toContain('Add CSV import will coordinate it; its agent restarts as a coordinator.');
        // In the project already: nothing joins it.
        expect(await page.locator('[data-testid="turn-into-work-joins"]').count()).toBe(0);
        await goal.press('Enter');
        await page.locator('[data-testid="turn-into-work"]').waitFor({ state: 'detached' });

        // Next to it: under the project's root, on demo, started on the goal.
        await waitUntil('the work next to Add CSV import', () => {
          const node = cockpit.streams.get(convo.id);
          return (
            node.parent === shop.root &&
            node.repo === 'demo' &&
            cockpit.streams
              .readThread(convo.id)
              .entries.some((e) => e.by === 'human' && e.body === START_ON_GOAL)
          );
        });
        // Add CSV import is still work, its own agent never a coordinator.
        const all = cockpit.streams.list();
        expect(nodeRole(cockpit.streams.get(work.id), liveChildrenOf(work.id, all), all)).toBe(
          'work',
        );
        expect(cockpit.streams.get(work.id).sessions.every((s) => s.role !== 'coordinator')).toBe(
          true,
        );
        expect(cockpit.streams.get(convo.id).title).toBe('Strip the BOM and split on CRLF.');
        await page
          .locator(`[data-testid="stream-tree"] [data-stream="${work.id}"][data-role="work"]`)
          .waitFor();

        // New node under a work node, with a repository, says the same under its Parent.
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="new-stream-parent"]').click();
        await page.locator('[data-testid="new-stream-parent-search"]').fill('csv');
        await page.locator('[data-testid="new-stream-parent-search"]').press('Enter');
        expect(
          await page.locator('[data-testid="new-stream-parent"]').getAttribute('data-value'),
        ).toBe(work.id);
        // T445 (audit r7 #12): the project's one repository is picked; with none, no hint.
        await waitForAttr(page, '[data-testid="new-stream-repo"]', 'data-value', 'demo');
        await page.locator('[data-testid="new-stream-coordinates"]').waitFor();
        await page.locator('[data-testid="new-stream-no-repo"]').click();
        expect(await page.locator('[data-testid="new-stream-coordinates"]').count()).toBe(0);
        await page.locator('[data-testid="new-stream-repo"]').click();
        await page.locator('[data-testid="new-stream-repo-option"][data-repo="demo"]').click();
        expect(await page.locator('[data-testid="new-stream-coordinates"]').textContent()).toBe(
          'Add CSV import will coordinate it; its agent restarts as a coordinator.',
        );
        await page.keyboard.press('Escape');
        expect(cockpit.attachErrors).toEqual([]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('what a worker proposes next (Playwright e2e, T427)', () => {
  browserTest(
    'a propose_next line reads as the node it proposes; Create node… opens New node with its title and goal, next to this node on its repo',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'Ledger totals',
          goal: 'fix the totals',
          project: shop.id,
          repo: 'demo',
        });
        const goal = 'Export the ledger as CSV; done when a test covers it.';
        await cockpit.streams.appendThread(
          'agent',
          node.id,
          { kind: 'proposal', body: `next: Add CSV export — ${goal}` },
          ulid(),
        );
        // A proposal that isn't a propose_next (no title and goal) offers nothing to create;
        // T445 (audit r7 #3): a repo proposal (its ref) offers Add <repo>, and only that one.
        await cockpit.streams.appendThread('daemon', node.id, {
          kind: 'proposal',
          body: 'next: this needs a change in web too; add it?',
          ref: repoProposalRef('web'),
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${node.id}"]`).waitFor();
        await page.locator('[data-testid="node-role"]').waitFor();
        await page.locator('[data-testid="proposal-add-repo"]').waitFor();
        expect(await page.locator('[data-testid="proposal-add-repo"]').count()).toBe(1);
        expect(await page.locator('[data-testid="proposal-create-node"]').count()).toBe(1);
        // T435 (#26): "Next: <title>", the goal under it — not the raw verb.
        const proposal = page.locator('[data-testid="proposal-next"]');
        expect(await proposal.count()).toBe(1);
        expect(await proposal.locator('strong').textContent()).toBe('Add CSV export');
        expect(await proposal.textContent()).toBe(`Next: Add CSV export${goal}`);
        await page.locator('[data-testid="proposal-create-node"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="new-stream-title"]').inputValue()).toBe(
          'Add CSV export',
        );
        expect(await page.locator('[data-testid="new-stream-goal"]').inputValue()).toBe(goal);
        // T435 (#14): next to the proposing node (its project's top level here), on its repo.
        const parentPick = page.locator('[data-testid="new-stream-parent"]');
        expect(await parentPick.getAttribute('data-value')).toBe('');
        expect(
          await page.locator('[data-testid="new-stream-repo"]').getAttribute('data-value'),
        ).toBe('demo');
        // T435 (#7): typing a name and Enter picks that name, not the pinned current Top level;
        // nested under a work node with a repo, the Parent's hint says it would coordinate.
        await parentPick.click();
        await page.locator('[data-testid="new-stream-parent-search"]').fill('totals');
        await page.locator('[data-testid="new-stream-parent-search"]').press('Enter');
        expect(await parentPick.getAttribute('data-value')).toBe(node.id);
        await page.locator('[data-testid="new-stream-coordinates"]').waitFor();
        // A pinned option whose own words match is picked, too.
        await parentPick.click();
        await page.locator('[data-testid="new-stream-parent-search"]').fill('top');
        await page.locator('[data-testid="new-stream-parent-search"]').press('Enter');
        expect(await parentPick.getAttribute('data-value')).toBe('');
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-create"]').click();
        await waitUntil('the proposed node', () =>
          cockpit.streams
            .list()
            .some(
              (s) =>
                s.parent === shop.root &&
                s.repo === 'demo' &&
                s.title === 'Add CSV export' &&
                s.goal === goal,
            ),
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("replies you haven't read (Playwright e2e, T429)", () => {
  browserTest(
    'a reply that lands while you are elsewhere is listed in Needs me with a sidebar dot; opening it reads it',
    async () => {
      const reply = 'It buffers because the parser needs the header row first.';
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'agent_text', text: reply }, { type: 'end_turn' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const convo = await cockpit.streams.create('human', {
          title: 'Why buffer the file?',
          goal: 'why does the importer read the whole file?',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor();
        expect(await page.locator('[data-testid="replies"]').count()).toBe(0);

        // You asked, and went on with something else: the answer lands.
        const asked = await fetch(`${cockpit.base}/api/streams/${convo.id}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'why buffer?', start: true }),
        });
        expect(asked.status).toBe(201);
        const listed = page.locator(`[data-testid="reply"][data-stream="${convo.id}"]`);
        await listed.waitFor();
        expect(await listed.textContent()).toContain('Replied');
        await page.locator('[data-testid="replies-dot"]').waitFor();
        // T433: its row in the rail is marked too.
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${convo.id}"][data-unread="true"] [data-testid="tree-unread"]`,
          )
          .waitFor();
        // It is no Needs me card: nothing waits on a decision.
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        expect(await page.locator('[data-testid="inbox-empty"]').textContent()).toContain(
          'Nothing else waits on you',
        );

        // Opening it reads it.
        await listed.locator('.cr-reply-open').click();
        await page.locator(`[data-testid="stream-page"][data-stream="${convo.id}"]`).waitFor();
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', { hasText: reply })
          .waitFor();
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox"]').waitFor();
        expect(await page.locator('[data-testid="replies"]').count()).toBe(0);
        expect(await page.locator('[data-testid="replies-dot"]').count()).toBe(0);
        expect(await page.locator('[data-testid="tree-unread"]').count()).toBe(0);
        // Read stays read across a reload (per browser).
        await page.reload();
        await page.locator('[data-testid="inbox"]').waitFor();
        await page.locator('[data-testid="inbox-empty"]').waitFor();
        expect(await page.locator('[data-testid="replies"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("the Director's replies (Playwright e2e, T433)", () => {
  browserTest(
    "a Director reply you haven't read marks the sidebar and Replies; its page reads it",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor();
        expect(await page.locator('[data-testid="replies"]').count()).toBe(0);
        // T437: a Director line counts as a reply only when it answers you.
        await cockpit.store.appendDirectorThread({
          ts: new Date(Date.now() + 500).toISOString(),
          by: 'human',
          kind: 'line',
          body: 'What needs me?',
        });
        await cockpit.store.appendDirectorThread({
          ts: new Date(Date.now() + 1000).toISOString(),
          by: 'director',
          kind: 'line',
          body: 'Shop has two nodes waiting on you.',
        });
        const listed = page.locator('[data-testid="reply"][data-stream="director"]');
        await listed.waitFor();
        await page.locator('[data-view="director"] [data-testid="replies-dot"]').waitFor();
        await listed.locator('.cr-reply-open').click();
        await page.locator('[data-testid="director-page"]').waitFor();
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox"]').waitFor();
        expect(await page.locator('[data-testid="replies"]').count()).toBe(0);
        expect(
          await page.locator('[data-view="director"] [data-testid="replies-dot"]').count(),
        ).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('the sidebar keeps Needs me in sight (Playwright e2e, audit r5 #4)', () => {
  browserTest(
    'opening a node far down a long tree scrolls the tree, not Needs me and its count',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        let last = '';
        for (let n = 1; n <= 40; n += 1) {
          last = (
            await cockpit.streams.create('human', {
              title: `node ${String(n).padStart(2, '0')}`,
              goal: 'g',
              project: shop.id,
            })
          ).id;
        }
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${last}`);
        await page.locator(`[data-testid="stream-page"][data-stream="${last}"]`).waitFor();
        const inView = (selector: string) =>
          (page as Page).locator(selector).evaluate((el) => {
            const box = el.getBoundingClientRect();
            return (
              box.top >= 0 &&
              box.bottom <= (globalThis as unknown as { innerHeight: number }).innerHeight
            );
          });
        await page.locator(`[data-testid="stream-tree"] [data-stream="${last}"]`).waitFor();
        expect(await inView(`[data-testid="stream-tree"] [data-stream="${last}"]`)).toBe(true);
        expect(await inView('[data-testid="sidebar"] [data-view="inbox"]')).toBe(true);
        expect(await inView('[data-testid="sidebar"] [data-view="director"]')).toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
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
    'open a node, filter, reload: the same view; back returns to the previous node; a stale id falls back to the inbox and says so',
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

        // A stale node and project fall back to the inbox and "All" — T416: and a stale node
        // says so, rather than landing on Needs me without a word.
        await page.goto(`${cockpit.base}/?node=01ARZ3NDEKTSV4RRFFQ69G5FAV&project=P-gone`);
        await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });
        await page
          .locator('[data-testid="toast"]', { hasText: 'That node no longer exists' })
          .waitFor();
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
          'Move “checkout” and the node under it to the trash?',
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

        const toast = page.locator('[data-testid="toast"]', {
          hasText: 'Moved “checkout” to the trash',
        });
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
    'Trash (n) lists what Move to trash archived, and Restore brings it back',
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
        expect(await toggle.textContent()).toBe('Trash1');
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
        // T395: k and j walk the rows too.
        await page.keyboard.press('k');
        await page.keyboard.press('j');
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
        // T424: the project's root never ran either: Not started, not Idle.
        const rootRow = page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`);
        expect(await rootRow.getAttribute('data-status')).toBe('not_started');
        expect(await rootRow.getAttribute('title')).toContain('Not started');

        // T424 (finding 23): a row shows a grip on hover (a project's root never moves: none).
        const grip = row.locator('.cr-tree-grip');
        expect(await rootRow.locator('.cr-tree-grip').count()).toBe(0);
        expect(
          await grip.evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).opacity),
        ).toBe('0');
        await row.hover();
        await waitUntilAsync(
          'the grip shows on hover',
          async () =>
            (await grip.evaluate(
              (el) => el.ownerDocument.defaultView?.getComputedStyle(el).opacity,
            )) === '1',
        );
        expect(
          await grip.evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).cursor),
        ).toBe('grab');
        expect(await grip.locator('[data-icon="grip-vertical"]').count()).toBe(1);

        await page.locator('[data-testid="tree-legend-open"]').click();
        const legend = page.locator('[data-testid="tree-legend"]');
        await legend.locator('.cr-legend-body').waitFor({ state: 'visible' });
        const text = (await legend.textContent()) ?? '';
        for (const label of ['Needs you', 'Ready to merge', 'Working', 'Not started', 'Stopped']) {
          expect(text).toContain(label);
        }
        // T436 (audit r6 #23): "Replied" too, its dot as the rail draws a conversation's.
        const replied = legend.locator('[data-status="replied"]');
        expect(await replied.textContent()).toContain('Replied');
        expect(await replied.locator('.cr-dot').getAttribute('data-tone')).toBe('green');
        expect(await replied.locator('.cr-dot').getAttribute('aria-label')).toBe('Replied');
        // T424: the marks: the overlap button's two squares, and that rows drag.
        expect(await legend.locator('[data-mark="overlap"] [data-icon="overlap"]').count()).toBe(1);
        expect(await legend.locator('[data-mark="overlap"]').textContent()).toBe(
          'Overlaps another node; click to open it',
        );
        expect(await legend.locator('[data-mark="drag"]').textContent()).toBe(
          'Drag a row onto another to put it under it, or to its top or bottom edge to place it beside it (or ⋯ → Move to…)',
        );
        expect(await legend.locator('[data-icon="alert-triangle"]').count()).toBe(0);
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
        // T414 (D41): a title New node derived asks the daemon to name it.
        const creates: Array<Record<string, unknown>> = [];
        page.on('request', (r) => {
          if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/streams') {
            creates.push(r.postDataJSON() as Record<string, unknown>);
          }
        });
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
        await waitForText(page, '[data-testid="new-stream-model"]', 'Claude Opus 5.5 · lowChange');
        expect(
          await page.locator('[data-testid="new-stream-model"] span[title]').getAttribute('title'),
        ).toBe('claude/claude-opus-5-5 · low effort');
        // Cmd/Ctrl+Enter in the goal creates it.
        await page.locator('[data-testid="new-stream-goal"]').press('Control+Enter');
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });

        const created = cockpit.streams.list().find((x) => x.title === 'import CSV');
        expect(created?.goal).toBe('import CSV\nBank exports, with a header row.');
        expect(creates.map((c) => [c.title, c.auto_title])).toEqual([['import CSV', true]]);
        expect(created?.repo).toBe('demo');
        await waitForRunningWorker(page, cockpit, created?.id ?? '', traffic);
        // T363: with its agent running the page offers Stop, and the ⋯ menu Restart agent.
        expect(await page.locator('[data-testid="stop"]').textContent()).toBe('Stop');
        expect(await page.locator('[data-testid="attach"]').count()).toBe(0);
        await page.locator('[data-testid="node-menu-trigger"]').click();
        expect(await page.locator('[data-testid="restart"]').textContent()).toBe('Restart agent');
        await page.keyboard.press('Escape');
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
        await waitForText(page, '[data-testid="new-stream-model"]', 'Claude Opus 5.5 · high');
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
        // T363: Start agent is one click, with the defaults.
        await page.locator('[data-testid="attach"]').click();
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
        expect(await page.locator('[data-testid="attach"]').textContent()).toBe('Start agent');
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
        // T363: Add repository… is in the ⋯ menu and opens a dialog.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="add-repo"]').click();
        // T445 (audit r7 #23): the searchable repository picker.
        await page.locator('[data-testid="add-repo-select"]').click();
        await page.locator('[data-testid="add-repo-select-option"][data-repo="demo"]').click();
        await waitForAttr(page, '[data-testid="add-repo-select"]', 'data-value', 'demo');
        await page.locator('[data-testid="add-repo-submit"]').click();
        // T413: the branch reads by its name; the whole one is the chip's `data-branch`.
        await page.locator('[data-testid="node-branch"][data-branch^="stream/"]').waitFor();
        expect(cockpit.streams.get(node.id).repo).toBe('demo');
        await page
          .locator(`${root} [data-testid="thread"]`, { hasText: 'THREAD-MARKER-205' })
          .waitFor();

        // The agent's "web too?" proposal (T445: a repo proposal by its ref) carries an Add button.
        await cockpit.streams.appendThread('daemon', node.id, {
          kind: 'proposal',
          body: 'next: this needs a change in web too; add it?',
          ref: repoProposalRef('web'),
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
        // T446 (audit r7 #18): a part is named for its node, then its repo.
        expect(parts.map((p) => p.title).sort()).toEqual([
          'Sale prices · demo',
          'Sale prices · web',
        ]);
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

describe('an agent proposes a repo (Playwright e2e, T455)', () => {
  browserTest(
    "a conversation's propose_repo line shows Add <repo>; clicking it makes the node work on that repo, and the button goes",
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
        // The conversation's agent, as `runner/session.ts` registers it.
        const session = ulid();
        await cockpit.store.putAgent(session as AgentId, {
          vendor: 'claude',
          model: 'test-model',
          stream: node.id,
          last_seen: new Date().toISOString(),
          role: 'worker',
        });
        await cockpit.verbs.proposeRepo({
          session,
          repo: 'demo',
          why: 'the price badge is rendered there',
        });
        // Proposing changes nothing by itself.
        expect(cockpit.streams.get(node.id).repo).toBeUndefined();
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        const root = `[data-testid="stream-page"][data-stream="${node.id}"]`;
        await page.locator(root).waitFor();
        const line = page.locator(`${root} [data-testid="thread-entry"][data-kind="proposal"]`);
        await line.waitFor();
        expect(await line.locator('.cr-msg-body').textContent()).toContain(
          'Proposes adding demo: the price badge is rendered there',
        );
        expect(await line.locator('.cr-msg-body strong').textContent()).toBe('demo');
        const add = line.locator('[data-testid="proposal-add-repo"]');
        expect(await add.textContent()).toBe('Add demo');
        await add.click();
        // T205: the conversation becomes a work node on demo in place, the same thread.
        await page.locator('[data-testid="node-branch"][data-branch^="stream/"]').waitFor();
        const after = cockpit.streams.get(node.id);
        expect(after.repo).toBe('demo');
        expect(after.branch).toMatch(/^stream\//);
        expect(cockpit.streams.list().filter((s) => s.parent === node.id)).toEqual([]);
        await line.waitFor();
        await page.locator('[data-testid="proposal-add-repo"]').waitFor({ state: 'detached' });

        // Now a work node, its agent proposes web: Add web splits it into two parts, and the
        // button goes once web is a part (the node itself has no repo any more).
        await cockpit.verbs.proposeRepo({ session, repo: 'web', why: 'the badge component' });
        await page
          .locator(`${root} [data-testid="proposal-add-repo"]`, { hasText: 'Add web' })
          .click();
        await waitUntil(
          'two parts',
          () => cockpit.streams.list().filter((s) => s.parent === node.id).length === 2,
        );
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${node.id}"][data-role="coordinating"]`,
          )
          .waitFor();
        await page.locator('[data-testid="proposal-add-repo"]').waitFor({ state: 'detached' });
        expect(cockpit.streams.get(node.id).repo).toBeUndefined();
        expect(cockpit.attachErrors).toEqual([]);
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
              title: `Sale prices · ${repo}`,
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
          'Sale prices · demo, Sale prices · web wait for the plan',
        );
        // T450: the card is your move, so the coordinator's row reads Needs you.
        await page
          .locator(
            `[data-testid="stream-tree"] [data-stream="${node.id}"][data-status="needs_you"]`,
          )
          .waitFor({ state: 'attached' });

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
    'two api nodes in different projects touching prices.ts warn in the repo view and the rail; T424: the mark names the other node and opens it',
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
        // T424: a third node overlaps only a (on sale.ts), so a's mark leads to two nodes.
        const c = await cockpit.streams.create('human', {
          title: 'api: sale banner',
          goal: 'g',
          project: shop.id,
          repo: 'api',
        });
        const at = new Date().toISOString();
        await cockpit.streams.update('daemon', a.id, {
          touched: { files: ['prices.ts', 'sale.ts'], base: 'abc', at },
        });
        await cockpit.streams.update('daemon', b.id, {
          touched: { files: ['posts.ts', 'prices.ts'], base: 'abc', at },
        });
        await cockpit.streams.update('daemon', c.id, {
          touched: { files: ['sale.ts'], base: 'abc', at },
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const item = (id: string): string =>
          `[data-testid="stream-tree"] [data-tree-node="${id}"] > .cr-tree-item`;
        const mark = (id: string): string => `${item(id)} [data-testid="overlap-mark"]`;
        await page.locator(mark(a.id)).waitFor();
        await page.locator(mark(b.id)).waitFor();

        // A neutral two-squares glyph, not Needs me's alert triangle, and a button that names
        // the other node and the file.
        expect(await page.locator(`${mark(b.id)} [data-icon="overlap"]`).count()).toBe(1);
        expect(await page.locator(`${item(b.id)} [data-icon="alert-triangle"]`).count()).toBe(0);
        expect(await page.locator(mark(b.id)).evaluate((el) => el.tagName)).toBe('BUTTON');
        expect(await page.locator(mark(b.id)).getAttribute('title')).toBe(
          'Overlaps api: add salePrice on prices.ts\nClick to open api: add salePrice',
        );
        // An open project shows none: the rows under it carry their own.
        expect(await page.locator(mark(a.parent ?? '')).count()).toBe(0);
        expect(await page.locator(mark(b.parent ?? '')).count()).toBe(0);

        // One other node: the mark opens it.
        await page.locator(mark(b.id)).click();
        await page
          .locator(`[data-testid="stream-page"][data-stream="${a.id}"]`)
          .waitFor({ state: 'visible' });

        // Several: a small menu of them, each with its file.
        expect(await page.locator(mark(a.id)).getAttribute('title')).toBe(
          'Overlaps api: add /posts on prices.ts\nOverlaps api: sale banner on sale.ts',
        );
        await page.locator(mark(a.id)).click();
        const menu = `${item(a.id)} [data-testid="overlap-menu"]`;
        await page.locator(menu).waitFor({ state: 'visible' });
        expect(
          await page
            .locator(`${menu} [data-testid="overlap-open"]`)
            .evaluateAll((els) => els.map((el) => el.textContent)),
        ).toEqual(['api: add /postsprices.ts', 'api: sale bannersale.ts']);
        await page
          .locator(`${menu} [data-testid="overlap-open"]`, { hasText: 'sale banner' })
          .click();
        await page
          .locator(`[data-testid="stream-page"][data-stream="${c.id}"]`)
          .waitFor({ state: 'visible' });

        // Folded, a project speaks for the node inside it, and its mark opens that node.
        await page.locator(`${item(blog.root)} [data-testid="tree-caret"]`).click();
        await page.locator(mark(blog.root)).waitFor();
        expect(await page.locator(mark(blog.root)).getAttribute('title')).toBe(
          'api: add /posts overlaps api: add salePrice on prices.ts\nClick to open api: add /posts',
        );
        await page.locator(mark(blog.root)).click();
        await page
          .locator(`[data-testid="stream-page"][data-stream="${b.id}"]`)
          .waitFor({ state: 'visible' });
        // Opening a node inside unfolds its parent: the mark goes back to the node's own row.
        await page.locator(mark(blog.root)).waitFor({ state: 'detached' });

        await page.locator('[data-view="repos"]').click();
        const callouts = '[data-testid="repo-view"] [data-repo="api"] [data-testid="repo-overlap"]';
        await waitUntilAsync('the repo view names both overlaps', async () => {
          const texts = await page
            ?.locator(callouts)
            .evaluateAll((els) => els.map((el) => el.textContent));
          return (
            texts?.includes('api: add salePrice and api: add /posts both changed prices.ts') ===
              true && texts.includes('api: add salePrice and api: sale banner both changed sale.ts')
          );
        });
        // T436 (audit r6 #18): the callout wears the rail's neutral mark, not the alert triangle.
        expect(
          await page
            .locator('[data-testid="repo-view"] .cr-lens-overlap [data-icon="overlap"]')
            .count(),
        ).toBeGreaterThan(0);
        expect(
          await page
            .locator('[data-testid="repo-view"] .cr-lens-overlap [data-icon="alert-triangle"]')
            .count(),
        ).toBe(0);
        // T424c: each live node's status is a pill, as in Dependencies and Running.
        await page
          .locator('[data-testid="repo-view"] [data-repo="api"] [data-testid="repo-node-status"]')
          .first()
          .waitFor();
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
    "a parent lists every child with its status in the rail's words, and the agent's last card under it",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        // T413: a coordinating node (a project's root lists its nodes on its Overview instead).
        const sale = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
          parent: shop.root,
        });
        const api = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
          parent: sale.id,
          repo: 'api',
        });
        const cards = new CardService({ store: cockpit.store, streams: cockpit.streams });
        const after = await cockpit.streams.update('daemon', api.id, {
          agent: { status: 'working', progress: 'adding salePrice' },
          touched: { files: ['prices.ts'], base: 'abc', at: new Date().toISOString() },
        });
        await cards.refresh(after);
        // T413: a child that never posted a card is listed too.
        const quiet = await cockpit.streams.create('human', {
          title: 'web: sale badge',
          goal: 'g',
          project: shop.id,
          parent: sale.id,
          repo: 'api',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${sale.id}"]`).click();
        const card = `[data-testid="child-cards"] [data-node="${api.id}"]`;
        await waitForAttr(page, card, 'data-state', 'working');
        await waitForText(page, `${card} [data-testid="status-card-state"]`, 'Working');
        await waitForText(page, `${card} [data-testid="status-card-doing"]`, 'adding salePrice');
        await waitForText(page, `${card} [data-testid="status-card-files"]`, 'prices.ts');
        const none = `[data-testid="child-cards"] [data-node="${quiet.id}"]`;
        await waitForText(page, `${none} [data-testid="status-card-state"]`, 'Not started');
        expect(await page.locator(`${none} [data-testid="status-card-doing"]`).count()).toBe(0);

        // A corrupt card says so in words (the path:line is its tooltip); the others still render.
        const web = await cockpit.streams.create('human', {
          title: 'web: show sale',
          goal: 'g',
          project: shop.id,
          parent: sale.id,
          repo: 'api',
        });
        writeFileSync(
          join(cockpit.home, 'cards', `${web.id}.yaml`),
          `node: ${web.id}\ndoing: x\nstate: exploding\n`,
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale!' });
        const bad = `[data-testid="child-cards"] [data-node="${web.id}"] [data-testid="status-card-error-text"]`;
        await page.locator(bad).waitFor();
        expect(await page.locator(bad).getAttribute('title')).toContain(`cards/${web.id}.yaml:3:`);
        await waitForAttr(page, card, 'data-state', 'working');
        await waitForText(page, '[data-testid="child-cards"] .cr-count', '3');

        // T349: a child waiting on your answer reads Needs you, with the rail's amber dot…
        await cards.refresh(
          await cockpit.streams.update('daemon', api.id, { agent: { status: 'question' } }),
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale?' });
        await waitForAttr(page, card, 'data-state', 'question');
        await waitForText(page, `${card} [data-testid="status-card-state"]`, 'Needs you');
        await waitForAttr(page, `${card} .cr-dot`, 'data-dot', 'amber');
        // …and a real block reads Blocked, red.
        await cards.refresh(
          await cockpit.streams.update('daemon', api.id, { agent: { status: 'blocked' } }),
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale.' });
        await waitForAttr(page, card, 'data-state', 'blocked');
        await waitForText(page, `${card} [data-testid="status-card-state"]`, 'Blocked');
        await waitForAttr(page, `${card} .cr-dot`, 'data-dot', 'red');

        // T413: a finished child reads as the rail reads it, not as the card's "done".
        await cards.refresh(
          await cockpit.streams.update('daemon', api.id, { agent: { status: 'done' } }),
        );
        await cockpit.streams.update('human', web.id, { title: 'web: show sale,' });
        await waitForAttr(page, card, 'data-state', 'done');
        const railDot = page
          .locator(`[data-testid="stream-tree"] [data-stream="${api.id}"] .cr-dot[data-status]`)
          .first();
        const pill = page.locator(`${card} .cr-status-pill`);
        await waitUntilAsync(
          'the child and its rail row to read the same finished status',
          async () => {
            const [rail, own] = [
              await railDot.getAttribute('data-status'),
              await pill.getAttribute('data-status'),
            ];
            return rail !== null && rail !== 'working' && rail !== 'blocked' && rail === own;
          },
        );
        expect(await page.locator(`${card} [data-testid="status-card-state"]`).textContent()).toBe(
          await railDot.getAttribute('aria-label'),
        );
        expect(
          await page.locator(`${card} [data-testid="status-card-state"]`).textContent(),
        ).not.toBe('Done');

        // The project's root has no Children list: its Overview has them.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page
          .locator(
            `[data-testid="stream-page"][data-stream="${shop.root}"] [data-testid="node-details"]`,
          )
          .waitFor();
        expect(await page.locator('[data-testid="child-cards"]').count()).toBe(0);
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
              model: 'claude-sonnet-4-6',
              effort: 'high',
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
          'Opens pull requests',
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
        ).toBe('Merges directly');

        await page.locator('[data-view="running"]').click();
        const running = '[data-testid="running-lens"]';
        await page
          .locator(`${running} [data-stream="${shopApi.id}"]`)
          .waitFor({ state: 'visible' });
        expect(await page.locator(`${running} [data-stream]`).count()).toBe(1);
        // T382: the row says which agent, model and effort run there, in words; ids on hover.
        const agent = page.locator(
          `${running} [data-stream="${shopApi.id}"] [data-testid="running-agent"]`,
        );
        expect(await agent.textContent()).toBe('Claude Sonnet 4.6 · high');
        expect(await agent.getAttribute('title')).toBe(
          'Worker: claude/claude-sonnet-4-6 · high effort',
        );
        const runPath = `${running} [data-stream="${shopApi.id}"] [data-testid="node-path"]`;
        expect(await page.locator(runPath).textContent()).toBe(
          'Shop › Show sale prices › api: add salePrice',
        );
        // T424 (finding 37): the rail's "Show only this project" narrows Running, and the
        // path then leaves out the project's name; elsewhere, nothing runs.
        await page.goto(`${cockpit.base}/?view=running&project=${shop.id}`);
        await waitForText(page, runPath, 'Show sale prices › api: add salePrice');
        expect(await page.locator(`${running} .cr-page-sub`).textContent()).toBe('In Shop: 1 idle');
        await page.goto(`${cockpit.base}/?view=running&project=${blog.id}`);
        await waitForText(page, `${running} .cr-empty-title`, 'No agents running in Blog');
        await page.locator(`${running} [data-testid="running-show-all"]`).click();
        await page.locator(runPath).waitFor({ state: 'visible' });
        expect(new URL(page.url()).searchParams.get('project')).toBeNull();

        await page.locator('[data-view="deps"]').click();
        await waitForText(
          page,
          '[data-testid="deps-lens"] [data-testid="dep-edge-text"]',
          'api: add /posts waits on api: add salePrice',
        );
        // T424 (finding 36): both ends' statuses are the same pill, not a pill and plain text.
        const depCard = `[data-testid="deps-lens"] [data-node="${blogApi.id}"]`;
        expect(
          await page
            .locator(`${depCard} [data-testid="dep-status"]`)
            .evaluateAll((els) => els.map((el) => [el.className, el.getAttribute('data-status')])),
        ).toEqual([
          ['cr-status-pill', 'not_started'],
          ['cr-status-pill', 'idle'],
        ]);
        expect(await page.locator(`${depCard} .cr-lens-status`).count()).toBe(0);
        // T368: the waited-on node's status reads beside it; the ⋯ menu removes the link.
        expect(
          await page.locator('[data-testid="deps-lens"] [data-testid="dep-edge"]').textContent(),
        ).toContain('Idle');
        await page.locator('[data-testid="dep-menu-trigger"]').click();
        await page.locator('[data-testid="dep-remove"]').click();
        await page.locator('[data-testid="deps-lens"] .cr-empty').waitFor({ state: 'visible' });
        await waitUntil('the link to be removed', () =>
          (cockpit.streams.get(blogApi.id).waits_on ?? []).every((w) => w.node !== shopApi.id),
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T368: the command palette and the keyboard help ----------------------

describe('command palette and keyboard shortcuts (Playwright e2e, T368)', () => {
  browserTest(
    'Ctrl+K finds a node by part of its title and opens it; it runs Knowledge; ? shows the keys',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const sale = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
        });
        await cockpit.streams.create('human', {
          title: 'Fix rounding in totals',
          goal: 'g',
          project: shop.id,
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor({ state: 'visible' });
        const palette = '[data-testid="command-palette"]';
        const input = `${palette} [data-testid="palette-input"]`;

        // Part of a title, Enter: the node's page opens and the palette closes.
        await page.keyboard.press('Control+k');
        await page.locator(input).waitFor({ state: 'visible' });
        expect(
          (await page.evaluate('document.activeElement?.dataset?.testid ?? null')) as string,
        ).toBe('palette-input');
        await page.locator(input).fill('salepr');
        await waitForAttr(page, `${palette} [aria-selected="true"]`, 'data-key', `node:${sale.id}`);
        await page.keyboard.press('Enter');
        await page.locator(palette).waitFor({ state: 'detached' });
        await waitForText(page, '[data-testid="stream-title"]', 'api: add salePrice');

        // With nothing typed, the node just opened is recent — except while you are on it.
        await page.locator('[data-view="inbox"]').click();
        await page.keyboard.press('Control+k');
        await page.locator(input).waitFor({ state: 'visible' });
        await page
          .locator(`${palette} [data-testid="palette-item"][data-key="node:${sale.id}"]`)
          .waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.locator(palette).waitFor({ state: 'detached' });

        // It runs a view: Knowledge, by name (the sidebar's search button opens it too).
        await page.locator('[data-testid="palette-open"]').click();
        await page.locator(input).fill('Knowledge');
        await waitForAttr(page, `${palette} [aria-selected="true"]`, 'data-key', 'view:rules');
        await page.keyboard.press('Enter');
        await page.locator('[data-testid="rules-screen"]').waitFor({ state: 'visible' });

        // The arrows move the highlight; a miss says so.
        await page.keyboard.press('Control+k');
        await page.locator(input).fill('zzzzqqq');
        await page.locator(`${palette} [data-testid="palette-empty"]`).waitFor();
        await page.locator(input).fill('');
        const first = await page
          .locator(`${palette} [aria-selected="true"]`)
          .getAttribute('data-key');
        await page.keyboard.press('ArrowDown');
        expect(
          await page.locator(`${palette} [aria-selected="true"]`).getAttribute('data-key'),
        ).not.toBe(first);
        await page.keyboard.press('Escape');
        await page.locator(palette).waitFor({ state: 'detached' });

        // ? opens the keyboard help (not while typing); Esc closes it.
        await page.keyboard.press('?');
        const help = '[data-testid="shortcuts"]';
        await page.locator(help).waitFor({ state: 'visible' });
        expect(await page.locator(help).textContent()).toContain('New node');
        expect(await page.locator(help).textContent()).toContain('Ask about the open node');
        await page.keyboard.press('Escape');
        await page.locator(help).waitFor({ state: 'detached' });

        // T425: the palette runs Ask (T419); here, with no node open, it aims at the Director.
        await page.keyboard.press('Control+k');
        await page.locator(input).fill('ask a q');
        await waitForAttr(page, `${palette} [aria-selected="true"]`, 'data-key', 'action:ask');
        await page.keyboard.press('Enter');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="ask-target"]').getAttribute('data-value')).toBe(
          'director',
        );
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="ask"]').waitFor({ state: 'detached' });
        await page.locator('[data-testid="stream-filter"]').focus();
        await page.keyboard.press('?');
        expect(await page.locator(help).count()).toBe(0);
        await page.locator('[data-testid="stream-filter"]').blur();

        // g then i goes to Needs me.
        await page.locator('[data-view="events"]').click();
        await page.locator('[data-testid="event-log"]').waitFor({ state: 'visible' });
        await page.keyboard.press('g');
        await page.keyboard.press('i');
        await page.locator('[data-testid="inbox"]').waitFor({ state: 'visible' });
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
          'Main changed',
        );
        expect(await page.locator(`${row} [data-testid="activity-status"]`).textContent()).toBe(
          'Not seen by the agent yet',
        );

        // The subject itself was not routed the event.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${a.id}"]`).click();
        await page.locator('.cr-tabs [data-tab="activity"]').click();
        await page.locator('[data-testid="activity-empty"]').waitFor();

        // The repo view lists the repo's events.
        await page.locator('[data-view="repos"]').click();
        await waitForText(
          page,
          `[data-testid="repo-view"] [data-repo="api"] [data-event="${event.id}"] [data-testid="repo-event-text"]`,
          'Main changed · api: add salePrice',
        );
        // T368: the card's link opens Events on that repo.
        await page.locator('[data-repo="api"] [data-testid="repo-events-all"]').click();
        await page
          .locator(`[data-testid="event-log"] [data-event="${event.id}"]`)
          .waitFor({ state: 'visible' });
        expect(
          await page
            .locator('[data-testid="event-log-repo-filter"]')
            .inputValue()
            .catch(() => ''),
        ).toBe('api');
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
        await waitForText(page, `${row} [data-testid="activity-because"]`, 'itself');
        expect(await page.locator(`${row} [data-testid="activity-type"]`).textContent()).toBe(
          'Merged',
        );

        await page.locator('[data-view="repos"]').click();
        const repoEvent = (id: string) =>
          `[data-testid="repo-view"] [data-repo="api"] [data-event="${id}"] [data-testid="repo-event-text"]`;
        await waitForText(page, repoEvent(merged.id), 'Merged · api: direct change');
        expect(await page.locator(repoEvent(merged.id)).textContent()).not.toContain('PR merged');
        await waitForText(page, repoEvent(prMerged.id), 'PR merged · api: pr change');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('the event log pages (Playwright e2e, T383)', () => {
  browserTest(
    "Events pages from the daemon to the log's end; a repo card reads its own repo's events",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        // Two repos, so Events offers the repo filter.
        await cockpit.store.putRepos({ api: { path: cockpit.home }, web: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const quiet = await cockpit.streams.create('human', {
          title: 'api: quiet change',
          goal: 'g',
          project: shop.id,
          repo: 'api',
        });
        const busy = await cockpit.streams.create('human', {
          title: 'busy talk',
          goal: 'g',
          project: shop.id,
        });
        // The api event first, then more than a whole old cap (200) of newer events elsewhere.
        const onApi = await routeAndEmit(
          cockpit.events,
          {
            type: 'pr_merged',
            subject: quiet.id,
            repo: 'api',
            payload: { repo: 'api', sha: 'abc123' },
            by: 'daemon',
          },
          cockpit.streams.list(),
        );
        const rows = cockpit.streams.list();
        for (let i = 0; i < 205; i++) {
          await routeAndEmit(
            cockpit.events,
            { type: 'human_line', subject: busy.id, by: 'human', payload: { body: `line ${i}` } },
            rows,
          );
        }

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        // The repo card asks for api's own events, so the old one still shows.
        await page.locator('[data-view="repos"]').click();
        await waitForText(
          page,
          `[data-testid="repo-view"] [data-repo="api"] [data-event="${onApi.id}"] [data-testid="repo-event-text"]`,
          'Merged · api: quiet change',
        );

        // Events: the newest page, then older pages from the daemon until the log ends.
        await page.locator('[data-view="events"]').click();
        const logRows = page.locator('[data-testid="event-log-row"]');
        await waitForText(page, '[data-testid="event-log-count"]', '100 of 206 events');
        expect(await logRows.count()).toBe(100);
        expect(await page.locator('[data-testid="event-log-end"]').count()).toBe(0);
        const more = page.locator('[data-testid="event-log-more"]');
        expect(await more.textContent()).toBe('Show 100 more');
        await more.click();
        await waitForText(page, '[data-testid="event-log-count"]', '200 of 206 events');
        expect(await logRows.count()).toBe(200);
        expect(await more.textContent()).toBe('Show 6 more');
        await more.click();
        await waitForText(page, '[data-testid="event-log-count"]', '206 events');
        expect(await logRows.count()).toBe(206);
        await page.locator(`[data-testid="event-log"] [data-event="${onApi.id}"]`).waitFor();
        await waitForText(page, '[data-testid="event-log-end"]', 'That’s everything.');
        expect(await more.count()).toBe(0);

        // A live event goes on top of the loaded pages.
        const live = await routeAndEmit(
          cockpit.events,
          { type: 'human_line', subject: busy.id, by: 'human', payload: { body: 'live one' } },
          cockpit.streams.list(),
        );
        // The feed pushes on a log event; a thread line is one.
        await cockpit.streams.appendThread('human', busy.id, { kind: 'line', body: 'nudge' });
        await page.locator(`[data-testid="event-log"] [data-event="${live.id}"]`).waitFor();
        await waitForText(page, '[data-testid="event-log-count"]', '207 events');
        expect(await logRows.first().getAttribute('data-event')).toBe(live.id);

        // The repo filter asks the daemon: api's one event, however far back.
        await page.locator('[data-testid="event-log-repo-filter"]').selectOption('api');
        await waitForText(page, '[data-testid="event-log-count"]', '1 event');
        expect(await logRows.count()).toBe(1);
        await page.locator(`[data-testid="event-log"] [data-event="${onApi.id}"]`).waitFor();
        await page.locator('[data-testid="event-log-repo-filter"]').selectOption('');
        await waitForText(page, '[data-testid="event-log-count"]', '100 of 207 events');

        // A search covers what is loaded and offers to search further back.
        await page.locator('[data-testid="event-log-search"]').fill('quiet change');
        await page.locator('[data-testid="event-log"] .cr-empty').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="event-log"] .cr-empty').textContent()).toContain(
          'No matches in the latest 100 events',
        );
        await page.locator('[data-testid="event-log-more"]').click();
        await page.locator(`[data-testid="event-log"] [data-event="${onApi.id}"]`).waitFor();
        await waitForText(
          page,
          '[data-testid="event-log-end"]',
          'Searched all 207 events. That’s everything.',
        );
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
          'Make web: show salePrice wait on api: add salePrice',
        );
        // T446 (audit r7 #6): the card names the level (a link to where it is set) and what Apply does.
        expect(await page.locator(`${card} [data-testid="proposal-level"]`).textContent()).toBe(
          'Shop is at Advise: nothing changes until you apply. Apply makes it wait.',
        );
        expect(
          await page.locator(`${card} [data-testid="proposal-level-link"]`).textContent(),
        ).toBe('Advise');
        await page.locator(`${card} [data-testid="proposal-apply"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        expect(cockpit.streams.get(web.id).waits_on?.map((w) => w.node)).toEqual([api.id]);
        expect(cockpit.autonomy.get(id).status).toBe('applied');
        // T446: what you applied reads as yours on the node's chat.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page
          .locator('[data-testid="thread"] [data-variant="system"]', {
            hasText: 'You linked web: show salePrice to wait on api: add salePrice',
          })
          .waitFor();

        // The node's picker: override the project's Advise with Organise.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page.locator('[data-testid="autonomy-select"]').selectOption('organise');
        const deadline = Date.now() + 10_000;
        while (cockpit.streams.get(node.id).autonomy !== 'organise' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(cockpit.autonomy.levelFor(node.id)).toBe('organise');
        // T452: a card held on the node reads the node's own level, and links to it.
        const held = await cockpit.autonomy.act(node.id, 'coordinator', 'agent:test', {
          action: 'restart_node',
          node: api.id,
        });
        expect(held.applied).toBe(false);
        const heldId = held.applied ? '' : held.proposal.id;
        const heldCard = `[data-testid="inbox"] [data-kind="proposal"][data-id="${heldId}"]`;
        await page.locator('[data-view="inbox"]').click();
        await page.locator(`${heldCard} [data-testid="proposal-level"]`).waitFor();
        expect(await page.locator(`${heldCard} [data-testid="proposal-level"]`).textContent()).toBe(
          'Show sale prices is at Organise: restarting stuck work still comes to you. Apply restarts its agent.',
        );
        await page.locator(`${heldCard} [data-testid="proposal-level-link"]`).click();
        await page
          .locator('[data-testid="stream-title"]', { hasText: 'Show sale prices' })
          .waitFor();
        expect(await page.locator('[data-testid="autonomy-select"]').inputValue()).toBe('organise');
        await cockpit.autonomy.dismiss(heldId);

        // T347 (D36 D6): a work node has no coordinator, so no picker; the root has one.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${api.id}"]`).click();
        await page
          .locator('[data-testid="stream-title"]', { hasText: 'api: add salePrice' })
          .waitFor();
        expect(await page.locator('[data-testid="autonomy"]').count()).toBe(0);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="stream-title"]', { hasText: 'Shop' }).waitFor();
        await page.locator('[data-testid="autonomy"]').waitFor();

        // T423: one Autonomy group on the root, a labelled row each, the levels in words.
        const group = page.locator('[data-testid="autonomy-group"]');
        expect(await group.locator('.cr-autonomy-label').allTextContents()).toEqual([
          'Coordinator',
          'Director',
        ]);
        expect(
          await page.locator('[data-testid="autonomy-select"] option').allTextContents(),
        ).toEqual([
          'Advise — proposes, you apply',
          'Organise — makes changes itself',
          'Run — also approves contracts',
        ]);
        expect(await page.locator('[data-testid="autonomy-hint"]').textContent()).toBe(
          'Proposes new parts, links and owners; you apply them.',
        );
        expect(await page.locator('[data-testid="director-autonomy-hint"]').textContent()).toBe(
          'Drafts work; you press Create.',
        );
        // Run lets it act without asking: it asks first, and Cancel changes nothing.
        await page.locator('[data-testid="autonomy-select"]').selectOption('run');
        const confirm = page.locator('[data-testid="autonomy-run-confirm"]');
        await confirm.waitFor();
        expect(await confirm.textContent()).toContain('Let the coordinator run on its own?');
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await confirm.waitFor({ state: 'detached' });
        expect(await page.locator('[data-testid="autonomy-select"]').inputValue()).toBe('advise');
        expect(cockpit.projects.get(shop.id).autonomy.coordinator).toBe('advise');
        await page.locator('[data-testid="autonomy-select"]').selectOption('run');
        await page.locator('[data-testid="autonomy-run-confirm-confirm"]').click();
        await waitUntil(
          'the coordinator level to be Run',
          () => cockpit.projects.get(shop.id).autonomy.coordinator === 'run',
        );
        await page.locator('[data-testid="director-autonomy-select"]').selectOption('run');
        await page.locator('[data-testid="autonomy-run-confirm"]', { hasText: 'Shop' }).waitFor();
        await page.locator('[data-testid="autonomy-run-confirm-confirm"]').click();
        await waitUntil(
          'the Director level to be Run',
          () => cockpit.projects.get(shop.id).autonomy.director === 'run',
        );
        // The node follows its project in words; going back to it (now Run) asks too.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page
          .locator('[data-testid="autonomy-select"] option[value="inherit"]', {
            hasText: 'Inherits Run from the project',
          })
          .waitFor({ state: 'attached' });
        await page.locator('[data-testid="autonomy-select"]').selectOption('inherit');
        await page.locator('[data-testid="autonomy-run-confirm-confirm"]').click();
        await waitUntil(
          'the node to follow its project',
          () => cockpit.streams.get(node.id).autonomy === undefined,
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('project overview (Playwright e2e, T387)', () => {
  browserTest(
    "a project's root opens on its Overview: counts, its nodes your move first, repos and recent events; a row opens its node; the Chat tab still works",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home, delivery: 'pr' } });
        const shop = await cockpit.projects.create({ name: 'Shop', repos: ['api'] });
        const blog = await cockpit.projects.create({ name: 'Blog' });
        const docs = await cockpit.projects.create({ name: 'Docs' });
        const make = (title: string, extra: Record<string, unknown> = {}) =>
          cockpit.streams.create('human', { title, goal: 'g', project: shop.id, ...extra });
        const asks = await make('Pick a currency');
        const ready = await make('Add salePrice', { repo: 'api' });
        const feature = await make('Show sale prices');
        const working = await make('Show the sale badge', { parent: feature.id, repo: 'api' });
        const fresh = await make('Research pricing tiers');
        const merged = await make('Update the README', { repo: 'api' });
        const closed = await make('Old checkout experiment');
        const elsewhere = await cockpit.streams.create('human', {
          title: 'Launch post',
          goal: 'g',
          project: blog.id,
        });
        await cockpit.streams.update('daemon', asks.id, { agent: { status: 'question' } });
        await cockpit.streams.update('daemon', ready.id, { agent: { status: 'done' } });
        await cockpit.streams.update('daemon', working.id, { agent: { status: 'working' } });
        await cockpit.store.updateStream('daemon', working.id, (s) => ({
          ...s,
          sessions: [
            {
              id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              vendor: 'claude',
              model: 'claude-sonnet-4-6',
              effort: 'high',
              role: 'worker',
              status: 'running',
            },
          ],
        }));
        await cockpit.streams.update('daemon', merged.id, { human: { status: 'landed' } });
        await cockpit.streams.close('human', closed.id);
        // Events: two on Shop's nodes, one on Blog's (not Shop's to show).
        const onMerged = await routeAndEmit(
          cockpit.events,
          {
            type: 'pr_merged',
            subject: merged.id,
            repo: 'api',
            payload: { repo: 'api', sha: 'abc123' },
            by: 'daemon',
          },
          cockpit.streams.list(),
        );
        const onWorking = await routeAndEmit(
          cockpit.events,
          { type: 'human_line', subject: working.id, by: 'human', payload: { body: 'hi' } },
          cockpit.streams.list(),
        );
        const onBlog = await routeAndEmit(
          cockpit.events,
          { type: 'human_line', subject: elsewhere.id, by: 'human', payload: { body: 'hi' } },
          cockpit.streams.list(),
        );

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        await page.locator(`${tree} [data-stream="${shop.root}"]`).click();
        const overview = `[data-testid="stream-page"][data-stream="${shop.root}"] [data-testid="project-overview"]`;
        await page.locator(overview).waitFor({ state: 'visible' });
        // Overview is the first tab and the one open; the chat is the next.
        const tabs = '[data-testid="stream-page"] .cr-node-tabs button';
        expect(
          await page
            .locator(tabs)
            .evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute('data-tab'))),
        ).toEqual(['overview', 'thread']);
        expect(
          await page.locator(`${tabs}[data-tab="overview"]`).getAttribute('aria-current'),
        ).toBe('page');

        // T424: the root's agent never ran, as its Details say. T447 (audit r7 #2): a root with
        // parts reads as its most urgent part (Add salePrice is ready), and says so in words.
        expect(
          await page
            .locator('[data-testid="stream-page"] [data-testid="node-status"]')
            .getAttribute('data-status'),
        ).toBe('ready');
        expect(
          await page
            .locator('[data-testid="stream-page"] [data-testid="stream-status"]')
            .textContent(),
        ).toContain('Agent not started');
        expect(
          await page
            .locator('[data-testid="stream-page"] [data-testid="node-parts"]')
            .textContent(),
        ).toBe('1 of 3 merged · Add salePrice is ready to merge');
        expect(
          await page.locator(`${tree} [data-stream="${shop.root}"]`).getAttribute('data-status'),
        ).toBe('ready');

        // The counts, your move first: T424, one status each, with that status's own dot and word.
        // T447: the coordinating "Show sale prices" reads as its working part, so it is not
        // counted again (the part is).
        const counts = `${overview} [data-testid="overview-count"]`;
        await waitForCount(page, counts, 6);
        const chips = await page
          .locator(counts)
          .evaluateAll((els) =>
            els.map((el) => [
              el.getAttribute('data-status'),
              el.getAttribute('data-group'),
              el.textContent,
              el.querySelector('.cr-dot')?.getAttribute('data-status'),
            ]),
          );
        expect(chips).toEqual([
          ['needs_you', 'you', '1 needs you', 'needs_you'],
          ['ready', 'you', '1 ready to merge', 'ready'],
          ['working', 'in_progress', '1 working', 'working'],
          ['not_started', 'not_running', '1 not started', 'not_started'],
          ['merged', 'finished', '1 merged', 'merged'],
          ['closed', 'finished', '1 closed', 'closed'],
        ]);

        // The nodes: your move, in progress, not running; merged and closed folded under Finished.
        // T447: by top-level node, Show sale prices heading its part.
        const rows = `${overview} [data-testid="overview-node"]`;
        const shown = (): Promise<Array<string | null>> =>
          page
            ?.locator(rows)
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-stream'))) ??
          Promise.resolve([]);
        const showing = (what: string, ids: string[]): Promise<void> =>
          waitUntilAsync(what, async () => (await shown()).join() === ids.join());
        expect(await shown()).toEqual([asks.id, ready.id, feature.id, working.id, fresh.id]);
        const row = (id: string): string => `${rows}[data-stream="${id}"]`;
        expect(await page.locator(`${row(ready.id)} .cr-status-pill`).textContent()).toBe(
          'Ready to merge',
        );
        expect(
          await page.locator(`${row(working.id)} [data-testid="overview-node-path"]`).textContent(),
        ).toBe('Show the sale badge');
        expect(
          await page
            .locator(`${row(feature.id)} [data-testid="overview-branch-summary"]`)
            .textContent(),
        ).toBe('1 working');
        expect(
          await page
            .locator(`${row(working.id)} [data-testid="overview-node-agent"]`)
            .textContent(),
        ).toBe('Claude Sonnet 4.6 · high');
        expect(await page.locator(`${row(working.id)} [data-testid="repo-icon"]`).count()).toBe(1);
        expect(await page.locator(`${row(working.id)}`).textContent()).toContain('api');
        await page.locator(`${overview} [data-testid="overview-done-toggle"]`).click();
        await page.locator(row(closed.id)).waitFor({ state: 'visible' });
        expect((await shown()).slice(5)).toEqual([merged.id, closed.id]);

        // T424 (finding 16): the groups in order, each heading adding up its rows. T447: a
        // branch sits in the group its top-level node reads as, its nodes under it.
        const groups = await page
          .locator(`${overview} [data-testid="overview-group"]`)
          .evaluateAll((els) =>
            els.map((el) => ({
              group: el.getAttribute('data-group'),
              n: el.querySelector('.cr-ov-group-n')?.textContent,
              statuses: [...el.querySelectorAll('[data-testid="overview-node"]')].map((r) =>
                r.getAttribute('data-status'),
              ),
            })),
          );
        expect(groups.map((g) => [g.group, g.statuses])).toEqual([
          ['you', ['needs_you', 'ready']],
          ['in_progress', ['working', 'working']],
          ['not_running', ['not_started']],
          ['finished', ['merged', 'closed']],
        ]);
        for (const g of groups) expect(Number(g.n)).toBe(g.statuses.length);

        // A count filters the list to exactly its rows; again (or Show all) shows everything.
        for (const [status, , text] of chips) {
          const chip = `${counts}[data-status="${status}"]`;
          await page.locator(chip).click();
          expect(await page.locator(chip).getAttribute('aria-pressed')).toBe('true');
          const n = Number.parseInt(String(text), 10);
          await waitUntilAsync(`only the ${status} nodes`, async () => {
            const statuses = await page
              ?.locator(rows)
              .evaluateAll((els) => els.map((el) => el.getAttribute('data-status')));
            return statuses?.length === n && statuses.every((s) => s === status);
          });
          expect(await page.locator(`${overview} [data-testid="overview-group"]`).count()).toBe(1);
          await page.locator(chip).click();
          await waitForCount(page, rows, 7);
        }
        await page.locator(`${counts}[data-status="ready"]`).click();
        await showing('only the node ready to merge', [ready.id]);
        await page.locator(`${overview} [data-testid="overview-filter-clear"]`).click();
        await waitForCount(page, rows, 7);

        // The project's repos, and its events (not Blog's), newest first.
        const repo = `${overview} [data-testid="overview-repo"][data-repo="api"]`;
        expect(
          await page.locator(`${repo} [data-testid="overview-repo-delivery"]`).textContent(),
        ).toBe('Opens pull requests');
        expect(await page.locator(`${repo} [data-testid="repo-icon"]`).count()).toBe(1);
        expect(await page.locator(repo).textContent()).toContain('2 open nodes');
        const events = `${overview} [data-testid="overview-event"]`;
        await waitForCount(page, events, 2);
        expect(
          await page
            .locator(events)
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-event'))),
        ).toEqual([onWorking.id, onMerged.id]);
        expect(await page.locator(`${events}[data-event="${onBlog.id}"]`).count()).toBe(0);
        expect(
          await page.locator(`${events}[data-event="${onMerged.id}"]`).textContent(),
        ).toContain('Merged · Update the README');

        // A row opens its node, on its chat.
        await page.locator(row(ready.id)).click();
        await page
          .locator(`[data-testid="stream-page"][data-stream="${ready.id}"]`)
          .waitFor({ state: 'visible' });
        expect(await page.locator(`${tabs}[data-tab="overview"]`).count()).toBe(0);
        expect(await page.locator(`${tabs}[data-tab="thread"]`).getAttribute('aria-current')).toBe(
          'page',
        );
        expect(new URL(page.url()).searchParams.get('node')).toBe(ready.id);

        // Something on the root's own chat: the Overview says so, and Open chat goes there.
        const question = await cockpit.questions.raise({
          stream: shop.root,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'Which currency should the shop default to?',
        });
        // A deep link to the root opens on its Overview too.
        await page.goto(`${cockpit.base}/?node=${shop.root}`);
        await page.locator(overview).waitFor({ state: 'visible' });
        await page.locator(`${overview} [data-testid="overview-root-waiting"]`).waitFor();
        await page.locator(`${overview} [data-testid="overview-open-chat"]`).click();
        expect(await page.locator(`${tabs}[data-tab="thread"]`).getAttribute('aria-current')).toBe(
          'page',
        );
        // T413: a root's chat has no Goal card (its goal is the project's name).
        await page.locator('[data-testid="composer-input"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="goal-card"]').count()).toBe(0);
        await page.locator(`[data-testid="stream-needs"] [data-id="${question.id}"]`).waitFor();
        expect(await page.locator(overview).count()).toBe(0);
        // The Overview tab goes back.
        await page.locator(`${tabs}[data-tab="overview"]`).click();
        await page.locator(overview).waitFor({ state: 'visible' });

        // T403: the question's card in Needs me opens the root on its chat, where the card is.
        await page.locator('[data-view="inbox"]').click();
        await page
          .locator(`[data-testid="inbox"] [data-id="${question.id}"] [data-testid="open-stream"]`)
          .click();
        await page.locator(`[data-testid="stream-needs"] [data-id="${question.id}"]`).waitFor();
        expect(await page.locator(`${tabs}[data-tab="thread"]`).getAttribute('aria-current')).toBe(
          'page',
        );
        expect(await page.locator(overview).count()).toBe(0);

        // An empty project: "No nodes yet", and New node files into it.
        await page.locator(`${tree} [data-stream="${docs.root}"]`).click();
        const empty = `[data-testid="stream-page"][data-stream="${docs.root}"] [data-testid="overview-empty"]`;
        await page.locator(empty).waitFor({ state: 'visible' });
        expect(await page.locator(empty).textContent()).toContain('No nodes yet');
        await page.locator(`${empty} [data-testid="overview-new-node"]`).click();
        await page.locator('[data-testid="new-stream-goal"]').fill('write the guide');
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-create"]').click();
        await waitUntil('the node to exist', () =>
          cockpit.streams.list().some((s) => s.title === 'write the guide'),
        );
        const guide = cockpit.streams.list().find((s) => s.title === 'write the guide');
        expect(guide?.project).toBe(docs.id);
        expect(guide?.parent).toBe(docs.root);
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
        // T363: no tracker, so neither the ⋯ menu nor the details panel offers Tracker issue….
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="node-menu"]').waitFor();
        expect(await page.locator('[data-testid="tracker-menu"]').count()).toBe(0);
        await page.keyboard.press('Escape');
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

  browserTest(
    "T399: the Director's steps fold before its reply; a newer one shows after it",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const at = Date.now() - 60_000;
        const toolCall = (data: Record<string, unknown>) =>
          cockpit.store.appendEvent(
            buildEvent('tool_call', { agent: 'S-DIR', data: { stream: 'director', ...data } }),
          );
        await cockpit.store.appendDirectorThread({
          ts: new Date(at).toISOString(),
          by: 'human',
          kind: 'line',
          body: 'What is stuck?',
        });
        await toolCall({
          toolCallId: 'list-1',
          kind: 'read',
          title: 'List the projects',
          status: 'completed',
        });
        await toolCall({ toolCallId: 'grep-1', kind: 'search', title: 'Find blocked nodes' });
        await toolCall({ toolCallId: 'grep-1', status: 'failed' });
        // The reply comes after its steps (a later millisecond).
        await Bun.sleep(5);
        await cockpit.store.appendDirectorThread({
          ts: new Date().toISOString(),
          by: 'director',
          kind: 'line',
          body: 'One node in shop is blocked.',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-view="director"]').click();
        await page.locator('[data-testid="director-page"]').waitFor();

        const reply = page.locator('[data-testid="director-thread"] [data-testid="thread-entry"]', {
          hasText: 'One node in shop is blocked.',
        });
        const toggle = reply.locator('[data-testid="steps-fold"] [data-testid="steps-toggle"]');
        await waitUntilAsync(
          "the Director's folded steps",
          async () =>
            (await toggle.count()) === 1 &&
            (await toggle.textContent()) === 'Worked through 2 steps · 1 failed',
        );
        await toggle.click();
        expect(
          await reply
            .locator('[data-testid="step"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-status'))),
        ).toEqual(['done', 'failed']);

        // A step after the last reply (the socket brings it): folded at the end.
        await Bun.sleep(5);
        await toolCall({
          toolCallId: 'read-2',
          kind: 'read',
          title: 'Read the plan',
          status: 'completed',
        });
        const tail = page.locator('.cr-steps-tail [data-testid="steps-toggle"]');
        await waitUntilAsync(
          'the steps after the reply',
          async () =>
            (await tail.count()) === 1 && (await tail.textContent()) === 'Worked through 1 step',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('what the agents did on their own (Playwright e2e, T446)', () => {
  browserTest(
    "a coordinator's change is a linked row; Events and Activity record it; Undo removes what it made",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const blog = await cockpit.projects.create({ name: 'Blog' });
        await cockpit.projects.update(blog.id, { autonomy: { coordinator: 'organise' } });
        await cockpit.store.putRepos({ web: { path: cockpit.home } });
        const node = await cockpit.streams.create('human', {
          title: 'Schedule posts',
          goal: 'g',
          project: blog.id,
        });
        await cockpit.streams.create('human', {
          title: 'Schedule posts · web',
          goal: 'g',
          project: blog.id,
          parent: node.id,
          repo: 'web',
        });
        const out = await cockpit.autonomy.act(node.id, 'coordinator', 'agent:test', {
          action: 'add_child',
          title: 'Add an RSS field',
          goal: 'scheduled posts in the feed',
          repo: 'web',
        });
        expect(out.applied).toBe(true);
        const made = cockpit.streams.list().find((s) => s.title === 'Add an RSS field') as Stream;

        // #17: a routine wake folds into its reply; a wake with no reply is one muted row.
        const coord = ulid();
        await cockpit.store.updateStream('daemon', node.id, (before) => ({
          ...before,
          sessions: [
            { id: coord, vendor: 'claude', model: 'm', role: 'coordinator', status: 'stopped' },
          ],
        }));
        const daemonLine = (body: string, ref?: string) =>
          cockpit.streams.appendThread('daemon', node.id, {
            kind: 'event',
            body,
            ...(ref !== undefined ? { ref } : {}),
          });
        for (const reply of ['The web part merged; nothing else waits.', undefined]) {
          await daemonLine('woken by pr merged');
          await daemonLine('coordinator attached: claude/m effort=low', coord);
          if (reply !== undefined) {
            await cockpit.streams.appendThread(
              'agent',
              node.id,
              { kind: 'line', body: reply },
              coord,
            );
          }
          await daemonLine('session ended: its turn finished', coord);
        }

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        const thread = page.locator('[data-testid="thread"]');
        // #6: its own row (not its chat message), the part it made bold and linked.
        const added = thread.locator('[data-actor="coordinator"]', { hasText: 'Added a part' });
        await added.waitFor();
        expect((await added.textContent())?.replace(/\d\d:\d\d.*$/, '')).toBe(
          'Added a part: Add an RSS field (web)',
        );
        expect(await added.locator('a.cr-ref').getAttribute('data-node')).toBe(made.id);
        expect(await thread.locator('[data-variant="agent"]').count()).toBe(1);
        await waitUntilAsync('the reply names its wake', async () =>
          /^Woke for a merge · /.test(
            (await page?.locator('[data-testid="chat-wake"]').textContent()) ?? '',
          ),
        );
        expect(await thread.textContent()).not.toContain('Coordinator started');
        expect(await thread.textContent()).not.toContain('Agent finished its turn');
        await thread
          .locator('[data-variant="system"]', { hasText: 'Woke for a merge · nothing new' })
          .waitFor();
        await added.locator('a.cr-ref').click();
        await page
          .locator('[data-testid="stream-title"]', { hasText: 'Add an RSS field' })
          .waitFor();

        // #7: the node's Activity records it, with a link and Undo while nothing started.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        await page
          .locator('[data-testid="stream-page"] .cr-node-tabs [data-tab="activity"]')
          .click();
        const activity = page.locator('[data-testid="activity-row"]', {
          hasText: 'Coordinator added a part',
        });
        await activity.waitFor();
        // Its line names the part already, so its link reads Open.
        const link = activity.locator('[data-testid="applied-node"]');
        expect(await link.textContent()).toBe('Open');
        expect(await link.getAttribute('title')).toBe('Open Add an RSS field');
        expect(await activity.locator('[data-testid="activity-status"]').textContent()).toBe(
          'For the record',
        );
        await activity.locator('[data-testid="applied-undo"]').waitFor();

        // Events has it too; Undo there deletes the part it made.
        await page.locator('[data-view="events"]').click();
        const logRow = page.locator('[data-testid="event-log-row"][data-type="autonomy_applied"]');
        await logRow.waitFor();
        expect(await logRow.locator('[data-testid="event-log-type"]').textContent()).toBe(
          'Coordinator added a part',
        );
        // T451: the glyph is who made it.
        expect(
          await logRow.locator('.cr-lens-ev-glyph [data-icon]').getAttribute('data-icon'),
        ).toBe('bot');
        expect(await logRow.textContent()).toContain('Add an RSS field (web)');
        await logRow.locator('[data-testid="applied-undo"]').click();
        await waitUntil(
          'the part is deleted',
          () => cockpit.streams.get(made.id).archived === true,
        );
        await logRow.locator('[data-testid="applied-undo"]').waitFor({ state: 'detached' });
        await logRow.locator('[data-testid="applied-node-gone"]').waitFor();
        // Nobody was woken or told: the record is never pending.
        expect(cockpit.events.pendingFor(node.id)).toEqual([]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "a started part has no Undo; a part's contract proposal is a row in words",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const ops = await cockpit.projects.create({ name: 'Ops' });
        await cockpit.projects.update(ops.id, { autonomy: { coordinator: 'organise' } });
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const node = await cockpit.streams.create('human', {
          title: 'Rotate the API keys',
          goal: 'g',
          project: ops.id,
        });
        const part = await cockpit.streams.create('human', {
          title: 'Rotate the API keys · api',
          goal: 'g',
          project: ops.id,
          parent: node.id,
          repo: 'api',
        });
        await cockpit.autonomy.act(node.id, 'coordinator', 'agent:test', {
          action: 'add_child',
          title: 'Audit old keys',
          goal: 'list them',
          repo: 'api',
        });
        const made = cockpit.streams.list().find((s) => s.title === 'Audit old keys') as Stream;
        // It ran: a worker session, so nothing to undo.
        await cockpit.store.updateStream('daemon', made.id, (before) => ({
          ...before,
          sessions: [
            { id: ulid(), vendor: 'claude', model: 'm', role: 'worker', status: 'stopped' },
          ],
        }));
        const contract = await cockpit.contracts.write(
          node.id,
          { title: 'Key file', body: 'Keys live in one file.', parties: [part.id] },
          'human',
        );
        await cockpit.contracts.propose(contract.id, [part.id], {
          body: 'Keys live in /etc/keys/api.json.',
          reason: 'the rotation job reads one path',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${node.id}"]`).click();
        const proposal = page.locator('[data-testid="thread"] [data-kind="proposal"]');
        await proposal.waitFor();
        expect(await proposal.getAttribute('data-variant')).toBe('system');
        expect(await proposal.textContent()).toContain(
          'Rotate the API keys · api proposes a change to Key file: Keys live in /etc/keys/api.json. Why: the rotation job reads one path',
        );
        expect(await proposal.textContent()).not.toContain('CP-');

        await page.locator('[data-view="events"]').click();
        const logRow = page.locator('[data-testid="event-log-row"][data-type="autonomy_applied"]');
        await logRow.locator('[data-testid="applied-node"]').waitFor();
        expect(await logRow.locator('[data-testid="applied-undo"]').count()).toBe(0);
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

        // T451: in Events, your Create reads as yours; the Director's own change as its.
        await cockpit.projects.update(shop.id, { autonomy: { director: 'organise' } });
        const own = await cockpit.autonomy.act('director', 'director', 'agent:test', {
          action: 'create_node',
          node: { parent: shop.root, title: 'Price history', goal: 'keep old prices' },
        });
        expect(own.applied).toBe(true);
        await page.locator('[data-view="events"]').click();
        const glyphOf = (text: string) =>
          page
            ?.locator('[data-testid="event-log-row"][data-type="autonomy_applied"]', {
              hasText: text,
            })
            .locator('.cr-lens-ev-glyph [data-icon]')
            .getAttribute('data-icon');
        expect(await glyphOf('Show sale prices')).toBe('user');
        expect(await glyphOf('Price history')).toBe('sparkles');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T416: Needs me, errors in words, the palette and the page chrome --------------

/**
 * T416: cuts the page's `/ws` on demand (the daemon going away, as the page
 * sees it): open sockets close, and every reconnect is refused until
 * `restore`. Set up before the page loads.
 */
async function socketCutter(page: Page): Promise<{ cut(): Promise<void>; restore(): void }> {
  const state = { cut: false, live: new Set<WebSocketRoute>() };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (state.cut) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    state.live.add(ws);
  });
  return {
    async cut() {
      state.cut = true;
      for (const ws of state.live) await ws.close();
      state.live.clear();
    },
    restore() {
      state.cut = false;
    },
  };
}

/** A finished work node on the fixture repo with one commit ahead of main: Merge shows. */
async function finishedNode(
  cockpit: StreamCockpit,
  title: string,
  slug: string,
  parent?: string,
): Promise<string> {
  const stream = await cockpit.streams.create('human', {
    title,
    goal: 'g',
    repo: 'demo',
    ...(parent !== undefined ? { parent } : {}),
  });
  const worktree = join(cockpit.repo, '.worktrees', slug);
  git(['worktree', 'add', '-q', '-b', slug, worktree, 'main'], cockpit.repo);
  writeFileSync(join(worktree, `${slug}.txt`), `${slug}\n`);
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', slug], worktree);
  await cockpit.streams.update('daemon', stream.id, {
    branch: slug,
    worktree,
    agent: { status: 'done' },
  });
  return stream.id;
}

/** T470: a work node that finished with nothing on its branch (Finished, no changes). */
async function emptyFinishedNode(
  cockpit: StreamCockpit,
  title: string,
  slug: string,
  parent?: string,
): Promise<string> {
  const stream = await cockpit.streams.create('human', {
    title,
    goal: 'g',
    repo: 'demo',
    ...(parent !== undefined ? { parent } : {}),
  });
  const worktree = join(cockpit.repo, '.worktrees', slug);
  git(['worktree', 'add', '-q', '-b', slug, worktree, 'main'], cockpit.repo);
  await cockpit.streams.update('daemon', stream.id, {
    branch: slug,
    worktree,
    agent: { status: 'done', progress: `${title}: looked, nothing to change` },
  });
  return stream.id;
}

describe('Needs me as an inbox (Playwright e2e, T470)', () => {
  browserTest(
    'one row per item with Close and Open; categories; select and close several; close all finished',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const a = await emptyFinishedNode(cockpit, 'Count desktop files', 's-a');
        const b = await emptyFinishedNode(cockpit, 'Files in the branch', 's-b');
        const c = await emptyFinishedNode(cockpit, 'List the repos', 's-c');
        const ready = await finishedNode(cockpit, 'Add CSV import', 's-ready');
        const ledger = (await cockpit.streams.create('human', { title: 'Ledger', goal: 'g' })).id;
        const asked = await cockpit.questions.raise({
          stream: ledger,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'Store amounts how?',
          options: ['Integer cents', 'Floats'],
        });
        const p = await openPage({ inboxExpandAll: false });
        page = p;
        await p.goto(`${cockpit.base}/`);
        const rows = p.locator('[data-testid="inbox-row"]');
        await waitUntilAsync('five rows', async () => (await rows.count()) === 5);
        const row = (id: string) => `[data-testid="inbox-row"][data-item="${id}"]`;
        // A row: the subject, what it is and its line; no card until it is expanded.
        await p
          .locator(`${row(a)} [data-testid="inbox-what"]`, { hasText: 'Finished, no changes' })
          .waitFor();
        expect(await p.locator(`${row(a)} [data-testid="inbox-subject"]`).textContent()).toBe(
          'Count desktop files',
        );
        expect(await p.locator('[data-testid="inbox"] .cr-card').count()).toBe(0);
        await p.screenshot({ path: join(tmpdir(), 'agile-t470-inbox.png') });

        // The question expands in place and is answered there.
        await p.locator(`${row(asked.id)} [data-testid="inbox-expand"]`).click();
        await p
          .locator(`[data-testid="inbox"] [data-id="${asked.id}"] [data-testid="answer-choice"]`)
          .first()
          .waitFor();

        // Finished: its own tab.
        await p.locator('[data-testid="inbox-filter-finished"]').click();
        await waitUntilAsync('three finished rows', async () => (await rows.count()) === 3);

        // Select two and close them together.
        await p.locator(`${row(a)} [data-testid="inbox-select"]`).check();
        await p.locator(`${row(b)} [data-testid="inbox-select"]`).check();
        expect(await p.locator('[data-testid="inbox-selected"]').textContent()).toBe('2 selected');
        await p.locator('[data-testid="inbox-close-selected"]').click();
        await p
          .locator('[data-testid="inbox-close-confirm"] button', { hasText: 'Close 2 nodes' })
          .click();
        await waitUntil('two closed', () =>
          [a, b].every((id) => cockpit.streams.get(id).human.status === 'closed'),
        );
        expect(cockpit.streams.get(c).human.status).toBe('open');

        // Close all finished takes the rest; the merge-ready node stays.
        await p.locator('[data-testid="inbox-close-finished"]').click();
        await p
          .locator('[data-testid="inbox-close-confirm"] button', {
            hasText: 'Close all finished (1)',
          })
          .click();
        await waitUntil(
          'the last finished closed',
          () => cockpit.streams.get(c).human.status === 'closed',
        );
        expect(cockpit.streams.get(ready).human.status).toBe('open');

        // A row's own Close closes that node at once.
        await p.locator(`${row(ready)} [data-testid="inbox-close"]`).click();
        await waitUntil(
          'the ready node closed',
          () => cockpit.streams.get(ready).human.status === 'closed',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("No goal yet, and the Finished card's ✕ (Playwright e2e, T477)", () => {
  browserTest(
    'a Finished row and card dismiss with ✕ (the node stays open); a node with no goal has no Finished card until one is set',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const a = await emptyFinishedNode(cockpit, 'Count desktop files', 's-a');
        // Under a project, with nothing to merge: the node page's card is then Finished (a
        // node with changes has Merge in its header instead).
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const ready = await emptyFinishedNode(cockpit, 'List the repos', 's-ready', shop.root);
        // Started with no goal: its finished turn answered you; it is no Finished card.
        const talk = (
          await cockpit.streams.create('human', {
            title: 'Think about caching',
            repo: 'demo',
            parent: shop.root,
          })
        ).id;
        await cockpit.streams.update('daemon', talk, { agent: { status: 'done' } });
        const p = await openPage({ inboxExpandAll: false });
        page = p;
        await p.goto(`${cockpit.base}/`);
        const rows = p.locator('[data-testid="inbox-row"]');
        await waitUntilAsync('two rows', async () => (await rows.count()) === 2);
        const row = (id: string) => `[data-testid="inbox-row"][data-node-id="${id}"]`;
        expect(await p.locator(row(talk)).count()).toBe(0);

        // The row's ✕ dismisses; the node stays open.
        await p.locator(`${row(a)} [data-testid="inbox-dismiss"]`).click();
        await waitUntilAsync('the row gone', async () => (await rows.count()) === 1);
        expect(cockpit.streams.get(a).human.status).toBe('open');
        expect(cockpit.streams.get(a).human.dismissed_at).toBeString();

        // The card's ✕ (upper right) on the node page.
        await p.locator(`[data-testid="stream-tree"] [data-stream="${ready}"]`).click();
        await p
          .locator(`[data-testid="stream-page"] .cr-card[data-node-id="${ready}"]`)
          .first()
          .waitFor();
        await p
          .locator(
            `[data-testid="stream-page"] .cr-card[data-node-id="${ready}"] [data-testid="card-dismiss"]`,
          )
          .click();
        await waitUntil(
          'dismissed',
          () => cockpit.streams.get(ready).human.dismissed_at !== undefined,
        );
        expect(cockpit.streams.get(ready).human.status).toBe('open');
        await waitUntilAsync('no Finished rows', async () => (await rows.count()) === 0);

        // The no-goal node's page says so; setting one is "goal set".
        await p.locator(`[data-testid="stream-tree"] [data-stream="${talk}"]`).click();
        await p.locator('[data-testid="goal-none"]').waitFor();
        await p.locator('[data-testid="goal-edit"]', { hasText: 'Set a goal' }).click();
        await p.locator('[data-testid="goal-input"]').fill('Add a read-through cache');
        await p.locator('[data-testid="goal-save"]').click();
        await waitUntil(
          'the goal set',
          () => cockpit.streams.get(talk).goal === 'Add a read-through cache',
        );
        expect(cockpit.streams.readThread(talk).entries.at(-1)?.body).toBe(
          'goal set: Add a read-through cache',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'New node: "No goal yet" makes a node with no goal; the text is your first message',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream-talk-first"]').check();
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page
          .locator('[data-testid="new-stream-goal"]')
          .fill('should the cache live in the API or the client?');
        await page.locator('[data-testid="new-stream-create"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });
        let created: string | undefined;
        await waitUntil('made', () => {
          created = cockpit.streams
            .list()
            .find((x) => x.title.startsWith('should the cache live'))?.id;
          return created !== undefined;
        });
        const node = cockpit.streams.get(created as string);
        expect(node.goal).toBeUndefined();
        await waitUntil('your first message on its thread', () =>
          cockpit.streams
            .readThread(node.id)
            .entries.some(
              (e) =>
                e.by === 'human' && e.body === 'should the cache live in the API or the client?',
            ),
        );
        expect(node.sessions).toHaveLength(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Reorder siblings by dragging (Playwright e2e, T474)', () => {
  browserTest(
    "a drop on a row's top edge puts the node before it, on its bottom edge after it; the middle still nests",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'shop' });
        const node = (title: string) =>
          cockpit.streams.create('human', { title, goal: 'g', project: shop.id });
        const a = await node('alpha');
        const b = await node('bravo');
        const c = await node('charlie');
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const tree = '[data-testid="stream-tree"]';
        const row = (id: string) => (page as Page).locator(`${tree} [data-stream="${id}"]`);
        const order = async () =>
          (await (page as Page)
            .locator(`[data-tree-node="${shop.root}"] > ul > li > .cr-tree-item .cr-tree-row`)
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-stream')))) as string[];
        await row(c.id).waitFor();
        expect(await order()).toEqual([a.id, b.id, c.id]);

        // charlie onto alpha's top edge: first.
        await row(c.id).dragTo(row(a.id), { targetPosition: { x: 40, y: 2 } });
        await waitUntilAsync('charlie first', async () => (await order())[0] === c.id);
        expect(await order()).toEqual([c.id, a.id, b.id]);
        expect(cockpit.streams.get(c.id).parent).toBe(shop.root);

        // alpha onto bravo's bottom edge: last.
        const box = await row(b.id).boundingBox();
        await row(a.id).dragTo(row(b.id), {
          targetPosition: { x: 40, y: (box?.height ?? 30) - 2 },
        });
        await waitUntilAsync('alpha last', async () => (await order()).at(-1) === a.id);
        expect(await order()).toEqual([c.id, b.id, a.id]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Model and effort are two chips (Playwright e2e, T468)', () => {
  browserTest(
    'the effort chip sits right of the model; Shift+Tab in the composer steps it, and a start runs on it',
    async () => {
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'agent_text', text: 'On it.' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const node = await cockpit.streams.create('human', {
          title: 'Prices',
          goal: 'g',
          parent: shop.root,
        });
        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/?node=${node.id}`);
        await waitForText(p, '[data-testid="composer-model"]', 'Claude Opus 5.5');
        const effort = p.locator('[data-testid="composer-effort"]');
        await waitForText(p, '[data-testid="composer-effort"]', 'Low');
        // Right of the model chip.
        const modelBox = await p.locator('[data-testid="composer-model"]').boundingBox();
        const effortBox = await effort.boundingBox();
        expect((effortBox?.x ?? 0) > (modelBox?.x ?? 0)).toBe(true);
        const input = p.locator('[data-testid="composer-input"]');
        await input.focus();
        await p.keyboard.press('Shift+Tab');
        await waitForText(p, '[data-testid="composer-effort"]', 'Medium');
        await p.keyboard.press('Shift+Tab');
        await waitForText(p, '[data-testid="composer-effort"]', 'High');
        expect(await effort.getAttribute('data-chosen')).toBe('true');
        // Focus stayed in the box; a click steps too.
        expect(
          (await p.evaluate('document.activeElement?.dataset?.testid ?? null')) as string,
        ).toBe('composer-input');
        await effort.click();
        await waitForText(p, '[data-testid="composer-effort"]', 'Max');
        await input.fill('start on the prices');
        await input.press('Enter');
        await waitUntil('started', () => cockpit.streams.get(node.id).sessions.length > 0);
        expect(cockpit.streams.get(node.id).sessions[0]).toMatchObject({
          role: 'worker',
          model: 'claude-opus-5-5',
          effort: 'max',
        });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Ask picks the model (Playwright e2e, T472)', () => {
  browserTest(
    "the Ask box shows the composer's model chip; a pick starts the conversation on it",
    async () => {
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'agent_text', text: 'On it.' }, { type: 'hang' }] },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/?node=${shop.root}`);
        await p.locator(`[data-testid="stream-page"][data-stream="${shop.root}"]`).waitFor();
        await p.keyboard.press('a');
        const ask = p.locator('[data-testid="ask"]');
        await ask.waitFor({ state: 'visible' });
        await waitForText(
          p,
          '[data-testid="ask"] [data-testid="composer-model"]',
          'Claude Opus 5.5 · low',
        );
        await ask.locator('[data-testid="composer-model"]').click();
        const popover = p.locator('[data-testid="model-popover"]');
        await popover.locator('[data-model="claude-sonnet-4-6"]').click();
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(tmpdir(), 'agile-t472-ask.png') });
        // The chip closes its list again.
        await ask.locator('[data-testid="composer-model"]').click();
        await popover.waitFor({ state: 'detached' });
        await waitForText(
          p,
          '[data-testid="ask"] [data-testid="composer-model"]',
          'Claude Sonnet 4.6 · low',
        );
        await ask.locator('[data-testid="ask-input"]').fill('How are prices stored?');
        await ask.locator('[data-testid="ask-send"]').click();
        let made: string | undefined;
        await waitUntil('asked', () => {
          made = cockpit.streams.list().find((x) => x.goal === 'How are prices stored?')?.id;
          return made !== undefined && cockpit.streams.get(made).sessions.length > 0;
        });
        expect(cockpit.streams.get(made as string).sessions).toMatchObject([
          { role: 'worker', vendor: 'claude', model: 'claude-sonnet-4-6' },
        ]);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Talk and work are one kind of node (Playwright e2e, T473)', () => {
  browserTest(
    'New node opens on Talk or Work; a work node goes back to talk and back to work on the same branch',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
          repos: ['demo'],
        });
        const node = await finishedNode(cockpit, 'Add CSV import', 's-talk', shop.root);
        const branch = cockpit.streams.get(node).branch;
        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/`);
        await p.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await p.locator('[data-testid="new-stream-open"]').click();
        // A one-repo project starts on Work; Talk is one click, and says so in the picker.
        const work = p.locator('[data-testid="new-stream-kind-work"]');
        await waitUntilAsync(
          'Work picked',
          async () => (await work.getAttribute('aria-checked')) === 'true',
        );
        await p.locator('[data-testid="new-stream-kind-talk"]').click();
        await waitForText(p, '[data-testid="new-stream-repo"] .cr-pickfield-text', 'No repository');
        await work.click();
        await waitForText(p, '[data-testid="new-stream-repo"] .cr-pickfield-text', 'demo');
        await p.keyboard.press('Escape');

        // Back to just talk: the work is parked, nothing on disk moves.
        await p.goto(`${cockpit.base}/?node=${node}`);
        await p.locator('[data-testid="node-menu-trigger"]').click();
        await p.locator('[data-testid="node-menu"] [data-testid="menu-to-talk"]').click();
        await p.locator('[data-testid="to-talk-confirm"]').click();
        await waitUntil('talking', () => cockpit.streams.get(node).repo === undefined);
        expect(cockpit.streams.get(node).parked?.branch).toBe(branch);

        // Back to work on demo: the same branch again.
        await p.locator('[data-testid="node-menu-trigger"]').click();
        await p
          .locator('[data-testid="node-menu"] [data-testid="menu-to-work"]', { hasText: 'demo' })
          .click();
        await waitUntil('working', () => cockpit.streams.get(node).repo === 'demo');
        expect(cockpit.streams.get(node).branch).toBe(branch);
        expect(cockpit.streams.get(node).parked).toBeUndefined();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Closed, trash and Delete forever (Playwright e2e, T471)', () => {
  browserTest(
    'a closed node reopens from its header; Delete forever keeps an unmerged branch unless ticked; Empty trash',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const paused = (
          await cockpit.streams.create('human', { title: 'Paused', goal: 'g', parent: shop.root })
        ).id;
        await cockpit.streams.close('human', paused);
        const ready = await finishedNode(cockpit, 'Add CSV import', 's-trash', shop.root);
        const branch = cockpit.streams.get(ready).branch as string;
        const other = (
          await cockpit.streams.create('human', { title: 'Old idea', goal: 'g', parent: shop.root })
        ).id;
        await cockpit.streams.archiveTree('human', ready);
        await cockpit.streams.archiveTree('human', other);
        const p = await openPage();
        page = p;

        // Closed: not read-only. Its header offers Reopen, and Send would reopen it too.
        await p.goto(`${cockpit.base}/?node=${paused}`);
        await p
          .locator('[data-testid="composer-hint"]', { hasText: 'Reopens this node' })
          .waitFor();
        await p.locator('[data-testid="header-reopen"]').click();
        await waitUntil('reopened', () => cockpit.streams.get(paused).human.status === 'open');
        await p.locator('[data-testid="header-reopen"]').waitFor({ state: 'detached' });

        // Trash: Delete forever says what goes and offers the branch with its unmerged commit.
        const toggle = p.locator('[data-testid="deleted-toggle"]');
        await toggle.waitFor();
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await p
          .locator(
            `[data-testid="archived-row"][data-stream="${ready}"] [data-testid="archived-purge"]`,
          )
          .click();
        const dialog = p.locator('[data-testid="purge-dialog"]');
        await dialog.locator('[data-testid="purge-branches"]').waitFor();
        expect(await dialog.textContent()).toContain('1 unmerged commit');
        await p.locator('[data-testid="purge-dialog-confirm"]').click();
        await waitUntil('deleted forever', () => !cockpit.store.hasStream(ready));
        const branchThere = () =>
          Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
            cwd: cockpit.repo,
          }).exitCode === 0;
        expect(branchThere()).toBe(true);
        await p.locator('[data-testid="toast"]', { hasText: 'Kept its branch' }).waitFor();

        // Empty trash takes the rest.
        await p.locator('[data-testid="trash-empty"]').click();
        await p.locator('[data-testid="purge-dialog-confirm"]').click();
        await waitUntil('emptied', () => !cockpit.store.hasStream(other));
        await p.locator('[data-testid="deleted-nodes"]').waitFor({ state: 'detached' });
        expect(cockpit.store.hasStream(paused)).toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Auto-close (Playwright e2e, T478)', () => {
  browserTest(
    "the Settings default seeds New node's switch; a node page turns it on and off in Details and ⋯",
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?view=settings&section=general`);
        const setting = page.locator('[data-testid="settings-auto-close-switch"]');
        await waitUntilAsync('the setting read', async () => !(await setting.isDisabled()));
        expect(await setting.isChecked()).toBe(false);
        // A switch that follows the daemon: it flips once saved.
        await setting.click();
        await waitUntil('saved', () => cockpit.store.getHomeConfig().auto_close === true);
        await waitUntilAsync('on', async () => setting.isChecked());

        // New node starts with it on.
        await page.goto(`${cockpit.base}/`);
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await page.locator('[data-testid="new-stream-open"]').click();
        const fresh = page.locator('[data-testid="new-stream-auto-close"]');
        await waitUntilAsync('seeded from Settings', async () => fresh.isChecked());
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-goal"]').fill('count the desktop files');
        await page.locator('[data-testid="new-stream-create"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'detached' });
        let made: string | undefined;
        await waitUntil('made', () => {
          made = cockpit.streams.list().find((x) => x.goal === 'count the desktop files')?.id;
          return made !== undefined;
        });
        const id = made as string;
        expect(cockpit.streams.get(id).auto_close).toBe(true);

        // Its page: Details' switch turns it off; ⋯ turns it back on.
        await page.locator(`[data-testid="stream-page"][data-stream="${id}"]`).waitFor();
        const details = page.locator('[data-testid="details-auto-close"]');
        await waitUntilAsync('on in Details', async () => details.isChecked());
        await details.click();
        await waitUntil('off', () => cockpit.streams.get(id).auto_close === undefined);
        expect(cockpit.streams.readThread(id).entries.at(-1)?.body).toStartWith('auto-close off');
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page
          .locator('[data-testid="node-menu"] [data-testid="menu-auto-close"]', {
            hasText: 'Close when its goal is met',
          })
          .click();
        await waitUntil('on again', () => cockpit.streams.get(id).auto_close === true);
        await waitUntilAsync('Details follows', async () => details.isChecked());
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('Needs me, errors and the page chrome (Playwright e2e, T416)', () => {
  browserTest(
    'the first Merge asks (and can stop asking); a refusal reads in words under Merge, with its fix as a button, never as a toast',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const id = await finishedNode(cockpit, 'Add CSV import', 's-csv');
        page = await openPage();
        let lands = 0;
        await page.route(`**/api/streams/${id}/land`, (route) => {
          lands++;
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'merge refused: main moved; rebase the branch first' }),
          });
        });
        const said: Array<{ body: string; start?: boolean }> = [];
        await page.route(`**/api/streams/${id}/say`, (route) => {
          said.push(route.request().postDataJSON() as { body: string; start?: boolean });
          return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
        });
        await page.goto(`${cockpit.base}/?node=${id}`);
        await page.locator('[data-testid="stream-land"]').waitFor({ state: 'visible' });

        // The first Merge asks what it will do; Cancel merges nothing.
        const ask = '[data-testid="merge-confirm"]';
        await page.locator('[data-testid="stream-land"]').click();
        await page.locator(ask).waitFor({ state: 'visible' });
        expect(await page.locator(`${ask} h2`).textContent()).toContain(
          'Merge “Add CSV import” into main',
        );
        await page.locator(`${ask} button`, { hasText: 'Cancel' }).click();
        await page.locator(ask).waitFor({ state: 'detached' });
        expect(lands).toBe(0);

        // Merge, and don't ask again: the refusal reads under the header, in words.
        await page.locator('[data-testid="stream-land"]').click();
        await page.locator('[data-testid="merge-confirm-never"]').check();
        await page.locator('[data-testid="merge-confirm-confirm"]').click();
        const error = page.locator('[data-testid="merge-error"]');
        await error.waitFor({ state: 'visible' });
        expect(lands).toBe(1);
        const words = (await error.textContent()) ?? '';
        expect(words).toContain('Couldn’t merge.');
        expect(words).toContain('Main moved; rebase the branch first.');
        expect(words.toLowerCase()).not.toContain('merge refused');
        // It sits under the header's Merge, above the tabs — and no toast says it again.
        const merge = await page.locator('[data-testid="stream-land"]').boundingBox();
        const box = await error.boundingBox();
        const tabs = await page.locator('.cr-node-tabs').boundingBox();
        expect(merge && box ? box.y >= merge.y + merge.height : false).toBe(true);
        expect(box && tabs ? box.y + box.height <= tabs.y : false).toBe(true);
        expect(
          await page.locator('[data-testid="toast"]', { hasText: /refused|merge/i }).count(),
        ).toBe(0);

        // The fix it names is a button: a prepared message to the node's agent.
        const fix = page.locator('[data-testid="merge-fix"]');
        expect(await fix.textContent()).toBe('Ask the agent to rebase');
        await fix.click();
        await page.locator('[data-testid="merge-note"]').waitFor({ state: 'visible' });
        expect(said).toHaveLength(1);
        expect(said[0]?.start).toBe(true);
        expect(said[0]?.body).toContain('Bring your branch up to date with main');
        expect(await error.count()).toBe(0);

        // Remembered in this browser: the next Merge is one click.
        await page.locator('[data-testid="stream-land"]').click();
        await waitUntil('the second merge call', () => lands === 2);
        expect(await page.locator(ask).count()).toBe(0);
        await error.waitFor({ state: 'visible' });

        // A toast on a node's page sits above the composer, never over Send.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page
          .locator('[data-testid="node-menu"] [role="menuitem"]', { hasText: 'Copy node id' })
          .click();
        const toast = page.locator('[data-testid="toast"]').first();
        await toast.waitFor({ state: 'visible' });
        const toastBox = await toast.boundingBox();
        const composer = await page.locator('.cr-chat-foot .cr-compose').boundingBox();
        expect(toastBox && composer ? toastBox.y + toastBox.height <= composer.y : false).toBe(
          true,
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "Needs me: a refusal on the card with its fix; Ready to merge shows the agent's line; a blocked agent takes a reply; A/B pick a choice; Answer fills in",
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const csv = await finishedNode(cockpit, 'Add CSV import', 's-csv');
        const quiet = await finishedNode(cockpit, 'Fix rounding', 's-round');
        await cockpit.streams.update('daemon', csv, {
          agent: { progress: 'Added importCsv() in src/import.ts with a test for quoted fields.' },
        });
        const stuck = (await cockpit.streams.create('human', { title: 'Price cache', goal: 'g' }))
          .id;
        await cockpit.streams.update('daemon', stuck, {
          agent: { status: 'blocked', progress: 'Redis is not reachable from the worktree' },
        });
        const ledger = (await cockpit.streams.create('human', { title: 'Ledger', goal: 'g' })).id;
        const asked = await cockpit.questions.raise({
          stream: ledger,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'Store amounts how?',
          options: ['Integer cents', 'Floats'],
        });

        page = await openPage();
        await page.route(`**/api/streams/${csv}/land`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'refused',
              reason: 'merge refused: main moved; rebase the branch first',
              line: 'merge refused: main moved; rebase the branch first',
            }),
          }),
        );
        const said: Array<{ id: string; body: string; start?: boolean }> = [];
        await page.route('**/api/streams/*/say', (route) => {
          const id = new URL(route.request().url()).pathname.split('/')[3] ?? '';
          said.push({
            id,
            ...(route.request().postDataJSON() as { body: string; start?: boolean }),
          });
          return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
        });
        await page.goto(`${cockpit.base}/`);

        // Ready to merge: the agent's own line; with none, no stock sentence at all.
        const card = `[data-testid="inbox"] [data-kind="done"][data-id="${csv}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} [data-testid="inbox-context"]`).textContent()).toContain(
          'Added importCsv()',
        );
        const other = `[data-testid="inbox"] [data-kind="done"][data-id="${quiet}"]`;
        expect(await page.locator(`${other} [data-testid="inbox-context"]`).count()).toBe(0);
        expect(await page.locator(other).textContent()).not.toContain('Look over the changes');

        // Merge from the card asks too; a refusal says why on the card, with its fix.
        await page.locator(`${card} [data-testid="land"]`).click();
        await page.locator('[data-testid="merge-confirm"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="merge-confirm-confirm"]').click();
        const error = page.locator(`${card} [data-testid="card-error"]`);
        await error.waitFor({ state: 'visible' });
        expect(await error.textContent()).toContain(
          'Couldn’t merge. Main moved; rebase the branch first.',
        );
        expect(((await error.textContent()) ?? '').toLowerCase()).not.toContain('merge refused');
        await page.locator(`${card} [data-testid="card-fix"]`).click();
        await page.locator(`${card} [data-testid="card-notice"]`).waitFor({ state: 'visible' });
        expect(said.at(-1)?.id).toBe(csv);
        expect(said.at(-1)?.body).toContain('Bring your branch up to date');

        // T470: a blocked agent has its own filter, and a reply unblocks it.
        await page.locator('[data-testid="inbox-filter"] [data-value="blocked"]').click();
        const blocked = `[data-testid="inbox"] [data-kind="blocked"][data-id="${stuck}"]`;
        await page.locator(blocked).waitFor({ state: 'visible' });
        const reply = page.locator(`${blocked} [data-testid="blocked-send"]`);
        expect(await reply.getAttribute('data-variant')).toBe('secondary');
        expect(await reply.isDisabled()).toBe(true);
        await page
          .locator(`${blocked} [data-testid="blocked-reply"]`)
          .fill('Start Redis with docker compose up redis');
        expect(await reply.getAttribute('data-variant')).toBe('primary');
        await reply.click();
        await waitUntil('the reply to reach the node', () => said.some((s) => s.id === stuck));
        const sent = said.find((s) => s.id === stuck);
        expect(sent?.body).toBe('Start Redis with docker compose up redis');
        expect(sent?.start).toBe(true);

        // Answer is one variant everywhere: secondary while empty, primary once typed.
        await page.locator('[data-testid="inbox-filter"] [data-value="questions"]').click();
        const question = `[data-testid="inbox"] [data-id="${asked.id}"]`;
        const answer = page.locator(`${question} [data-testid="answer-send"]`);
        expect(await answer.getAttribute('data-variant')).toBe('secondary');
        await page.locator(`${question} [data-testid="answer-input"]`).fill('cents');
        expect(await answer.getAttribute('data-variant')).toBe('primary');
        await page.locator(`${question} [data-testid="answer-input"]`).fill('');

        // The keycaps work: on a focused card, B picks the second choice (and A the first,
        // without opening T419's Ask, which is `a` everywhere else).
        expect(await page.locator(`${question} .cr-choice-key`).allTextContents()).toEqual([
          'A',
          'B',
        ]);
        await page.locator(question).focus();
        await page.keyboard.press('b');
        await waitUntil('the answer to be recorded', () =>
          cockpit.questions.listOpen().every((q) => q.id !== asked.id),
        );
        expect(cockpit.questions.get(asked.id).answer).toBe('Floats');
        const again = await cockpit.questions.raise({
          stream: ledger,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'Round how?',
          options: ['Half up', 'Half even'],
        });
        const next = `[data-testid="inbox"] [data-id="${again.id}"]`;
        await page.locator(next).waitFor({ state: 'visible' });
        await page.locator(next).focus();
        await page.keyboard.press('a');
        await waitUntil('the second answer to be recorded', () =>
          cockpit.questions.listOpen().every((q) => q.id !== again.id),
        );
        expect(cockpit.questions.get(again.id).answer).toBe('Half up');
        expect(await page.locator('[data-testid="ask"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'the daemon going away: a bar in the flow, write buttons off with why, a failed send kept with Retry',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const node = await cockpit.streams.create('human', { title: 'Ledger', goal: 'g' });
        const asked = await cockpit.questions.raise({
          stream: node.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'Integer cents or floats?',
          options: ['Integer cents', 'Floats'],
        });
        page = await openPage();
        const socket = await socketCutter(page);
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-id="${asked.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        const header = await page.locator('[data-testid="inbox"] .cr-page-hd').boundingBox();

        await socket.cut();
        const bar = page.locator('[data-testid="offline-banner"]');
        await bar.waitFor({ state: 'visible' });
        expect(await bar.textContent()).toContain('Reconnecting to the daemon');
        // In the flow: it pushes the page down rather than covering its header or filter.
        const barBox = await bar.boundingBox();
        const moved = await page.locator('[data-testid="inbox"] .cr-page-hd').boundingBox();
        expect(barBox && moved ? barBox.y + barBox.height <= moved.y : false).toBe(true);
        expect(header && moved ? moved.y > header.y : false).toBe(true);
        // The card's actions are off, and say why.
        const choice = page.locator(`${card} [data-testid="answer-choice"]`).first();
        expect(await choice.isDisabled()).toBe(true);
        expect(await choice.getAttribute('title')).toBe('Reconnecting to the daemon…');

        // On the node: Send is off with the same why; Enter says the message wasn't sent, and keeps it.
        await page.locator(`${card} [data-testid="open-stream"]`).click();
        await page.locator('[data-testid="stream-page"]').waitFor({ state: 'visible' });
        const input = page.locator('[data-testid="composer-input"]');
        await input.fill('Integer cents, please.');
        const send = page.locator('[data-testid="composer-send"]');
        expect(await send.isDisabled()).toBe(true);
        expect(await send.getAttribute('title')).toBe('Reconnecting to the daemon…');
        // T423: the header's Start agent and Start with… are off too, and say why.
        const start = page.locator('[data-testid="attach"]');
        expect(await start.isDisabled()).toBe(true);
        expect(await start.getAttribute('title')).toBe('Reconnecting to the daemon…');
        expect(await page.locator('[data-testid="attach-options"]').isDisabled()).toBe(true);
        await input.press('Enter');
        const failed = page.locator('[data-testid="send-error"]');
        await failed.waitFor({ state: 'visible' });
        expect(await failed.textContent()).toContain(
          'Couldn’t reach the daemon; your message wasn’t sent.',
        );
        expect(await input.inputValue()).toBe('Integer cents, please.');
        expect(cockpit.delivered).toHaveLength(0);

        // Back: the bar goes, Send is on again, and Retry sends the kept draft.
        socket.restore();
        await bar.waitFor({ state: 'detached', timeout: 15_000 });
        expect(await send.isDisabled()).toBe(false);
        expect(await start.isDisabled()).toBe(false);
        await page.locator('[data-testid="send-retry"]').click();
        await waitUntil('the answer to be delivered', () => cockpit.delivered.length > 0);
        expect(cockpit.delivered[0]?.question.answer).toBe('Integer cents, please.');
        await failed.waitFor({ state: 'detached' });

        // A send that never reached the daemon while the socket is up reads the same way.
        const second = await cockpit.questions.raise({
          stream: node.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          session: ulid(),
          text: 'And the currency?',
        });
        await page.locator(`[data-testid="stream-needs"] [data-id="${second.id}"]`).waitFor();
        await page.route('**/api/questions/*/answer', (route) =>
          route.abort('internetdisconnected'),
        );
        await input.fill('EUR');
        await input.press('Enter');
        await failed.waitFor({ state: 'visible' });
        expect(await failed.textContent()).toContain('your message wasn’t sent');
        expect(await input.inputValue()).toBe('EUR');
        await page.unroute('**/api/questions/*/answer');
        await page.locator('[data-testid="send-retry"]').click();
        await waitUntil('the retried answer', () => cockpit.delivered.length > 1);
        expect(cockpit.delivered[1]?.question.answer).toBe('EUR');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '⌘K on a node lists what its page offers (This node), what waits on you, and recent nodes with nothing typed',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        // Nodes under a root (a top-level node is a root: the palette lists it as a project).
        const shop = await cockpit.streams.create('human', { title: 'Shop', goal: 'g' });
        const id = await finishedNode(cockpit, 'Add CSV import', 's-csv', shop.id);
        const other = await cockpit.streams.create('human', {
          title: 'Ledger format',
          goal: 'g',
          parent: shop.id,
        });
        await cockpit.questions.raise({
          stream: other.id,
          raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
          text: 'Should amounts be stored as integer cents?',
        });
        page = await openPage();
        let lands = 0;
        await page.route(`**/api/streams/${id}/land`, (route) => {
          lands++;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'landed', target: 'main', sha: 'abc', line: 'merged' }),
          });
        });
        await page.goto(`${cockpit.base}/?node=${id}`);
        await page.locator('[data-testid="stream-land"]').waitFor({ state: 'visible' });

        const palette = '[data-testid="command-palette"]';
        const input = `${palette} [data-testid="palette-input"]`;
        const titles = async (): Promise<string[]> =>
          page
            ? page
                .locator(`${palette} [data-testid="palette-item"] .cr-palette-title`)
                .allTextContents()
            : [];
        await page.keyboard.press('Control+k');
        await page.locator(input).waitFor({ state: 'visible' });
        // This node: its header's and ⋯ menu's actions, first.
        const groups = await page.locator(`${palette} .cr-palette-group-hd`).allTextContents();
        expect(groups[0]).toContain('This node');
        expect(groups[0]).toContain('Add CSV import');
        const listed = await titles();
        for (const want of ['Merge', 'Open Changes', 'Copy branch name', 'Close node…']) {
          expect(listed).toContain(want);
        }
        // What waits on you, as what you'd do; recent nodes even on a first visit.
        expect(listed).toContain('Answer: Should amounts be stored as integer cents?');
        expect(groups.some((g) => g.startsWith('Recent'))).toBe(true);
        expect(
          await page
            .locator(`${palette} [data-testid="palette-item"][data-key="node:${other.id}"]`)
            .count(),
        ).toBe(1);

        // "merge" puts this node's Merge first, and Enter runs the page's own Merge (it asks).
        await page.locator(input).fill('merge');
        expect((await titles())[0]).toBe('Merge');
        await page.keyboard.press('Enter');
        await page.locator(palette).waitFor({ state: 'detached' });
        await page.locator('[data-testid="merge-confirm"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="merge-confirm-confirm"]').click();
        await waitUntil('the merge from the palette', () => lands === 1);

        // Open Changes runs the tab switch.
        await page.keyboard.press('Control+k');
        await page.locator(input).fill('open changes');
        await page.keyboard.press('Enter');
        await page
          .locator('.cr-node-tabs button[data-tab="diff"][aria-current="page"]')
          .waitFor({ state: 'visible' });

        // A Needs me row opens its node on the chat, where the card is.
        await page.keyboard.press('Control+k');
        await page.locator(input).fill('integer cents');
        await page.keyboard.press('Enter');
        await page
          .locator(`[data-testid="stream-page"][data-stream="${other.id}"]`)
          .waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a stale link says the node is gone; a deleted one offers Restore',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const parent = await cockpit.streams.create('human', { title: 'Shop', goal: 'g' });
        const child = await cockpit.streams.create('human', {
          title: 'Old checkout',
          goal: 'g',
          parent: parent.id,
        });
        await cockpit.streams.archiveTree('human', child.id);
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${child.id}`);
        const toast = page.locator('[data-testid="toast"]', {
          hasText: '“Old checkout” is in the trash',
        });
        await toast.waitFor({ state: 'visible' });
        await toast.locator('[data-testid="toast-action"]', { hasText: 'Restore' }).click();
        await page
          .locator(`[data-testid="stream-page"][data-stream="${child.id}"]`)
          .waitFor({ state: 'visible' });
        expect(cockpit.streams.get(child.id).archived).not.toBe(true);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T436: views and polish (audit round 6) -----------------------------------

describe('views and polish (Playwright e2e, T436, audit r6)', () => {
  browserTest(
    '#11 #21: review comments and a draft survive a reload on the tab they were on; leaving asks; Merge asks about unsent comments (header and card)',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const stream = await cockpit.streams.create('human', {
          title: 'csv import',
          goal: 'import a csv',
          repo: 'demo',
          project: shop.id,
        });
        const worktree = join(cockpit.repo, '.worktrees', 's-t436');
        git(['worktree', 'add', '-q', '-b', 's-t436', worktree, 'main'], cockpit.repo);
        mkdirSync(join(worktree, 'src'));
        writeFileSync(
          join(worktree, 'src', 'import.ts'),
          'export function importCsv(text: string) {\n  const rows = text.split(",");\n  return rows;\n}\n',
        );
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'import'], worktree);
        await cockpit.streams.update('daemon', stream.id, {
          branch: 's-t436',
          worktree,
          agent: { status: 'done' },
        });

        const p = await openPage();
        page = p;
        // The browser's own "Leave site?" is a dialog: recorded, and answered Leave.
        const asked: string[] = [];
        p.on('dialog', (dialog) => {
          asked.push(dialog.type());
          void dialog.accept();
        });
        const pageOf = `[data-testid="stream-page"][data-stream="${stream.id}"]`;
        await p.goto(`${cockpit.base}/?node=${stream.id}`);
        await p.locator(pageOf).waitFor();
        const composer = p.locator('[data-testid="composer-input"]');
        await composer.fill('Also rename the helper.');

        // #21: a tab is in the URL, so a reload (and a link) opens it.
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        await waitUntilAsync(
          'the Changes tab in the URL',
          async () => new URL(p.url()).searchParams.get('tab') === 'diff',
        );
        const splitLine = p
          .locator('[data-testid="diff-file"][data-path="src/import.ts"] [data-line="add"]')
          .filter({ hasText: 'text.split' });
        await splitLine.hover();
        await splitLine.locator('[data-testid="diff-comment-add"]').click();
        await p.locator('[data-testid="diff-comment-input"]').fill('Quoted fields hold commas.');
        await p.locator('[data-testid="diff-comment-submit"]').click();
        await waitForText(p, '[data-testid="review-count"]', '1 comment on 1 file');

        // #11: a reload asks first (a review is unsent), then brings back the tab, the comment
        // and the draft.
        await p.reload();
        await p.locator(pageOf).waitFor();
        expect(asked).toEqual(['beforeunload']);
        await p.locator('.cr-tabs [data-tab="diff"][aria-current="page"]').waitFor();
        await p.locator('[data-testid="diff-comment"]', { hasText: 'Quoted fields' }).waitFor();
        await waitForText(p, '.cr-tabs [data-tab="diff"] .cr-tab-count', '1');
        await p.locator('.cr-tabs [data-tab="thread"]').click();
        expect(await composer.inputValue()).toBe('Also rename the helper.');
        // The node's first tab is the plain link.
        expect(new URL(p.url()).searchParams.get('tab')).toBeNull();
        // Back/Forward keep the tab too: another view, then Back.
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        await p.locator('[data-view="inbox"]').click();
        await p.locator('[data-testid="inbox"]').waitFor();
        await p.goBack();
        await p.locator('.cr-tabs [data-tab="diff"][aria-current="page"]').waitFor();

        // Merge (the header's) asks about the comment; Add to message puts it in the draft,
        // opens the chat on it, and merges nothing.
        await p.locator('[data-testid="stream-land"]').click();
        const unsent = p.locator('[data-testid="merge-unsent"]');
        await unsent.waitFor();
        expect(await unsent.textContent()).toContain(
          '1 review comment on csv import isn’t sent. Merge anyway?',
        );
        expect(await p.locator('[data-testid="merge-confirm"]').count()).toBe(0);
        await p.locator('[data-testid="merge-unsent-add"]').click();
        await unsent.waitFor({ state: 'detached' });
        await p.locator('.cr-tabs [data-tab="thread"][aria-current="page"]').waitFor();
        await waitUntilAsync('the review in the draft', async () =>
          (await composer.inputValue()).includes('Review of the changes:'),
        );
        expect(await composer.inputValue()).toBe(
          [
            'Also rename the helper.',
            '',
            'Review of the changes:',
            '',
            '1. `src/import.ts:2`',
            '   `const rows = text.split(",");`',
            '   Quoted fields hold commas.',
          ].join('\n'),
        );
        expect(await p.locator('.cr-tabs [data-tab="diff"] .cr-tab-count').count()).toBe(0);
        expect(cockpit.streams.get(stream.id).human.status).toBe('open');

        // A second comment, then Merge from its Needs me card: Merge anyway merges, with no
        // second question (it stands in for the first-Merge one).
        await p.locator('.cr-tabs [data-tab="diff"]').click();
        await splitLine.hover();
        await splitLine.locator('[data-testid="diff-comment-add"]').click();
        await p.locator('[data-testid="diff-comment-input"]').fill('And a header row.');
        await p.locator('[data-testid="diff-comment-submit"]').click();
        await waitForText(p, '[data-testid="review-count"]', '1 comment on 1 file');
        await p.locator('[data-view="inbox"]').click();
        const card = p.locator(`[data-kind="done"][data-id="${stream.id}"]`);
        await card.locator('[data-testid="land"]').click();
        await unsent.waitFor();
        // A card knows its node, not the branch: the dialog reads it, and names it.
        await waitUntilAsync('the dialog to name main', async () =>
          ((await unsent.textContent()) ?? '').includes('Merging puts its commits onto main now'),
        );
        await p.locator('[data-testid="merge-unsent-merge"]').click();
        await waitUntil(
          'the node to merge',
          () => cockpit.streams.get(stream.id).human.status === 'landed',
        );
        expect(await p.locator('[data-testid="merge-confirm"]').count()).toBe(0);
        // Merged: its draft and review are dropped, and leaving no longer asks.
        await waitUntilAsync(
          'the merged node’s kept draft and review dropped',
          async () =>
            (await p.evaluate(
              "sessionStorage.getItem('agile.review') === null && sessionStorage.getItem('agile.drafts') === null",
            )) === true,
        );
        await p.reload();
        await p.locator('[data-testid="inbox"]').waitFor();
        expect(asked).toEqual(['beforeunload']);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#15 #18: Events and Activity read a child status in the status words and an overlap with the neutral mark',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const parent = await cockpit.streams.create('human', {
          title: 'Checkout',
          goal: 'g',
          project: shop.id,
        });
        const work = await cockpit.streams.create('human', {
          title: 'Add CSV import',
          goal: 'g',
          project: shop.id,
          parent: parent.id,
          repo: 'api',
        });
        const other = await cockpit.streams.create('human', {
          title: 'Fix rounding',
          goal: 'g',
          project: shop.id,
          repo: 'api',
        });
        const talk = await cockpit.streams.create('human', {
          title: 'Does import handle Excel?',
          goal: 'g',
          project: shop.id,
          parent: parent.id,
        });
        const emit = (input: Parameters<typeof routeAndEmit>[1]) =>
          routeAndEmit(cockpit.events, input, cockpit.streams.list());
        // An event from before T436 still carries the stand-in "no progress line".
        const done = await emit({
          type: 'child_status',
          subject: work.id,
          payload: {
            child: work.id,
            title: 'Add CSV import',
            status: 'done',
            progress: 'no progress line',
          },
          by: 'daemon',
        });
        const replied = await emit({
          type: 'child_status',
          subject: talk.id,
          payload: { child: talk.id, title: 'Does import handle Excel?', status: 'done' },
          by: 'daemon',
        });
        const overlap = await emit({
          type: 'overlap',
          subject: work.id,
          repo: 'api',
          payload: { other: other.id, files: ['src/ledger.ts'] },
          by: 'daemon',
        });

        page = await openPage();
        await page.goto(`${cockpit.base}/?view=events`);
        const row = (id: string) => `[data-testid="event-log"] [data-event="${id}"]`;
        await page.locator(row(done.id)).waitFor();
        // The words need the node's row, which comes with the first cockpit frame (it may land
        // after the events): until then a row reads "finished".
        await waitForText(
          page,
          `${row(done.id)} .cr-lens-log-detail`,
          'Add CSV import is ready to merge',
        );
        await waitForText(
          page,
          `${row(replied.id)} .cr-lens-log-detail`,
          'Does import handle Excel? replied',
        );
        const events = (await page.locator('[data-testid="event-log"]').textContent()) ?? '';
        expect(events).not.toContain('no progress line');
        expect(events).not.toContain('is done');
        // #18: the rail's neutral two squares, no amber, never the alert triangle.
        const glyph = page.locator(`${row(overlap.id)} .cr-lens-ev-glyph`);
        expect(await glyph.locator('[data-icon="overlap"]').count()).toBe(1);
        expect(await glyph.getAttribute('data-tone')).toBeNull();
        expect(await page.locator(`${row(overlap.id)} [data-icon="alert-triangle"]`).count()).toBe(
          0,
        );

        // The parent's Activity reads the same words; the node's own reads the overlap the same way.
        await page.goto(`${cockpit.base}/?node=${parent.id}&tab=activity`);
        const activity = (id: string) => `[data-testid="activity"] [data-event="${id}"]`;
        await page
          .locator(activity(done.id), { hasText: 'Add CSV import is ready to merge' })
          .waitFor();
        await page
          .locator(activity(replied.id), { hasText: 'Does import handle Excel? replied' })
          .waitFor();
        await page.goto(`${cockpit.base}/?node=${work.id}&tab=activity`);
        await page.locator(activity(overlap.id)).waitFor();
        expect(await page.locator(`${activity(overlap.id)} [data-icon="overlap"]`).count()).toBe(1);
        expect(
          await page.locator(`${activity(overlap.id)} [data-icon="alert-triangle"]`).count(),
        ).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#17 #29: a reply row previews what was said, with the rail’s role glyph; ⌘K lists it as "Read reply" and opens the chat',
    async () => {
      const reply = '**It buffers** because the parser needs the header row first.\n\nMore below.';
      const cockpit = await startStreamCockpit([
        { steps: [{ type: 'agent_text', text: reply }, { type: 'end_turn' }] },
        {
          steps: [
            { type: 'agent_text', text: '## Planned the week: two nodes to start.' },
            { type: 'end_turn' },
          ],
        },
      ]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const convo = await cockpit.streams.create('human', {
          title: 'Why buffer the file?',
          goal: 'why does the importer read the whole file?',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor();
        const asked = await fetch(`${cockpit.base}/api/streams/${convo.id}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'why buffer?', start: true }),
        });
        expect(asked.status).toBe(201);
        const listed = page.locator(`[data-testid="reply"][data-stream="${convo.id}"]`);
        await listed.waitFor();
        await waitForText(
          page,
          `[data-testid="reply"][data-stream="${convo.id}"] [data-testid="reply-preview"]`,
          'It buffers because the parser needs the header row first.',
        );
        expect(await listed.locator('.cr-reply-icon').getAttribute('data-icon')).toBe(
          'message-square',
        );
        // A project root that answered (T437: an agent line after yours): its own glyph
        // (layers, not a fork), "Finished a turn", and its reply's first line as plain words.
        // (A root's line starts its coordinator once it has a part.)
        await cockpit.streams.create('human', {
          title: 'Import the file',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        const planned = await fetch(`${cockpit.base}/api/streams/${shop.root}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'plan the week', start: true }),
        });
        expect(planned.status).toBe(201);
        const root = page.locator(`[data-testid="reply"][data-stream="${shop.root}"]`);
        await root.waitFor();
        expect(await root.locator('.cr-reply-icon').getAttribute('data-icon')).toBe('layers');
        expect(await root.locator('.cr-reply-when').textContent()).toContain('Finished a turn');
        await waitForText(
          page,
          `[data-testid="reply"][data-stream="${shop.root}"] [data-testid="reply-preview"]`,
          'Planned the week: two nodes to start.',
        );
        expect(await root.locator('[data-icon="git-fork"]').count()).toBe(0);

        // ⌘K: "Read reply: …" in Needs me; it opens the chat, which reads it.
        const palette = '[data-testid="command-palette"]';
        await page.keyboard.press('Control+k');
        const item = page.locator(
          `${palette} [data-testid="palette-item"][data-key="reply:${convo.id}"]`,
        );
        await item.waitFor();
        expect(await item.locator('.cr-palette-title').textContent()).toBe(
          'Read reply: Why buffer the file?',
        );
        await page.locator(`${palette} [data-testid="palette-input"]`).fill('read reply buffer');
        await waitForAttr(
          page,
          `${palette} [aria-selected="true"]`,
          'data-key',
          `reply:${convo.id}`,
        );
        await page.keyboard.press('Enter');
        await page.locator(`[data-testid="stream-page"][data-stream="${convo.id}"]`).waitFor();
        await page.locator('.cr-tabs [data-tab="thread"][aria-current="page"]').waitFor();
        await page.locator('[data-view="inbox"]').click();
        await page.locator('[data-testid="inbox"]').waitFor();
        await listed.waitFor({ state: 'detached' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#22: a project’s unsaved repositories wait for you across navigation and a reload, until Cancel',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({
          api: { path: cockpit.home },
          web: { path: cockpit.home },
        });
        const shop = await cockpit.projects.create({ name: 'Shop', repos: ['api'] });
        const other = await cockpit.streams.create('human', {
          title: 'Research pricing',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${shop.root}`);
        const web = page.locator('[data-testid="project-repo"][data-repo="web"]');
        await web.check();
        const bar = page.locator('[data-testid="project-save-bar"]');
        await bar.waitFor();
        // Somewhere else, and back: the change is still there to save.
        await page.locator(`[data-testid="stream-tree"] [data-stream="${other.id}"]`).click();
        await page.locator(`[data-testid="stream-page"][data-stream="${other.id}"]`).waitFor();
        await page.locator(`[data-testid="stream-tree"] [data-stream="${shop.root}"]`).click();
        await bar.waitFor();
        expect(await web.isChecked()).toBe(true);
        await page.reload();
        await bar.waitFor();
        expect(await web.isChecked()).toBe(true);
        expect(cockpit.store.getProject(shop.id).repos).toEqual(['api']);
        // Cancel drops it for good.
        await page.locator('[data-testid="project-cancel"]').click();
        await bar.waitFor({ state: 'detached' });
        expect(await web.isChecked()).toBe(false);
        await page.reload();
        await page.locator('[data-testid="project-repos"]').waitFor();
        expect(await bar.count()).toBe(0);
        expect(await web.isChecked()).toBe(false);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#24: Details says nothing of delivery before a branch, offers a reviewer only with commits, and reads a finished branch as the header does',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const shop = await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
        });
        const fresh = await cockpit.streams.create('human', {
          title: 'Not started yet',
          goal: 'g',
          repo: 'demo',
          project: shop.id,
        });
        // A work node in a project (a node with no project is a root of its own, which never
        // reads "Ready to merge"), finished with a commit.
        const done = (
          await cockpit.streams.create('human', {
            title: 'Export entries',
            goal: 'g',
            repo: 'demo',
            project: shop.id,
          })
        ).id;
        const worktree = join(cockpit.repo, '.worktrees', 's-t436-done');
        git(['worktree', 'add', '-q', '-b', 's-t436-done', worktree, 'main'], cockpit.repo);
        writeFileSync(join(worktree, 'export.txt'), 'export\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', 'export'], worktree);
        await cockpit.streams.update('daemon', done, {
          branch: 's-t436-done',
          worktree,
          agent: { status: 'done' },
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${fresh.id}`);
        await page.locator('[data-testid="node-details"] [data-testid="sessions"]').waitFor();
        expect(await page.locator('[data-testid="land-panel"]').count()).toBe(0);
        expect(
          await page
            .locator('[data-testid="node-details"] button', { hasText: 'Ask an agent to review' })
            .count(),
        ).toBe(0);
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="node-menu"]').waitFor();
        expect(await page.locator('[data-testid="node-menu"] [data-testid="review"]').count()).toBe(
          0,
        );
        await page.keyboard.press('Escape');

        await page.goto(`${cockpit.base}/?node=${done}`);
        await waitForText(page, '[data-testid="delivery-badge"]', 'Ready to merge');
        expect(await page.locator('[data-testid="delivery-badge"]').getAttribute('data-tone')).toBe(
          'amber',
        );
        expect(await page.locator('[data-testid="node-status"]').textContent()).toContain(
          'Ready to merge',
        );
        await page
          .locator('[data-testid="node-details"] button', { hasText: 'Ask an agent to review' })
          .waitFor();
        // T438: the menu's item is there from the first render (a branch), enabled with commits.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page
          .locator('[data-testid="node-menu"] [data-testid="review"]:not([disabled])')
          .waitFor();
        await page.keyboard.press('Escape');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#28: with a plan to approve on a coordinator, its card’s button is the one primary; Start is plain',
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
        const api = await cockpit.streams.create('human', {
          title: 'api: add salePrice',
          goal: 'g',
          project: shop.id,
          parent: node.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        // No plan yet: Start is the page's primary.
        await waitForAttr(page, '[data-testid="attach"]', 'data-variant', 'primary');
        await cockpit.plans.write(node.id, [{ child: api.id, owns: ['prices.ts'] }], []);
        await page.locator('[data-testid="plan-approve"]').waitFor();
        await waitForAttr(page, '[data-testid="attach"]', 'data-variant', 'secondary');
        expect(
          await page.locator('[data-testid="plan-approve"]').getAttribute('data-variant'),
        ).toBe('primary');
        expect(await page.locator('.cr-node-hd .cr-btn[data-variant="primary"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe('flow and focus (Playwright e2e, T445)', () => {
  /** A Needs me row's item (T470), else the `data-testid` (else the `data-id`, else the tag) of what has focus. */
  const focusOf = async (page: Page): Promise<string> =>
    (await page.evaluate<string>(
      `(() => { const a = document.activeElement; return a?.getAttribute('data-item') ?? a?.getAttribute('data-testid') ?? a?.getAttribute('data-id') ?? a?.tagName.toLowerCase() ?? ''; })()`,
    )) ?? '';

  browserTest(
    'a merged card stays as "Merged into main" at its height; the next Merge never slides under the pointer, and the next card takes focus',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const a = await finishedNode(cockpit, 'Api part', 's-api');
        const b = await finishedNode(cockpit, 'Web part', 's-web');
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        // "Don't ask again" was ticked before: Merge is one click.
        await page.evaluate(`localStorage.setItem('agile.merge.ask', 'never')`);
        await page.reload();
        const first = `[data-testid="inbox"] .cr-card[data-id="${a}"]`;
        const second = `[data-testid="inbox"] .cr-card[data-id="${b}"]`;
        await page.locator(`${first} [data-testid="land"]`).waitFor({ state: 'visible' });
        await page.locator(`${second} [data-testid="land"]`).waitFor({ state: 'visible' });
        const merge2 = await page.locator(`${second} [data-testid="land"]`).boundingBox();
        const lands: string[] = [];
        page.on('request', (r) => {
          if (r.method() === 'POST' && r.url().endsWith('/land')) lands.push(r.url());
        });
        // The moment the decided card leaves, a second click where the first landed (the pointer
        // hasn't moved: a double-click) does nothing. T449: a click elsewhere would go through.
        const box = await page.locator(`${first} [data-testid="land"]`).boundingBox();
        const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
        const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
        await page.evaluate(`(() => {
          window.__t445 = 'armed';
          let seen = false;
          const obs = new MutationObserver(() => {
            if (document.querySelector('[data-testid="card-outcome"][data-id="${a}"]')) {
              seen = true;
              return;
            }
            if (!seen) return;
            obs.disconnect();
            document
              .querySelector('.cr-card[data-id="${b}"] [data-testid="land"]')
              ?.dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  detail: 1,
                  clientX: ${x},
                  clientY: ${y},
                }),
              );
            window.__t445 = 'clicked';
          });
          obs.observe(document.body, { subtree: true, childList: true });
        })()`);

        await page.mouse.click(x, y);
        const outcome = page.locator(`[data-testid="card-outcome"][data-id="${a}"]`);
        await outcome.waitFor({ state: 'visible' });
        expect(await outcome.textContent()).toContain('Merged into main');
        // In place, at its height: the next card's Merge is where it was.
        expect((await page.locator(`${second} [data-testid="land"]`).boundingBox())?.y).toBe(
          merge2?.y,
        );
        expect(cockpit.streams.get(a).human.status).toBe('landed');
        await outcome.waitFor({ state: 'detached' });
        await waitUntilAsync(
          'the click right after',
          async () => (await page?.evaluate<string>('window.__t445')) === 'clicked',
        );
        // That click was ignored: nothing asked to merge the second node.
        await Bun.sleep(600);
        expect(lands.filter((u) => u.includes(b))).toEqual([]);
        expect(cockpit.streams.get(b).human.status).not.toBe('landed');
        // The card that took its place has the focus, so j/k go on from there.
        await waitUntilAsync(
          'focus on the next card',
          async () => (await focusOf(page as Page)) === b,
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'T449: a click aimed elsewhere right after a card leaves is meant: it goes through',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const a = await finishedNode(cockpit, 'Api part', 's-api');
        const b = await finishedNode(cockpit, 'Web part', 's-web');
        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        await page.evaluate(`localStorage.setItem('agile.merge.ask', 'never')`);
        await page.reload();
        const first = `[data-testid="inbox"] .cr-card[data-id="${a}"]`;
        await page.locator(`${first} [data-testid="land"]`).waitFor({ state: 'visible' });
        const box = await page.locator(`${first} [data-testid="land"]`).boundingBox();
        const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
        const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
        // The moment the merged card leaves, click the next card's View changes (another spot).
        await page.evaluate(`(() => {
          let seen = false;
          const obs = new MutationObserver(() => {
            if (document.querySelector('[data-testid="card-outcome"][data-id="${a}"]')) {
              seen = true;
              return;
            }
            if (!seen) return;
            obs.disconnect();
            const view = document.querySelector('.cr-card[data-id="${b}"] [data-testid="view-changes"]');
            const r = view?.getBoundingClientRect();
            view?.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 1,
                clientX: (r?.x ?? 0) + (r?.width ?? 0) / 2,
                clientY: (r?.y ?? 0) + (r?.height ?? 0) / 2,
              }),
            );
          });
          obs.observe(document.body, { subtree: true, childList: true });
        })()`);
        await page.mouse.click(x, y);
        // It went through: the next node opens on its Changes tab.
        await page.locator(`[data-testid="stream-page"][data-stream="${b}"]`).waitFor();
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'proposal lines: an autonomy proposal says Decide below, not Add <repo>; the Plan tab starts the coordinator; ⋯ has Rename and Move to; Add repository is a picker; a root points to Ask',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home }, web: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop', repos: ['api'] });
        const node = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
        });
        const child = (title: string, repo: string) =>
          cockpit.streams.create('human', {
            title,
            goal: 'g',
            project: shop.id,
            parent: node.id,
            repo,
          });
        const api = await child('api part', 'api');
        const web = await child('web part', 'web');
        const out = await cockpit.autonomy.act(node.id, 'coordinator', 'agent:test', {
          action: 'add_waits_on',
          child: web.id,
          on: api.id,
        });
        expect(out.applied).toBe(false);

        page = await openPage();
        const attaches: string[] = [];
        await page.route(`**/api/streams/${node.id}/attach`, (route) => {
          attaches.push(route.request().url());
          return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
        });
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        await page.locator('[data-testid="node-role"]').waitFor();
        // The line names the api repo in its words: it offers no Add api, only its card.
        await page.locator('[data-testid="proposal-decide"]').waitFor({ state: 'visible' });
        expect(await page.locator('[data-testid="proposal-add-repo"]').count()).toBe(0);
        await page.locator('[data-testid="proposal-decide"]').click();
        await waitUntilAsync(
          'focus on its Apply',
          async () => (await focusOf(page as Page)) === 'proposal-apply',
        );

        // No plan and no coordinator running: the Plan tab starts one.
        await page.locator('.cr-tabs [data-tab="plan"]').click();
        const startPlan = page.locator('[data-testid="plan-empty-start"]');
        await startPlan.waitFor({ state: 'visible' });
        expect(await startPlan.textContent()).toBe('Start the coordinator');
        await startPlan.click();
        await waitUntil('the coordinator started', () => attaches.length === 1);

        // ⋯ has Move to… and Rename…; a dialog gives focus back to what opened it.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="menu-rename"]').waitFor({ state: 'visible' });
        await page.locator('[data-testid="menu-move"]').click();
        await page.locator('[data-testid="move-dialog"]').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="move-dialog"]').waitFor({ state: 'detached' });
        await waitUntilAsync(
          'focus back on the menu',
          async () => (await focusOf(page as Page)) === 'node-menu-trigger',
        );
        // …and in ⌘K's "This node".
        await page.keyboard.press('Control+k');
        await page.locator('[data-testid="palette-input"]').fill('rename');
        await page
          .locator('[data-testid="palette-item"][data-key^="this:"]', { hasText: 'Rename…' })
          .click();
        await page.locator('[data-testid="rename-input"]').fill('Sale prices');
        await page.locator('[data-testid="rename-save"]').click();
        await waitForText(page, '[data-testid="stream-title"]', 'Sale prices');

        // Add repository… on a coordinating node: the repo picker, and it adds a part.
        await page.locator('[data-testid="node-menu-trigger"]').click();
        await page.locator('[data-testid="add-repo"]').click();
        await waitForAttr(page, '[data-testid="add-repo-select"]', 'data-value', 'api');
        expect(await page.locator('[data-testid="add-repo-part"]').textContent()).toContain(
          'Adds a part on api',
        );
        await page.locator('[data-testid="add-repo-select"]').click();
        await page.locator('[data-testid="add-repo-select-option"][data-repo="web"]').click();
        await waitForText(
          page,
          '[data-testid="add-repo-part"]',
          'Adds a part on web, under this node, which coordinates it.',
        );
        await page.keyboard.press('Escape');
        await page.locator('[data-testid="add-repo-form"]').waitFor({ state: 'detached' });

        // The project's root, with no agent: its composer points to Ask.
        await page.goto(`${cockpit.base}/?node=${shop.root}&tab=thread`);
        const composer = page.locator('[data-testid="composer-input"]');
        await composer.waitFor({ state: 'visible' });
        expect(await composer.getAttribute('placeholder')).toBe(
          'Write to the project — or press A to ask it a question',
        );
        await page.locator('[data-testid="chat-empty-ask"]').click();
        await page.locator('[data-testid="ask"]').waitFor({ state: 'visible' });
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'first run: Add repository opens in place, then "Create a project" is next and has focus; ⌘K adds one too',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'agile-t445-first-run-'));
      const userHome = join(scratch, 'home');
      const shop = join(userHome, 'shop');
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
        await page.goto(`${cockpit.base}/`);
        const empty = '[data-testid="inbox-empty"][data-state="first-run"]';
        await page.locator('[data-testid="setup-repo"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
        const browser = '[data-testid="add-repo-browser"]';
        await page.locator(`${browser}[data-path="${userHome}"]`).waitFor({ state: 'visible' });
        await page.locator(`${browser} [data-testid="add-repo-dir"][data-name="shop"]`).click();
        await waitForText(page, '[data-testid="add-repo-status"]', 'shop is a git repository.');
        await page.locator('[data-testid="settings-repo-add-save"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'detached' });
        expect(cockpit.store.getRepos().shop?.path).toBe(realpathSync(shop));
        // Still Needs me: step 1 is done and step 2 is the primary, with the focus.
        await waitForAttr(page, `${empty} [data-step="repo"]`, 'data-done', 'true');
        await waitForAttr(page, '[data-testid="setup-project"]', 'data-variant', 'primary');
        await waitUntilAsync(
          'focus on Create a project',
          async () => (await focusOf(page as Page)) === 'setup-project',
        );

        // ⌘K: Add repository… opens the same dialog, wherever you are.
        await page.keyboard.press('Control+k');
        await page.locator('[data-testid="palette-input"]').fill('add repository');
        await page.locator('[data-testid="palette-item"][data-key="action:add-repo"]').click();
        await page.locator('[data-testid="add-repo-dialog"]').waitFor({ state: 'visible' });
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
    "New node: a one-repository project starts on it; the title is cut at a clause and promises nothing without quick drafts; the new node's composer has focus",
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        await new ProjectService(cockpit.store, cockpit.streams).create({
          name: 'shop',
          repos: ['demo'],
        });
        // The quick drafts switch is stubbed below: nothing the service worker fetches.
        page = await openPage({ serviceWorkers: 'block' });
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="new-stream-open"]').click();
        await page.locator('[data-testid="new-stream"]').waitFor({ state: 'visible' });
        // The project's one repository, with "No repository" one click away.
        await waitForAttr(page, '[data-testid="new-stream-repo"]', 'data-value', 'demo');
        await page.locator('[data-testid="new-stream-no-repo"]').waitFor({ state: 'visible' });
        await page
          .locator('[data-testid="new-stream-goal"]')
          .fill('Add a greet() function to src/index.ts that returns "hello, world" and a test');
        expect(await page.locator('[data-testid="new-stream-title"]').inputValue()).toBe(
          'Add a greet() function to src/index.ts',
        );
        const hint =
          '[data-testid="new-stream"] .cr-field:has([data-testid="new-stream-title"]) .cr-field-hint';
        expect(await page.locator(hint).textContent()).toBe(
          'The goal’s first line — edit it if you like.',
        );
        await page.locator('[data-testid="new-stream-start"]').uncheck();
        await page.locator('[data-testid="new-stream-create"]').click();
        await waitUntil('the node', () =>
          cockpit.streams
            .list()
            .some((s) => s.title === 'Add a greet() function to src/index.ts' && s.repo === 'demo'),
        );
        const made = cockpit.streams
          .list()
          .find((s) => s.title === 'Add a greet() function to src/index.ts');
        await page.locator(`[data-testid="stream-page"][data-stream="${made?.id}"]`).waitFor();
        await waitUntilAsync(
          "focus on the new node's composer",
          async () => (await focusOf(page as Page)) === 'composer-input',
        );

        // With quick drafts on and there, the hint promises a title; "Just talk" is no repository.
        await page.route('**/api/settings/quick-drafts', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ on: true, available: true }),
          }),
        );
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="new-stream-open"]').click();
        await waitForText(
          page,
          hint,
          'Left as is, a short title is written for you once it’s made.',
        );
        await page.locator('[data-testid="new-stream-no-repo"]').click();
        await waitForAttr(page, '[data-testid="new-stream-repo"]', 'data-value', '');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    "j and k on a node's page open the next and previous node in the tree; Needs me keeps them for its cards",
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        const shop = await cockpit.projects.create({ name: 'Shop' });
        const a = await cockpit.streams.create('human', {
          title: 'Alpha',
          goal: 'g',
          project: shop.id,
        });
        const b = await cockpit.streams.create('human', {
          title: 'Beta',
          goal: 'g',
          project: shop.id,
        });
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${a.id}`);
        const at = (id: string) => `[data-testid="stream-page"][data-stream="${id}"]`;
        await page.locator(at(a.id)).waitFor();
        await page.locator(`[data-testid="stream-tree"] [data-stream="${b.id}"]`).waitFor();
        await page.evaluate('document.activeElement?.blur()');
        await page.keyboard.press('j');
        await page.locator(at(b.id)).waitFor();
        await page.keyboard.press('k');
        await page.locator(at(a.id)).waitFor();
        await page.keyboard.press('k');
        await page.locator(at(shop.root)).waitFor();
        // Not while typing.
        await page.goto(`${cockpit.base}/?node=${a.id}&tab=thread`);
        await page.locator('[data-testid="composer-input"]').click();
        await page.keyboard.press('j');
        await Bun.sleep(300);
        expect(await page.locator(at(a.id)).count()).toBe(1);
        // Needs me: j walks its cards, never the tree.
        await page.goto(`${cockpit.base}/`);
        await page.locator('[data-testid="inbox"]').waitFor();
        await page.keyboard.press('j');
        await Bun.sleep(300);
        expect(await page.locator('[data-testid="stream-page"]').count()).toBe(0);
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T447 (audit r7): honest coordinator status, and scale ---------------

describe('honest coordinator status, and scale (Playwright e2e, T447)', () => {
  browserTest(
    '#2/#9: a coordinator reads as its most urgent part, in its header, the rail and the Overview, and is Done only when every part is merged or closed',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home }, web: { path: cockpit.home } });
        const shop = await cockpit.projects.create({ name: 'Shop', repos: ['api', 'web'] });
        const sale = await cockpit.streams.create('human', {
          title: 'Show sale prices',
          goal: 'g',
          project: shop.id,
          parent: shop.root,
        });
        const api = await cockpit.streams.create('human', {
          title: 'api part',
          goal: 'g',
          project: shop.id,
          parent: sale.id,
          repo: 'api',
        });
        const web = await cockpit.streams.create('human', {
          title: 'web part',
          goal: 'g',
          project: shop.id,
          parent: sale.id,
          repo: 'web',
        });
        // The coordinator's turn ended; one part works, the other never started.
        await cockpit.streams.update('daemon', sale.id, { agent: { status: 'done' } });
        await cockpit.streams.update('daemon', api.id, { agent: { status: 'working' } });

        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${sale.id}`);
        const pill = '[data-testid="stream-page"] [data-testid="node-status"]';
        const row = `[data-testid="stream-tree"] [data-stream="${sale.id}"]`;
        const parts = '[data-testid="stream-page"] [data-testid="node-parts"]';
        await waitForAttr(page, pill, 'data-status', 'working');
        await waitForAttr(page, row, 'data-status', 'working');
        await waitForText(page, parts, '0 of 2 merged · waiting for api part and 1 more');
        expect(await page.locator(`${pill} .cr-dot`).getAttribute('data-dot')).toBe('blue');

        // A part asks: the coordinator needs you, amber in the pill and the rail.
        await cockpit.streams.update('daemon', api.id, { agent: { status: 'question' } });
        await waitForAttr(page, pill, 'data-status', 'needs_you');
        await waitForText(page, parts, '0 of 2 merged · api part needs you');
        expect(await page.locator(`${pill} .cr-dot`).getAttribute('data-dot')).toBe('amber');
        await waitForAttr(page, `${row} .cr-dot`, 'data-dot', 'amber');

        // The Overview files it under Your move, heading its parts, never under Finished.
        await page.goto(`${cockpit.base}/?node=${shop.root}`);
        const overview = '[data-testid="project-overview"]';
        const saleBranch = `[data-testid="overview-branch"][data-stream="${sale.id}"]`;
        const branch = `${overview} ${saleBranch}`;
        await page.locator(branch).waitFor();
        expect(
          await page
            .locator(`${overview} [data-testid="overview-group"]`, {
              has: page.locator(saleBranch),
            })
            .getAttribute('data-group'),
        ).toBe('you');
        await waitForText(
          page,
          `${branch} [data-testid="overview-branch-summary"]`,
          '1 needs you · 1 not started',
        );
        expect(
          await page
            .locator(`${branch} [data-testid="overview-node"]`)
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-stream'))),
        ).toEqual([sale.id, api.id, web.id]);
        // The counts count the part that asks, not the coordinator that reads as it.
        await waitForText(
          page,
          `${overview} [data-testid="overview-count"][data-status="needs_you"]`,
          '1 needs you',
        );

        // Both parts finish: merged, and closed. Only now is the coordinator Done.
        await cockpit.streams.update('daemon', api.id, {
          agent: { status: 'done' },
          human: { status: 'landed' },
        });
        await cockpit.streams.close('human', web.id);
        await page.goto(`${cockpit.base}/?node=${sale.id}`);
        await waitForAttr(page, pill, 'data-status', 'done');
        await waitForText(page, parts, '1 of 1 merged · 1 closed · every part finished');
        await page.goto(`${cockpit.base}/?node=${shop.root}`);
        await page.locator(`${overview} [data-testid="overview-done-toggle"]`).click();
        expect(
          await page
            .locator(`${overview} [data-testid="overview-group"]`, {
              has: page.locator(saleBranch),
            })
            .getAttribute('data-group'),
        ).toBe('finished');
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#19/#20: a big Overview groups by top-level node (folded past 30 nodes), filters with /, and the rail keeps alike titles apart',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ api: { path: cockpit.home } });
        const plat = await cockpit.projects.create({ name: 'Platform', repos: ['api'] });
        const epics = ['Onboarding emails', 'Data retention', 'Checkout v2', 'Search relevance'];
        const tasks = ['Schema change', 'Migration script', 'API endpoint', 'Web form'];
        const ids: Record<string, string> = {};
        for (const epic of epics) {
          const e = await cockpit.streams.create('human', {
            title: epic,
            goal: 'g',
            project: plat.id,
            parent: plat.root,
          });
          ids[epic] = e.id;
          for (const task of tasks) {
            const title = `${task} for ${epic.toLowerCase()}`;
            const t = await cockpit.streams.create('human', {
              title,
              goal: 'g',
              project: plat.id,
              parent: e.id,
              repo: 'api',
            });
            ids[title] = t.id;
          }
        }
        for (let i = 0; i < 12; i++) {
          await cockpit.streams.create('human', {
            title: `Question ${i}`,
            goal: 'g',
            project: plat.id,
            parent: plat.root,
          });
        }
        page = await openPage();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${cockpit.base}/?node=${plat.root}`);
        const overview = '[data-testid="project-overview"]';
        const rows = `${overview} [data-testid="overview-node"]`;
        const shown = async (): Promise<Array<string | null>> =>
          (await page
            ?.locator(rows)
            .evaluateAll((els) => els.map((el) => el.getAttribute('data-stream')))) ?? [];
        // 32 nodes: every branch starts folded, each head with its counts.
        await waitForCount(page, `${overview} [data-testid="overview-branch"]`, 16);
        expect(await page.locator(rows).count()).toBe(16);
        const epic = `${overview} [data-testid="overview-branch"][data-stream="${ids['Data retention']}"]`;
        expect(await page.locator(epic).getAttribute('data-open')).toBe('false');
        await waitForText(page, `${epic} [data-testid="overview-branch-summary"]`, '4 not started');
        await page.locator(`${epic} [data-testid="overview-branch-toggle"]`).click();
        await waitForAttr(page, epic, 'data-open', 'true');
        expect(await page.locator(`${epic} [data-testid="overview-node"]`).count()).toBe(5);

        // `/` with the Overview focused goes to its filter, not the rail's.
        await page.locator(`${overview} .cr-ov-h`).first().click();
        await page.keyboard.press('/');
        await waitUntilAsync(
          'the Overview filter to have focus',
          async () =>
            (await page?.evaluate(`document.activeElement?.getAttribute('data-testid')`)) ===
            'overview-filter',
        );
        await page.keyboard.type('schema retention');
        await waitUntilAsync('only the matching node, under its epic', async () => {
          const now = await shown();
          return (
            now.join() === [ids['Data retention'], ids['Schema change for data retention']].join()
          );
        });
        await page.keyboard.press('Escape');
        await waitForCount(page, `${overview} [data-testid="overview-branch"]`, 16);
        expect(await page.locator('[data-testid="overview-filter"]').inputValue()).toBe('');

        // The rail: alike titles keep their distinct end; the whole title is the row's.
        const railRow = (title: string) =>
          `[data-testid="stream-tree"] [data-stream="${ids[title]}"]`;
        for (const [title, tail] of [
          ['Schema change for onboarding emails', 'emails'],
          ['Schema change for data retention', 'data retention'],
        ] as const) {
          const r = railRow(title);
          await page.locator(r).waitFor();
          expect(await page.locator(`${r} .title`).textContent()).toBe(title);
          expect(await page.locator(`${r} .title-tail`).textContent()).toBe(tail);
          expect(await page.locator(r).getAttribute('title')).toContain(title);
          // The tail is drawn inside the row, not cut off.
          const [tailBox, rowBox] = await Promise.all([
            page.locator(`${r} .title-tail`).boundingBox(),
            page.locator(r).boundingBox(),
          ]);
          expect(tailBox !== null && rowBox !== null).toBe(true);
          if (tailBox && rowBox) {
            expect(tailBox.width).toBeGreaterThan(10);
            expect(tailBox.x + tailBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
          }
        }
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    '#15: a long thread renders its newest rows, loads earlier ones, and typing stays quick; the draft survives a reload',
    async () => {
      const cockpit = await startCockpit();
      let page: Page | undefined;
      try {
        await cockpit.store.putRepos({ billing: { path: cockpit.home } });
        const plat = await cockpit.projects.create({ name: 'Platform', repos: ['billing'] });
        const node = await cockpit.streams.create('human', {
          title: 'Refactor the invoice renderer',
          goal: 'g',
          project: plat.id,
          repo: 'billing',
        });
        const t0 = Date.now() - 3_600_000;
        for (let i = 0; i < 162; i++) {
          await cockpit.store.appendThreadEntry(node.id, {
            ts: new Date(t0 + i * 10_000).toISOString(),
            by: 'human',
            kind: 'line',
            body: `Next: step ${i}.`,
          });
          await cockpit.store.appendThreadEntry(node.id, {
            ts: new Date(t0 + i * 10_000 + 5_000).toISOString(),
            by: 'agent:01ARZ3NDEKTSV4RRFFQ69G5FAV',
            kind: 'line',
            body: `Done with step ${i}: moved \`formatLine${i}()\` into \`layout.ts\`.\n\n\`\`\`ts\nexport const step${i} = ${i};\n\`\`\``,
          });
        }
        page = await openPage();
        // Long tasks (≥50 ms) while the page runs: a keystroke that re-renders the chat is one.
        await page.addInitScript(`window.__lt = [];
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
          }).observe({ type: 'longtask', buffered: true });`);
        await page.goto(`${cockpit.base}/?node=${node.id}`);
        const entries = '[data-testid="thread"] [data-testid="thread-entry"]';
        await waitForCount(page, entries, 1);
        // The newest 80 rows (324 lines, plus the node's own system rows), and the rest above.
        const count = async () => (await page?.locator(entries).count()) ?? 0;
        await waitUntilAsync('a window of the newest rows', async () => (await count()) === 80);
        expect(await page.locator(entries).last().textContent()).toContain('step 161');
        const earlier = '[data-testid="thread-earlier"]';
        expect(await page.locator(earlier).textContent()).toContain('Show 80 earlier messages');
        await page.locator(earlier).click();
        await waitUntilAsync('80 more', async () => (await count()) === 160);
        // Scrolling to the top loads the rest by itself.
        await waitUntilAsync('every row, scrolling up', async () => {
          await page?.evaluate(
            `(() => { const el = document.querySelector('.cr-chat-scroll'); if (el) el.scrollTop = 0; })()`,
          );
          return (await page?.locator(earlier).count()) === 0;
        });
        expect(await page.locator(entries, { hasText: 'Next: step 0.' }).count()).toBe(1);

        // Typing a line: no long task re-rendering the chat per key.
        const input = page.locator('[data-testid="composer-input"]');
        await input.click();
        await page.evaluate('window.__lt = []');
        const typed = Date.now();
        await page.keyboard.type('Checking typing latency on a long thread', { delay: 0 });
        const took = Date.now() - typed;
        const long = (await page.evaluate('window.__lt')) as number[];
        expect(long.filter((ms) => ms >= 50).length).toBeLessThanOrEqual(2);
        expect(took).toBeLessThan(5_000);
        // T436's behaviour holds: the draft is the node's, across a reload.
        await page.reload();
        await page.locator('[data-testid="composer-input"]').waitFor();
        expect(await page.locator('[data-testid="composer-input"]').inputValue()).toBe(
          'Checking typing latency on a long thread',
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    TEST_BUDGET_MS,
  );
});

// ---- T457: the permission posture's Ask card and its Settings ----------

describe('a node’s own rules and permissions (Playwright e2e, T463)', () => {
  browserTest(
    'the Knowledge tab switches a rule off for this node, a critical one after a confirm, and sets Trusted',
    async () => {
      const cockpit = await startStreamCockpit([]);
      let page: Page | undefined;
      try {
        const node = await cockpit.streams.create('human', {
          title: 'Look around',
          goal: 'g',
          repo: 'demo',
        });
        const plain = await cockpit.rules.create('human', {
          text: 'prefer small commits',
          scope: { kind: 'global' },
        });
        await cockpit.rules.accept(plain.id, 'human');
        // The daemon's own critical rules, as a real home has them.
        await ensureBuiltinKnowledge(cockpit.store);
        const critical = cockpit.rules
          .inScope(node.id)
          .find((r) => r.name === 'stay-in-worktree') as Rule;
        expect(critical.critical).toBe(true);

        const p = await openPage();
        page = p;
        await p.goto(`${cockpit.base}/?node=${node.id}&tab=rules`);
        const row = (id: string) => p.locator(`[data-testid="rule"][data-rule="${id}"]`);
        await row(plain.id).waitFor();
        const box = (id: string) => row(id).locator('[data-testid="rule-applies"]');
        expect(await box(plain.id).isChecked()).toBe(true);

        // A plain item switches off at once; the row stays, dimmed, and the thread says so.
        await box(plain.id).click();
        await waitForAttr(
          page,
          `[data-testid="rule"][data-rule="${plain.id}"]`,
          'data-off',
          'true',
        );
        expect(cockpit.streams.get(node.id).rules_off).toEqual([plain.id]);
        expect(cockpit.rules.inScope(node.id).map((r) => r.id)).not.toContain(plain.id);
        expect(cockpit.streams.readThread(node.id).entries.at(-1)?.body).toContain(
          'no longer applies to this node',
        );

        // A critical rule asks first; Cancel leaves it on.
        await box(critical.id).click();
        const confirm = page.locator('[data-testid="rule-off-confirm"]');
        await confirm.waitFor();
        await page.keyboard.press('Escape');
        await confirm.waitFor({ state: 'detached' });
        expect(cockpit.streams.get(node.id).rules_off).toEqual([plain.id]);

        // Back on with one click.
        await box(plain.id).click();
        await waitUntil(
          'the rule back on',
          () => cockpit.streams.get(node.id).rules_off === undefined,
        );

        // Permissions: inherits Ask, then Trusted for this node alone, then inherits again.
        expect(await page.locator('[data-testid="node-permissions-inherit"]').textContent()).toBe(
          'Inherit (Ask)',
        );
        await page.locator('[data-testid="node-permissions-trusted"]').click();
        await waitUntil(
          'the node Trusted',
          () => cockpit.streams.get(node.id).permissions === 'trusted',
        );
        await page
          .locator('[data-testid="node-permissions-hint"]', { hasText: 'without asking' })
          .waitFor();
        await page.locator('[data-testid="node-permissions-inherit"]').click();
        await waitUntil(
          'inherited again',
          () => cockpit.streams.get(node.id).permissions === undefined,
        );
      } finally {
        await teardown([page]);
        await cockpit.stop();
      }
    },
    90_000,
  );
});

describe('slash commands in the composer (Playwright e2e, T461)', () => {
  browserTest(
    'typing / lists the agent’s commands; one runs as typed; /login is held with how to log in',
    async () => {
      const release = join(tmpdir(), `agile-slash-e2e-release-${ulid()}`);
      const promptLog = join(tmpdir(), `agile-slash-e2e-prompts-${ulid()}.jsonl`);
      const worker: FakeAgentScript = {
        logFile: promptLog,
        commands: [
          { name: 'compact', description: 'Clear the conversation but keep a summary' },
          { name: 'review', description: 'Review a pull request', input: { hint: 'PR number' } },
        ],
        turns: [
          [
            { type: 'agent_text', text: 'reading the parser' },
            { type: 'tool_call', toolCallId: 'read-1', title: 'read parser.ts' },
            { type: 'wait_for_file', path: release, timeoutMs: 60_000 },
            { type: 'end_turn' },
          ],
          [{ type: 'agent_text', text: 'Compacted the conversation.' }, { type: 'end_turn' }],
        ],
        steps: [{ type: 'end_turn' }],
      };
      const cockpit = await startStreamCockpit([worker]);
      let page: Page | undefined;
      try {
        const stream = await cockpit.streams.create('human', {
          title: 'CSV parser',
          goal: 'Pick the dialect.',
          repo: 'demo',
        });
        await cockpit.attach.attach(stream.id);
        page = await openPage();
        await page.goto(`${cockpit.base}/?node=${stream.id}`);
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', {
            hasText: 'reading the parser',
          })
          .waitFor();
        const input = page.locator('[data-testid="composer-input"]');
        const menu = page.locator('[data-testid="slash-menu"]');
        const items = page.locator('[data-testid="slash-item"]');

        // `/` opens the menu of what the agent advertised, with descriptions.
        await input.fill('/');
        await menu.waitFor();
        await items.nth(1).waitFor();
        expect(await items.allTextContents()).toEqual([
          '/compactClear the conversation but keep a summary',
          '/review PR numberReview a pull request',
        ]);
        // Escape closes it; typing on narrows it; Enter picks the highlighted one.
        await input.press('Escape');
        await menu.waitFor({ state: 'detached' });
        await input.fill('');
        await input.fill('/co');
        await menu.waitFor();
        expect(await items.count()).toBe(1);
        await input.press('Enter');
        await menu.waitFor({ state: 'detached' });
        expect(await input.inputValue()).toBe('/compact ');
        await input.pressSequentially('keep the notes');
        expect(await page.locator('[data-testid="composer-hint"]').textContent()).toBe(
          'Runs /compact on Claude.',
        );
        await input.press('Enter');
        await page
          .locator('[data-testid="thread-entry"][data-by="human"]', {
            hasText: '/compact keep the notes',
          })
          .waitFor();

        // /login can't run headless: held, with how to log in; nothing is sent.
        await input.fill('/login');
        await input.press('Enter');
        const held = page.locator('[data-testid="composer-held"]');
        await held.waitFor();
        expect(await held.textContent()).toContain(
          'Log in from a terminal instead (run claude and type /login)',
        );
        expect(await held.locator('code').textContent()).toBe('claude');
        expect(await input.inputValue()).toBe('/login');
        expect(
          await page
            .locator('[data-testid="thread-entry"][data-by="human"]', { hasText: '/login' })
            .count(),
        ).toBe(0);
        // An unknown command says it goes as a message.
        await input.fill('/frobnicate');
        await held.waitFor({ state: 'detached' });
        expect(await page.locator('[data-testid="composer-hint"]').textContent()).toBe(
          'Claude doesn’t offer /frobnicate here, so this goes as a message.',
        );
        await input.fill('');

        // The first turn ends; the command is the next turn, sent as typed.
        writeFileSync(release, '');
        await page
          .locator('[data-testid="thread-entry"][data-by="agent"]', {
            hasText: 'Compacted the conversation.',
          })
          .waitFor();
        const sent = readFileSync(promptLog, 'utf8')
          .split('\n')
          .filter((l) => l.includes('"session/prompt"'))
          .map(
            (l) =>
              (JSON.parse(l) as { params: { prompt: { text: string }[] } }).params.prompt[0]?.text,
          );
        expect(sent[1]).toBe('/compact keep the notes');
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(release, { force: true });
        rmSync(promptLog, { force: true });
      }
    },
    90_000,
  );
});

describe('permissions: the Ask card and Settings (Playwright e2e, T457)', () => {
  browserTest(
    "an agent's read outside its repos raises Allow once / Always / Deny; Always persists and lets it read; Settings shows and removes it",
    async () => {
      const cockpit = await startCockpit();
      const outside = mkdtempSync(join(tmpdir(), 'agile-e2e-outside-'));
      const worktree = mkdtempSync(join(tmpdir(), 'agile-e2e-wt-'));
      let page: Page | undefined;
      try {
        mkdirSync(join(outside, 'src'), { recursive: true });
        writeFileSync(join(outside, 'src', 'a.ts'), 'export const a = 1;\n');
        writeFileSync(join(outside, 'src', 'b.ts'), 'export const b = 2;\n');
        const project = await cockpit.projects.create({ name: 'Cents' });
        const node = await cockpit.streams.create('human', {
          title: 'Cents check',
          goal: 'check the cents',
          project: project.id,
        });
        const agent = '01ARZ3NDEKTSV4RRFFQ69GE457';
        await cockpit.store.putAgent(agent as AgentId, {
          vendor: 'claude',
          model: 'test-model',
          stream: node.id,
          last_seen: new Date().toISOString(),
          role: 'worker',
          worktree,
        });
        // The agent's own PreToolUse hook call, as `agile hook` forwards it.
        const hook = new HookService(cockpit.store, new Bus(cockpit.store, cockpit.home), {
          agileHome: cockpit.home,
          gates: cockpit.gates,
        });
        const read = async (file: string) =>
          (
            await hook.preToolUse({
              cwd: worktree,
              tool_name: 'Read',
              tool_input: { file_path: join(outside, 'src', file) },
              agile_agent: agent,
            })
          ).hookSpecificOutput;

        const first = await read('a.ts');
        expect(first.permissionDecision).toBe('deny');
        expect(first.permissionDecisionReason).toContain('held for the human');
        const gate = cockpit.gates.list().find((g) => g.read_root !== undefined);
        if (gate === undefined) throw new Error('no read gate raised');
        const root = join(outside, 'src');
        expect(gate.read_root).toBe(root);

        page = await openPage();
        await page.goto(`${cockpit.base}/`);
        const card = `[data-testid="inbox"] [data-id="${gate.id}"]`;
        await page.locator(card).waitFor({ state: 'visible' });
        expect(await page.locator(`${card} .kind`).textContent()).toBe('Allow this read?');
        const lead = await page.locator(`${card} [data-testid="gate-read-lead"]`).textContent();
        expect(lead).toContain('Cents check wants to read');
        expect(lead).toContain(root);
        expect(await page.locator(`${card} [data-testid="gate-approve"]`).textContent()).toBe(
          'Allow once',
        );
        expect(await page.locator(`${card} [data-testid="gate-deny"]`).count()).toBe(1);
        await page.locator(`${card} [data-testid="gate-always"]`).click();
        await page.locator(card).waitFor({ state: 'detached' });
        await waitUntil('the root to be saved on the project', () => {
          const saved = cockpit.store.getProject(project.id).read_roots;
          return saved?.length === 1 && saved[0] === root;
        });
        expect(cockpit.gates.get(gate.id).decision).toBe('approve');
        // The retry, and any other read in that dir, go through without a card.
        expect((await read('a.ts')).permissionDecision).toBe('allow');
        expect((await read('b.ts')).permissionDecision).toBe('allow');
        expect(cockpit.gates.list().filter((g) => g.status === 'pending')).toHaveLength(0);

        // Settings → General → Permissions: the project inherits Ask, and lists its Always dir.
        await page.goto(`${cockpit.base}/?view=settings`);
        const row = `[data-testid="settings-permissions-project-${project.id}"]`;
        await page.locator(row).waitFor({ state: 'visible' });
        await waitForText(page, `${row} [data-testid$="-inherits"]`, 'Inherits Ask from the home');
        expect(await page.locator(`${row} [data-testid$="-roots"] code`).textContent()).toBe(root);
        await page.locator('[data-testid="settings-permissions-trusted"]').click();
        await waitUntil('the home to be Trusted', () => {
          return cockpit.store.getHomeConfig().permissions === 'trusted';
        });
        await waitForText(
          page,
          `${row} [data-testid$="-inherits"]`,
          'Inherits Trusted from the home',
        );
        await page.locator(`${row} [data-testid$="-root-remove"]`).click();
        await waitUntil('the root to be removed', () => {
          return cockpit.store.getProject(project.id).read_roots === undefined;
        });
        await page.locator(`${row} [data-testid$="-roots"]`).waitFor({ state: 'detached' });
        await page
          .locator(`${row} [data-testid="settings-permissions-project-${project.id}-ask"]`)
          .click();
        await waitUntil('the project to override with Ask', () => {
          return cockpit.store.getProject(project.id).permissions === 'ask';
        });
      } finally {
        await teardown([page]);
        await cockpit.stop();
        rmSync(outside, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});
