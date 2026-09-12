/**
 * Plan screen e2e (T042 — §17 "Control room v2", mockup `#s2`; ticket
 * Validation Steps: "Playwright against a seeded daemon plus one no-seed
 * walkthrough"). Same Chromium discovery and `startDaemon` harness as
 * `control-room.e2e.test.ts`; no vendor is ever spawned — the architect's
 * planning turn runs through the same `ArchitectPlanner` seam the live path
 * uses, with a double that calls the daemon's own architect verbs.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TicketId } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { registerArchitectTools } from '../architect';
import { type DaemonHandle, startDaemon } from '../daemon';
import { runInit } from '../init';
import type { ArchitectPlanner } from '../plan';
import { StateStore } from '../store';
import { resolveChromiumExecutable } from './chromium';

const executablePath = resolveChromiumExecutable();

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

function git(args: string[], cwd: string): string {
  return new TextDecoder().decode(Bun.spawnSync(['git', ...args], { cwd }).stdout).trim();
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
 * Teardown budget for `browser.close()`. Same bound, and the same reason, as
 * `control-room.e2e.test.ts`'s `closeBrowserBounded`: under a loaded
 * multi-file e2e run bun's harness intermittently fails to observe the
 * Chromium child's exit, and every assertion has already passed by then.
 */
const BROWSER_CLOSE_BUDGET_MS = 10_000;

async function closeBrowserBounded(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  const closed = await Promise.race([
    browser.close().then(() => true),
    Bun.sleep(BROWSER_CLOSE_BUDGET_MS).then(() => false),
  ]);
  if (!closed) {
    console.error(
      `plan e2e: browser.close() did not return within ${BROWSER_CLOSE_BUDGET_MS}ms — leaving it to bun's dangling-process cleanup (teardown only; every assertion passed)`,
    );
  }
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

async function openPlan(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/control-room`);
  // The Plan tab in the existing strip (T043 owns the top-bar nav that makes
  // Plan the landing view).
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.locator('[data-testid="plan-screen"]').waitFor({ state: 'attached', timeout: 10000 });
}

describe('Plan screen (Playwright e2e)', () => {
  test('every pane renders daemon data, and every edit lands in events.jsonl and on agile-state', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
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
      const page = await browser.newPage();
      await openPlan(page, handle.http.port);

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
      expect(await page.locator('[data-testid="pane-policy"] tbody tr').count()).toBeGreaterThan(0);

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

      // Every one of those writes is a commit on the agile-state worktree.
      await store.flush();
      const subjects = git(['log', '--format=%s'], init.stateRoot).split('\n');
      expect(subjects).toContain('entity_put');
      expect(subjects).toContain('oracle_put');
      expect(subjects).toContain('kb_put');
      expect(subjects).toContain('ticket_put');
    } finally {
      await closeBrowserBounded(browser);
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);

  test('no-seed walkthrough: agile init, goal in the chat, panes fill, Start Sprint 1 runs', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      expect(store.listTickets()).toHaveLength(0);

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
        // The one seam: no vendor login in CI, so the planning turn runs the
        // same daemon verbs through a double (see `cannedArchitect`).
        architectPlanner: cannedArchitect(store),
      });
      const page = await browser.newPage();
      await openPlan(page, handle.http.port);

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

      // Start Sprint 1 — the one action, no other approval step.
      const start = page.locator('[data-testid="start-sprint"]');
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
      // And the screen says a sprint is running.
      await until(
        page,
        async () =>
          (await page.locator('[data-testid="plan-status"]').textContent())?.includes('S-1') ??
          false,
        'the sprint-started notice',
      );
    } finally {
      await closeBrowserBounded(browser);
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);
});
