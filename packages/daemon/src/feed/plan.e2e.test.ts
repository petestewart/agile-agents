/**
 * Plan screen e2e (T042 — §17 "Control room v2", mockup `#s2`; ticket
 * Validation Steps: "Playwright against a seeded daemon plus one no-seed
 * walkthrough"). Same Chromium discovery and `startDaemon` harness as
 * `control-room.e2e.test.ts`; no vendor is ever spawned — the architect's
 * planning turn runs through the same `ArchitectPlanner` seam the live path
 * uses, with a double that calls the daemon's own architect verbs.
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
import type { Ticket, TicketId } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { registerArchitectTools } from '../architect';
import { type DaemonHandle, startDaemon } from '../daemon';
import { runInit } from '../init';
import type { ArchitectPlanner } from '../plan';
import { DEFAULT_FAKE_MODEL } from '../runner/fake-agent';
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
 * The resident EM's ACP transport, faked exactly as `control-room.e2e.test.ts`
 * does it. Round-1 review caught the omission: without this, the walkthrough's
 * chat post makes the daemon try to spawn a **real** vendor (no login in CI),
 * which fails late and leaves a dangling child behind — harmless to this
 * file's own assertions, but it was enough extra load to time out a Playwright
 * test in `control-room.e2e.test.ts` later in the same `test:e2e` run.
 */
function cannedEmSpawn(repo: string, reply: string): (opts: SpawnSessionOptions) => SpawnedSession {
  const scriptPath = join(repo, 'em-chat-script.json');
  writeFileSync(
    scriptPath,
    JSON.stringify({ steps: [{ type: 'agent_text', text: reply }, { type: 'end_turn' }] }),
  );
  return (opts: SpawnSessionOptions) =>
    spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: scriptPath },
    });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-plan-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# ledger-lite\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

/**
 * T049: a minimal valid ticket for the defect tests below — the same shape
 * the seeded walkthrough writes by hand, factored out because three of them
 * need one and none of them cares about the contract.
 */
function seedTicket(id: TicketId, title: string, status: Ticket['status']): Ticket {
  return {
    id,
    title,
    description: 'Records a withdrawal and a deposit as one operation.',
    status,
    ...(status === 'in_progress' ? { assignee: `eng-${id}` } : {}),
    contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
    depends: [],
    oracle_refs: [],
    kb_refs: [],
    history: [],
    security: false,
  };
}

/**
 * The offline stand-in for a real architect planning turn: it calls exactly
 * the verbs `renderPlanningPrompt` asks the architect for — the same
 * `ARCHITECT_TOOLS` handlers an `agile mcp --agent architect` bridge would
 * dispatch to — so the daemon side of the planning turn (write guard,
 * `putDoc`, `refineTicket`'s draft→ready edge, the store's events/commits)
 * is what runs here, not a mock of it.
 */
function cannedArchitect(store: StateStore): ArchitectPlanner {
  const tools = registerArchitectTools({ store });
  const ctx = { agent: 'architect' as const };
  return async ({ goal }) => {
    await tools.callTool(ctx, 'product_brief_write', {
      body: `# Product\n\nledger-lite is a tiny in-memory personal ledger.\n\n## Non-goals\n\nPersistence, auth.\n\n## Current goal\n\n${goal}\n`,
    });
    await tools.callTool(ctx, 'decision_publish', {
      entry: {
        id: 'SPEC-quality-001',
        title: 'Code quality baseline',
        status: 'active',
        supersedes: [],
        depends: [],
        affects: [],
        decided: new Date().toISOString(),
        by: 'architect',
        rationale: 'Drafted from README.md and the existing tests.',
      },
      body: 'Money is always integer cents; every public function validates its inputs.',
    });
    const first = (await tools.callTool(ctx, 'ticket_create', {
      title: 'Add Ledger.transfer between accounts',
      oracle_refs: ['SPEC-quality-001'],
    })) as { id: TicketId };
    await tools.callTool(ctx, 'ticket_refine', {
      id: first.id,
      contract: { acceptance: ['transfer records a withdrawal and a deposit'] },
    });
    // A later-layer ticket stays a stub: title, one-line summary, depends.
    await tools.callTool(ctx, 'ticket_create', {
      title: 'Reverse a transfer as a pair',
      depends: [first.id],
    });
  };
}

/**
 * Browser harness, mirroring `control-room.e2e.test.ts`'s (T043) rather than
 * inventing a second one: ONE Chromium for the file, re-launched if bun's
 * dangling-process cleanup kills it from outside, a bounded close (a close
 * that never returns must not burn a test's budget), a real per-page action
 * timeout, and per-test teardown of the page *context* before its daemon
 * stops. That file's own comments document the measurements behind each.
 */
const PAGE_TIMEOUT_MS = 10_000;
const SHARED_CLOSE_BUDGET_MS = 3_000;

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
let sharedBrowser: Browser | undefined;

/** A page on a browser that is alive: the shared one when it still answers, a fresh one when it does not. */
async function newSharedPage(): Promise<Page> {
  const acquired = await acquireBrowserPage({
    label: 'plan e2e',
    cached: sharedBrowser,
    launch: () => chromium.launch({ executablePath }),
    openPage: (browser) => browser.newPage(),
  }).catch((err: unknown) => {
    sharedBrowser = undefined;
    throw err;
  });
  // The only place this file caches a browser, and it can only ever be the
  // one `acquireBrowserPage` handed back (review round 1 blocker 1).
  sharedBrowser = acquired.browser;
  return acquired.page;
}

/** The wedged browser is dropped *and* closed: `isConnected()` still reports true for it, so nothing else will ever notice it. */
function discardSharedBrowser(): void {
  const wedged = sharedBrowser;
  sharedBrowser = undefined;
  if (wedged) void wedged.close().catch(() => {});
}

/**
 * T047 review round 1: how long a body may take before it is treated as
 * wedged rather than slow, and the per-test budget that has to hold two of
 * them. `BODY_BUDGET_MS` sits above the worst *legitimate* body — a full
 * `BROWSER_ATTEMPTS` acquisition sweep plus one page action running out its
 * `PAGE_TIMEOUT_MS` — so a genuinely failing body always surfaces its own
 * error first and only a body making no progress at all is retried.
 * See `browserTest` for what is being defended against.
 */
const BODY_BUDGET_MS = PAGE_TIMEOUT_MS + BROWSER_READY_BUDGET_MS * BROWSER_ATTEMPTS + 5_000;

/** Every test in this file: room for a wedged body, its retry, and slack. */
const TEST_BUDGET_MS = BODY_BUDGET_MS * 2 + 5_000;

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
      `plan e2e: the shared browser.close() did not return within ${SHARED_CLOSE_BUDGET_MS}ms — left to bun's dangling-process cleanup (teardown only; every assertion passed)`,
    );
  }
});

function isBrowserGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Target (page, context or browser|closed)|browser has been closed|has been closed/i.test(
    message,
  );
}

/**
 * A browser-driven test that survives its browser going quiet underneath it.
 *
 * Two failure modes, one recovery. The browser can be *killed* from outside
 * this file (bun's dangling-process cleanup — the `isBrowserGoneError` case
 * above, which fails fast and loudly), or it can stay alive and simply stop
 * answering. T047 review round 1 measured the second one directly: a watchdog
 * inside the body logged `isConnected() === true` on every 5 s tick for the
 * whole 60 s the test was stuck, and the body was still running a minute
 * after bun had failed the test and moved on — bun's per-test timeout cancels
 * nothing. So a wedge is invisible to `isConnected()`, invisible to
 * `isBrowserGoneError`, and invisible to `PAGE_TIMEOUT_MS` (the calls that
 * hang are often ones that take no timeout at all: `waitForTimeout`,
 * `locator.count()`, `evaluate`). Bounding the body is the only bound test
 * code has. Which suite gets hit moves between runs, so this is not one bad
 * wait in one test to rewrite.
 *
 * Re-running a body from the top is safe by this file's own design: every
 * body makes its own repo, daemon and page and cleans all three up in its own
 * `finally`. An abandoned body keeps running — nothing can cancel it — but it
 * only ever touches its own temp repo and then tidies itself away.
 */
function browserTest(name: string, body: () => Promise<void>, timeoutMs: number): void {
  test(
    name,
    async () => {
      const retry = async (reason: string): Promise<void> => {
        console.error(
          `plan e2e: "${name}" ${reason} — replacing the browser and running it once more`,
        );
        discardSharedBrowser();
        const second = await runWithinBudget(body, BODY_BUDGET_MS);
        if (!second.done) {
          throw new Error(
            `plan e2e: "${name}" made no progress for ${BODY_BUDGET_MS}ms twice over, on two different browsers — the page is wedged, not slow`,
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

async function teardown(pages: Array<Page | undefined>): Promise<void> {
  await Promise.allSettled(
    pages.filter((p): p is Page => p !== undefined).map((p) => p.context().close()),
  );
}

/** Polls until `check` passes, so a debounce-driven refetch isn't a flake. */
async function until(page: Page, check: () => Promise<boolean>, what: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(100);
  }
}

/**
 * Opens the control room. Plan is the landing view (T043's shell, switched to
 * `plan` by this ticket — §17 v2 "The repo opens here with an empty plan and
 * a chat"), so no navigation is needed; the assertion that the Plan screen is
 * what renders on load is the point.
 */
async function openPlan(port: number): Promise<Page> {
  const page = await newSharedPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  await page.goto(`http://127.0.0.1:${port}/control-room`);
  await page.locator('[data-testid="plan-screen"]').waitFor({ state: 'attached', timeout: 10000 });
  return page;
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

describe('Plan screen (Playwright e2e)', () => {
  browserTest(
    'every pane renders daemon data, and every edit lands in events.jsonl',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        await store.putTicket({
          id: 'TKT-9001',
          title: 'Add Ledger.transfer',
          description: 'Records a withdrawal and a deposit as one operation.',
          status: 'in_progress',
          assignee: 'eng-9001',
          contract: {
            inputs: [],
            outputs: [],
            acceptance: ['rejects the same account'],
            done: [],
            env: 'clone',
          },
          depends: [],
          oracle_refs: [],
          kb_refs: [],
          history: [],
          security: false,
        });
        await store.putTicket({
          id: 'TKT-9002',
          title: 'Reverse a transfer as a pair',
          description: 'Both legs reversed together.',
          status: 'draft',
          contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
          depends: ['TKT-9001'],
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
        const page = await openPlan(handle.http.port);
        openedPage = page;

        // --- Tickets pane (the default) renders the seeded tickets, stub marked.
        await page
          .locator('[data-testid="plan-ticket-TKT-9001"]')
          .waitFor({ state: 'attached', timeout: 10000 });
        expect(await page.locator('[data-testid="plan-ticket-TKT-9002"]').textContent()).toContain(
          'stub',
        );

        // --- Living plan: editing the in-flight ticket is a contract change,
        // not a silent rewrite (ticket AC).
        await page.locator('[data-testid="plan-ticket-edit-TKT-9001"]').click();
        await page.locator('[data-testid="ticket-title"]').fill('Add Ledger.transfer (both legs)');
        await page.locator('[data-testid="ticket-save"]').click();
        await until(
          page,
          async () =>
            (await page.locator('[data-testid="ticket-status"]').textContent())?.includes(
              'contract change',
            ) ?? false,
          'the contract-change notice',
        );
        const messages = store.listEvents().filter((e) => e.kind === 'message');
        expect(messages.length).toBeGreaterThan(0);

        // --- Brief pane: render + edit.
        await page.locator('[data-testid="rail-brief"]').click();
        await page.locator('[data-testid="brief-edit"]').click();
        await page.locator('[data-testid="brief-text"]').fill('# Product\n\nA tiny ledger.\n');
        await page.locator('[data-testid="brief-save"]').click();
        await until(
          page,
          async () =>
            (await page.locator('[data-testid="brief-body"]').textContent())?.includes(
              'A tiny ledger',
            ) ?? false,
          'the saved brief',
        );

        // --- Rules pane: render + add.
        await page.locator('[data-testid="rail-rules"]').click();
        await page.locator('[data-testid="rule-add"]').click();
        await page.locator('[data-testid="rule-title"]').fill('Money is integer cents');
        await page.locator('[data-testid="rule-body"]').fill('No float arithmetic on amounts.');
        await page.locator('[data-testid="rule-save"]').click();
        await until(
          page,
          async () => (await page.locator('.cr-plan .rule .id').count()) > 0,
          'the saved rule',
        );

        // --- Questions pane: render + ask.
        await page.locator('[data-testid="rail-questions"]').click();
        await page
          .locator('[data-testid="question-ask"]')
          .fill('Is a same-account transfer an error?');
        await page.locator('[data-testid="question-ask-send"]').click();
        await until(
          page,
          async () => store.listEvents().some((e) => e.kind === 'question_raised'),
          'the raised question',
        );

        // --- Knowledge pane: render + add.
        await page.locator('[data-testid="rail-knowledge"]').click();
        await page.locator('[data-testid="fact-add"]').click();
        await page.locator('[data-testid="fact-body"]').fill('Tests run with bun test.');
        await page.locator('[data-testid="fact-save"]').click();
        await until(
          page,
          async () => store.listEvents().some((e) => e.kind === 'kb_put'),
          'the saved fact',
        );

        // --- Who decides: read-only render of policy.yaml.
        await page.locator('[data-testid="rail-policy"]').click();
        await page
          .locator('[data-testid="pane-policy"]')
          .waitFor({ state: 'attached', timeout: 5000 });
        expect(await page.locator('[data-testid="pane-policy"] tbody tr').count()).toBeGreaterThan(
          0,
        );

        // --- Sprints pane: the next sprint is settled, the stub is projected,
        // and the ticket detail panel carries blocked-by/blocks.
        await page.locator('[data-testid="rail-sprints"]').click();
        await page
          .locator('[data-testid="sprint-ticket-TKT-9002"]')
          .waitFor({ state: 'attached', timeout: 5000 });
        await page.locator('[data-testid="sprint-ticket-TKT-9002"]').click();
        expect(await page.locator('[data-testid="detail-blocked-by"]').textContent()).toContain(
          'TKT-9001',
        );

        // --- Decisions pane: publishing a decision no ticket cites still
        // re-examines every not-done ticket (ticket AC).
        await page.locator('[data-testid="rail-decisions"]').click();
        await page.locator('[data-testid="decision-add"]').click();
        await page.locator('[data-testid="decision-title"]').fill('Money is integer cents');
        await page.locator('[data-testid="decision-body"]').fill('Integers everywhere.');
        await page.locator('[data-testid="decision-publish"]').click();
        await until(
          page,
          async () => store.listEvents().filter((e) => e.kind === 'ticket_reexamined').length >= 2,
          'a re-examination record per not-done ticket',
        );
        const reexamined = store.listEvents().filter((e) => e.kind === 'ticket_reexamined');
        expect(new Set(reexamined.map((e) => e.ticket))).toEqual(
          new Set(['TKT-9001', 'TKT-9002'] as TicketId[]),
        );

        // T111: every one of those writes is a line in the home's event log
        // (the audit trail the `agile-state` commit used to be).
        await store.flush();
        const kinds = store.listEvents().map((e) => e.kind);
        expect(kinds).toContain('entity_put');
        expect(kinds).toContain('oracle_put');
        expect(kinds).toContain('kb_put');
        expect(kinds).toContain('ticket_put');
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'a proposal waiting on an em-owned approve_plan disables Start Sprint instead of offering a second one',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        await store.putTicket({
          id: 'TKT-9301',
          title: 'Frontier ticket',
          status: 'ready',
          contract: {
            inputs: [],
            outputs: [],
            acceptance: ['does the thing'],
            done: [],
            env: 'clone',
          },
          depends: [],
          oracle_refs: [],
          kb_refs: [],
          history: [],
          security: false,
        });
        // Settings could do this from the UI (T043's `PUT /api/policy`); the
        // point of this test is the *state after* the gate is raised, so the
        // policy is seeded directly.
        const policy = store.getPolicy();
        await store.putPolicy({ ...policy, gates: { ...policy.gates, approve_plan: 'em' } });

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });
        const base = `http://127.0.0.1:${handle.http.port}`;
        const started = (await (
          await fetch(`${base}/api/sprint/start`, { method: 'POST' })
        ).json()) as { started: boolean; gate: { owner: string; status: string } };
        // Nothing was written — the EM owns the gate and there is no delegate.
        expect(started.started).toBe(false);
        expect(started.gate.owner).toBe('em');
        expect(store.listSprints()).toEqual([]);

        const page = await openPlan(handle.http.port);
        openedPage = page;

        const action = page.locator('[data-testid="sprint-action"]');
        await until(
          page,
          async () => (await action.getAttribute('disabled')) !== null,
          'the top-bar action to report the pending gate',
        );
        expect(await action.textContent()).toContain('Start Sprint 1');
        expect(await action.getAttribute('title')).toContain('approve_plan pending');
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'no-seed walkthrough: agile init, goal in the chat, panes fill, Start Sprint 1 runs',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        expect(store.listTickets()).toHaveLength(0);

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          // Two seams, both offline: the planning turn runs the same daemon
          // verbs through a double (see `cannedArchitect`), and the resident EM
          // the chat post also wakes answers over the fake ACP transport
          // instead of trying to spawn a vendor that isn't installed.
          architectPlanner: cannedArchitect(store),
          emChatSpawn: cannedEmSpawn(repo, 'on it'),
        });
        const page = await openPlan(handle.http.port);
        openedPage = page;

        // The empty plan is what the repo opens on.
        await page
          .locator('[data-testid="tickets-empty"]')
          .waitFor({ state: 'attached', timeout: 10000 });

        // The goal is the first chat message.
        const textarea = page.locator('.cr-chat-input textarea');
        await textarea.waitFor({ state: 'attached', timeout: 5000 });
        await textarea.fill('Add transfers, reversals and a per-category breakdown');
        await page.locator('.cr-chat-input button').click();

        // The architect fills the panes: brief, a rule, one refined ticket and
        // one stub.
        await until(
          page,
          async () => store.listTickets().length >= 2,
          'the architect to write the plan',
          20000,
        );
        expect(store.getDoc('oracle/product.md')).toContain('Add transfers');
        expect(Object.keys(store.listOracleIndex())).toContain('SPEC-quality-001');
        await until(
          page,
          async () => (await page.locator('[data-testid^="plan-ticket-TKT-"]').count()) >= 2,
          'the tickets pane to fill',
        );

        // Start Sprint 1 — the one action, in T043's top bar, with no other
        // approval step (§17 v2: "the single action (Start Sprint N / Halt
        // Sprint N)").
        const start = page.locator('[data-testid="sprint-action"]');
        await until(page, async () => start.isEnabled(), 'Start Sprint to enable');
        expect(await start.textContent()).toContain('Start Sprint 1');
        await start.click();
        await until(page, async () => store.listSprints().length === 1, 'the sprint to be planned');

        const sprint = store.listSprints()[0];
        expect(sprint?.id).toBe('S-1');
        expect(sprint?.tickets).toHaveLength(1); // the stub is a later layer
        // The gate was raised *and* resolved by the click itself.
        const hil = handle.gateService?.list() ?? [];
        const approvePlan = hil.filter((r) => r.gate === 'approve_plan');
        expect(approvePlan).toHaveLength(1);
        expect(approvePlan[0]?.status).toBe('resolved');
        expect(approvePlan[0]?.decision).toBe('approve');
        // And the top bar says a sprint is running, without a reload.
        await until(
          page,
          async () =>
            (await page.locator('[data-testid="sprint-status"]').textContent())?.includes(
              'Sprint 1 · running',
            ) ?? false,
          'the top bar to show the running sprint',
        );
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

/**
 * T049 — the eight defects from Pete's first hands-on pass of the v2 control
 * room, each with the acceptance check the ticket names. They share this
 * file's harness (one repo, one daemon, one bounded page per body) because
 * every one of them is a Plan-screen (or Plan-screen chat) behaviour.
 */
describe('Control room defects (T049)', () => {
  browserTest(
    'closing the last pane leaves the rail, the top-bar tabs and the restore icon all working',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        runInit(freshHome());
        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });
        const page = await openPlan(handle.http.port);
        openedPage = page;

        const pane = page.locator('[data-testid="pane-tickets"]');
        await pane.waitFor({ state: 'attached', timeout: 10000 });

        // --- Close the pane: the rail survives (§17 v2 "the rail collapses
        // to icons", never disappears).
        await page.locator('[data-testid="pane-close"]').first().click();
        await until(page, async () => (await pane.count()) === 0, 'the pane to close');
        expect(await page.locator('[data-testid="rail-tickets"]').count()).toBe(1);

        // --- The rail still opens a pane.
        await page.locator('[data-testid="rail-brief"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="pane-brief"]').count()) === 1,
          'the rail to re-open a pane',
        );

        // --- Close it again, then a top-bar tab round trip brings it back.
        await page.locator('[data-testid="pane-close"]').first().click();
        await until(
          page,
          async () => (await page.locator('[data-testid="pane-brief"]').count()) === 0,
          'the pane to close again',
        );
        await page.locator('[data-view="sprint"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="sprint-tab-sprint"]').count()) === 1,
          'the Sprint view to render',
        );
        await page.locator('[data-view="settings"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="settings"]').count()) === 1,
          'the Settings view to render',
        );
        await page.locator('[data-view="plan"]').click();
        // A pane is open again — which one is the Plan screen's own default
        // (`tickets`), since remounting the screen resets its pane choice;
        // the defect was that *no* pane came back at all.
        await until(
          page,
          async () => (await page.locator('.cr-plan .pane').count()) === 1,
          'the Plan pane to come back with the tab',
        );

        // --- And the maximize/restore icon brings the middle pane back too.
        await page.locator('[data-testid="pane-close"]').first().click();
        await until(
          page,
          async () => (await page.locator('.cr-plan .pane').count()) === 0,
          'the pane to close a third time',
        );
        await page.locator('[data-testid="chat-maximize"]').click();
        await until(
          page,
          async () => (await page.locator('.cr-plan .pane').count()) === 1,
          'the restore icon to bring the pane back',
        );
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

/**
 * T049 defects 1, 2, 4 and 8 — everything about the Tickets pane's editor:
 * where it opens, that it can be abandoned, that the pane's close does not
 * sit on top of the pane's own action, and that a done ticket's edit asks
 * before it becomes a follow-up.
 */
describe('Tickets pane editor (T049)', () => {
  browserTest(
    'the editor opens on the card it edits, Add ticket cancels, and the close never overlaps the action',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        await store.putTicket(seedTicket('TKT-9101', 'Add Ledger.transfer', 'draft'));
        await store.putTicket(seedTicket('TKT-9102', 'Reverse a transfer as a pair', 'draft'));

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });
        const page = await openPlan(handle.http.port);
        openedPage = page;

        const card = page.locator('[data-testid="plan-ticket-TKT-9101"]');
        await card.waitFor({ state: 'attached', timeout: 10000 });

        // --- Defect 4: the pane's X and the pane's action button are two
        // boxes in one header row, and they must not intersect.
        const addBox = await page.locator('[data-testid="ticket-add"]').boundingBox();
        const closeBox = await page.locator('[data-testid="pane-close"]').first().boundingBox();
        if (!addBox || !closeBox) throw new Error('the header buttons have no layout box');
        const overlaps =
          addBox.x < closeBox.x + closeBox.width &&
          closeBox.x < addBox.x + addBox.width &&
          addBox.y < closeBox.y + closeBox.height &&
          closeBox.y < addBox.y + addBox.height;
        expect(overlaps).toBe(false);

        // --- Defect 1: Edit renders the editor inside that ticket's own
        // card, headed by its id and title — not a bare form at the top of
        // the pane.
        await page.locator('[data-testid="plan-ticket-edit-TKT-9101"]').click();
        const heading = page.locator('[data-testid="ticket-editor-for-TKT-9101"]');
        await heading.waitFor({ state: 'attached', timeout: 5000 });
        expect(await heading.textContent()).toContain('TKT-9101');
        expect(await heading.textContent()).toContain('Add Ledger.transfer');
        expect(await card.locator('[data-testid="ticket-editor"]').count()).toBe(1);
        // The other ticket is untouched — one editor, on one card.
        expect(
          await page
            .locator('[data-testid="plan-ticket-TKT-9102"] [data-testid="ticket-editor"]')
            .count(),
        ).toBe(0);

        // --- Defect 1: Cancel leaves the card as it was, nothing written.
        await page.locator('[data-testid="ticket-title"]').fill('Something else entirely');
        await page.locator('[data-testid="ticket-cancel"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="ticket-editor"]').count()) === 0,
          'Cancel to close the editor',
        );
        expect(await page.locator('[data-testid="plan-ticket-open-TKT-9101"]').count()).toBe(1);
        expect(store.getTicket('TKT-9101').title).toBe('Add Ledger.transfer');

        // --- Defect 2: Add ticket has a Cancel too, and it creates nothing.
        await page.locator('[data-testid="ticket-add"]').click();
        await page
          .locator('[data-testid="ticket-editor"]')
          .waitFor({ state: 'attached', timeout: 5000 });
        await page.locator('[data-testid="ticket-title"]').fill('A ticket I changed my mind about');
        await page.locator('[data-testid="ticket-cancel"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="ticket-editor"]').count()) === 0,
          'Add ticket to cancel',
        );
        expect(store.listTickets()).toHaveLength(2);
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );

  browserTest(
    'editing a done ticket asks first: Cancel writes nothing, Confirm opens one follow-up with a distinct title',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        await store.putTicket(seedTicket('TKT-9201', 'Add Ledger.transfer', 'done'));

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });
        const page = await openPlan(handle.http.port);
        openedPage = page;

        await page
          .locator('[data-testid="plan-ticket-TKT-9201"]')
          .waitFor({ state: 'attached', timeout: 10000 });

        // --- Cancel at the confirm step creates nothing (the old behaviour
        // minted a follow-up stub on every save, TKT-2004/2005).
        await page.locator('[data-testid="plan-ticket-edit-TKT-9201"]').click();
        await page.locator('[data-testid="ticket-save"]').click();
        const confirm = page.locator('[data-testid="ticket-followup-confirm"]');
        await confirm.waitFor({ state: 'attached', timeout: 5000 });
        expect(await confirm.textContent()).toContain('done');
        expect(await confirm.textContent()).toContain('follow-up');
        await page.locator('[data-testid="ticket-cancel"]').click();
        await until(
          page,
          async () => (await page.locator('[data-testid="ticket-editor"]').count()) === 0,
          'the confirm to be dismissed',
        );
        expect(store.listTickets()).toHaveLength(1);

        // --- Confirm creates exactly one follow-up, and its title is not the
        // parent's.
        await page.locator('[data-testid="plan-ticket-edit-TKT-9201"]').click();
        await page.locator('[data-testid="ticket-save"]').click();
        await page
          .locator('[data-testid="ticket-followup-confirm-save"]')
          .waitFor({ state: 'attached', timeout: 5000 });
        await page.locator('[data-testid="ticket-followup-confirm-save"]').click();
        await until(page, async () => store.listTickets().length === 2, 'the follow-up to be made');
        const followUp = store.listTickets().find((t) => t.id !== 'TKT-9201');
        expect(followUp?.title).not.toBe('Add Ledger.transfer');
        expect(followUp?.title).toContain('Follow-up');
        expect(followUp?.depends).toContain('TKT-9201');
        // And the pane says which ticket it opened, by name.
        await until(
          page,
          async () =>
            (await page.locator('[data-testid="ticket-status"]').textContent())?.includes(
              followUp?.id ?? 'never',
            ) ?? false,
          'the follow-up notice',
        );
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});

/**
 * T049 defects 5, 6 and 7 — the chat header's `vendor / model`, markdown in
 * the EM's replies, and the Brief pane as prose rather than a monospace
 * block. All three run offline: the resident EM is the fake ACP transport,
 * which reports `fake/model-1` on `session/new` exactly as a real vendor
 * reports its own model.
 */
describe('Chat header and markdown (T049)', () => {
  browserTest(
    "the header names the session's vendor and model, the EM's markdown reply renders as elements, and the Brief is prose",
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let openedPage: Page | undefined;

      try {
        const init = runInit(freshHome());
        const store = StateStore.open(init.stateRoot);
        // A seeded ticket keeps this out of the first-goal path: the chat post
        // below is an ordinary EM turn, not the architect's planning turn.
        await store.putTicket(seedTicket('TKT-9301', 'Add Ledger.transfer', 'in_progress'));
        await store.putDoc(
          'oracle/product.md',
          '# Product\n\nledger-lite is a tiny personal ledger.\n\n## Non-goals\n\n- persistence\n- auth\n',
        );
        // A SPEC and a DEC with the shape the ticket's screenshot shows
        // rendered as literal text: a `#` heading, a numbered list, a
        // backticked symbol. Written through the architect's own verb, so
        // the oracle index and the write guard are what put them there.
        const oracle = registerArchitectTools({ store });
        const architect = { agent: 'architect' as const };
        await oracle.callTool(architect, 'decision_publish', {
          entry: {
            id: 'SPEC-ledger-002',
            title: 'Transactions are immutable once recorded',
            status: 'active',
            supersedes: [],
            depends: [],
            affects: [],
            decided: new Date().toISOString(),
            by: 'architect',
            rationale: 'Drafted from README.md.',
          },
          body: '# SPEC-ledger-002: Transactions are immutable\n\n1. Once recorded, a transaction is never edited.\n2. A correction is a new transaction that reverses the original.\n\nNever call `Ledger.mutate()`.\n',
        });
        await oracle.callTool(architect, 'decision_publish', {
          entry: {
            id: 'DEC-0001',
            title: 'Amounts are integer cents',
            status: 'active',
            supersedes: [],
            depends: [],
            affects: [],
            decided: new Date().toISOString(),
            by: 'architect',
            rationale: 'Floating point lost a cent in the spike.',
          },
          body: '# DEC-0001: Integer cents\n\n1. Every amount is an integer number of cents.\n2. No floating-point arithmetic on money.\n',
        });

        const reply = [
          'Two tickets are open right now.',
          '',
          '- **TKT-9301** — `Ledger.transfer()`',
          '- **TKT-9302** — `Ledger.reverse()`',
          '',
          'S-1 goes to review once both land.',
        ].join('\n');

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
          emChatSpawn: cannedEmSpawn(repo, reply),
        });
        const page = await openPlan(handle.http.port);
        openedPage = page;

        // --- Defect 7: the Brief renders as markdown prose, so `# Product`
        // is an <h1> and the non-goals are list items — not a <pre> of hashes.
        await page.locator('[data-testid="rail-brief"]').click();
        const brief = page.locator('[data-testid="brief-body"]');
        await brief.waitFor({ state: 'attached', timeout: 10000 });
        await until(
          page,
          async () => (await brief.locator('.cr-md h1').count()) === 1,
          'the brief to render its heading as an <h1>',
        );
        expect(await brief.locator('.cr-md h1').textContent()).toBe('Product');
        expect(await brief.locator('.cr-md h2').textContent()).toBe('Non-goals');
        expect(await brief.locator('.cr-md ul li').count()).toBe(2);
        expect(await brief.locator('pre').count()).toBe(0);
        // Edit mode is the only place the raw file is shown.
        await page.locator('[data-testid="brief-edit"]').click();
        await page
          .locator('[data-testid="brief-text"]')
          .waitFor({ state: 'attached', timeout: 5000 });
        expect(await page.locator('[data-testid="brief-text"]').inputValue()).toContain(
          '# Product',
        );
        expect(await page.locator('[data-testid="brief-body"]').count()).toBe(0);
        await page.locator('.cr-plan .dochd button', { hasText: 'Cancel' }).click();

        // --- The same rule for the other markdown files the plan keeps: a
        // SPEC body's `#` heading is an <h1> and its numbered list is an
        // <ol>, not the literal hashes and digits of the ticket's screenshot.
        await page.locator('[data-testid="rail-rules"]').click();
        const ruleBody = page.locator('[data-testid="rule-body-SPEC-ledger-002"]');
        await ruleBody.waitFor({ state: 'attached', timeout: 10000 });
        expect(await ruleBody.locator('h1').count()).toBe(1);
        expect(await ruleBody.locator('h1').textContent()).toBe(
          'SPEC-ledger-002: Transactions are immutable',
        );
        expect(await ruleBody.locator('ol li').count()).toBe(2);
        expect(await ruleBody.locator('code').count()).toBe(1);
        expect(await ruleBody.textContent()).not.toContain('`');

        // --- And the Decisions pane, which reads the same kind of file.
        await page.locator('[data-testid="rail-decisions"]').click();
        const decisionBody = page.locator('[data-testid="decision-body-DEC-0001"]');
        await decisionBody.waitFor({ state: 'attached', timeout: 10000 });
        expect(await decisionBody.locator('h1').count()).toBe(1);
        expect(await decisionBody.locator('ol li').count()).toBe(2);

        // --- Defects 5 and 6: one chat turn against the fake vendor.
        const textarea = page.locator('.cr-chat-input textarea');
        await textarea.waitFor({ state: 'attached', timeout: 5000 });
        await textarea.fill('what is open?');
        await page.locator('.cr-chat-input button').click();

        const emLine = page.locator('.cr-chat-msg[data-from="em"]');
        await until(page, async () => (await emLine.count()) >= 1, "the EM's reply", 20000);
        await until(
          page,
          async () => (await emLine.first().locator('.cr-md ul li').count()) === 2,
          'the reply to render its list as <li> elements',
          20000,
        );
        expect(await emLine.first().locator('.cr-md strong').count()).toBe(2);
        expect(await emLine.first().locator('.cr-md code').count()).toBe(2);
        expect(await emLine.first().locator('.cr-md p').count()).toBe(2);
        expect(await emLine.first().locator('.cr-md').textContent()).not.toContain('**');

        // Defect 5: `vendor / model`, with the model the fake session
        // reported on `session/new` — never `unknown` once it has reported.
        await until(
          page,
          async () =>
            (await page.locator('[data-testid="chat-model"]').textContent())?.includes(
              DEFAULT_FAKE_MODEL,
            ) ?? false,
          'the chat header to name the session model',
          20000,
        );
        expect(await page.locator('[data-testid="chat-model"]').textContent()).toContain('/');
      } finally {
        await teardown([openedPage]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});
