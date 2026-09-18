/**
 * T044: the sprint-review narrative. One builder and one renderer serve
 * both the control room's Review tab and `runs/<ts>.md`, so these tests
 * cover the narrative itself — the acceptance criterion "the Review tab's
 * narrative equals the `runs/*.md` body" is then a property of there being
 * one implementation, which the e2e checks end to end.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaReportRelPath, validateMergeRecord, validateQaReport } from '@agile-agents/shared';
import { GateService } from '../gates';
import { runInit } from '../init';
import { mergeRecordPath } from '../merge/owner';
import { reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { StateStore } from '../store';
import { buildSprintReport, renderSprintReportMarkdown } from './report';

let repo: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-report-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  store = StateStore.open(runInit(repo).stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function seedFinishedSprint(): Promise<void> {
  await store.putSprint({
    id: 'S-1',
    goal: 'Transfers, reversals, category report',
    tickets: ['TKT-0001', 'TKT-0002'],
    budget_tokens: 1000,
    started: new Date().toISOString(),
    carried_over: [],
  });
  for (const [id, title] of [
    ['TKT-0001', 'Add Ledger.transfer between accounts'],
    ['TKT-0002', 'Add Ledger.reverse(txId, date)'],
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
    await store.putEntity(reviewRecordRelPath(id, 1, 'primary'), validateReviewRecord, {
      ticket: id,
      round: 1,
      pass: 'primary',
      agent: `reviewer-${id}`,
      ts: new Date().toISOString(),
      findings: [],
      verdict: 'approve',
      hunks: [],
    });
    await store.putEntity(qaReportRelPath(id, 1), validateQaReport, {
      ticket: id,
      round: 1,
      lines: [{ criterion: 'it works', status: 'pass', evidence: 'bun test passed' }],
      verdict: 'accept',
    });
    await store.putEntity(mergeRecordPath(id), validateMergeRecord, {
      ticket: id,
      status: 'merged',
      at: new Date().toISOString(),
      mergeCommit: 'abc1234',
    });
    for (const to of ['ready', 'assigned', 'in_progress', 'in_review', 'in_qa', 'done'] as const) {
      await store.transitionTicket(id, to, { by: 'test' });
    }
  }
}

test('the four paragraphs name the goal, the tickets, the outcome and where the code is', async () => {
  await seedFinishedSprint();
  const report = buildSprintReport(store);
  expect(report.sprint).toBe('S-1');
  expect(report.asked).toContain('Transfers, reversals, category report');
  expect(report.asked).toContain('TKT-0001');
  expect(report.built).toContain('2 of 2');
  expect(report.built).toContain('2 merged');
  expect(report.went_wrong).toContain('Nothing went wrong');
  expect(report.where).toContain('integration');
  expect(report.per_ticket).toHaveLength(2);
  expect(report.per_ticket[0]?.merged).toBe(true);
  expect(report.per_ticket[0]?.text).toContain('Review 1 round: approve');
  expect(report.per_ticket[0]?.text).toContain('QA accepted');
});

test('a second review round and an open halt show up in "what went wrong"', async () => {
  await seedFinishedSprint();
  await store.putEntity(reviewRecordRelPath('TKT-0001', 2, 'primary'), validateReviewRecord, {
    ticket: 'TKT-0001',
    round: 2,
    pass: 'primary',
    agent: 'reviewer-TKT-0001',
    ts: new Date().toISOString(),
    findings: [],
    verdict: 'approve',
    hunks: [],
  });
  await store.putEntity(reviewRecordRelPath('TKT-0001', 1, 'primary'), validateReviewRecord, {
    ticket: 'TKT-0001',
    round: 1,
    pass: 'primary',
    agent: 'reviewer-TKT-0001',
    ts: new Date().toISOString(),
    findings: [
      {
        severity: 'major',
        message: 'validation runs after the write',
        location: { path: 'src/ledger.ts', line: 12 },
        rule: 'RULE-001',
      },
    ],
    verdict: 'request_changes',
    hunks: [],
  });
  await store.putHalt({
    id: 'H-1',
    scope: ['TKT-0001'],
    reason: 'rebase conflict in src/ledger.ts',
    raised_by: 'agiled',
    quorum: 'pending',
  });

  const report = buildSprintReport(store);
  expect(report.went_wrong).toContain('TKT-0001 needed 2 review rounds');
  expect(report.went_wrong).toContain('rebase conflict in src/ledger.ts');
});

test('"decisions made without you" lists only delegated, resolved gates, with the note', async () => {
  await seedFinishedSprint();
  // A delegate is what makes an `em`-owned gate auto-decide (and stamp
  // `delegated: true`) — without one it would just stay pending, per
  // `GateServiceOptions.delegate`'s fail-closed rule.
  const gates = new GateService(store, {
    delegate: () => ({
      decision: 'approve' as const,
      by: 'em',
      rationale: "QA's tests run only in its clone",
    }),
  });
  const mine = await gates.request('unblock', {
    policy: { gates: { unblock: 'human' }, breaker_signals: [] },
    hilKind: 'unblock',
    summary: 'QA wants to create a test file',
  });
  await gates.respond(mine.id, 'approve', 'human');

  const delegated = await gates.request('unblock', {
    policy: { gates: { unblock: 'em' }, breaker_signals: [] },
    hilKind: 'unblock',
    ticket: 'TKT-0002',
    summary: 'QA wants to create a test file',
  });
  expect(delegated.status).toBe('resolved');

  const report = buildSprintReport(store, { gates });
  expect(report.decisions).toHaveLength(1);
  expect(report.decisions[0]?.decided_by).toBe('em');
  expect(report.decisions[0]?.gate).toContain('QA wants to create a test file');
  expect(report.decisions[0]?.outcome).toContain('Allowed');
  expect(report.decisions[0]?.ticket).toBe('TKT-0002');
});

test('the markdown body carries every section, the narrative verbatim, and the greppable summary the run report has always had', async () => {
  await seedFinishedSprint();
  const report = buildSprintReport(store, { diagnostics: ['Ceremony ticks used: 12'] });
  const markdown = renderSprintReportMarkdown(report);

  // The four paragraphs the Review tab renders are the same strings here —
  // this is what makes "the narrative equals the runs/*.md body" true.
  expect(markdown).toContain(`**What was asked:** ${report.asked}`);
  expect(markdown).toContain(`**What was built:** ${report.built}`);
  expect(markdown).toContain(`**What went wrong:** ${report.went_wrong}`);
  expect(markdown).toContain(`**Where the code is:** ${report.where}`);

  expect(markdown).toContain('## Per ticket');
  expect(markdown).toContain('## Decisions made without you');
  expect(markdown).toContain('## What the EM proposes next');
  // Kept from the pre-T044 report — `agile run`'s e2e asserts on these.
  expect(markdown).toContain('## Per-ticket outcome');
  expect(markdown).toContain('- TKT-0001: status=done, merged=yes');
  expect(markdown).toContain('## Review rounds per ticket');
  expect(markdown).toContain('- TKT-0001: 1 round (approve)');
  expect(markdown).toContain('## Run diagnostics');
  expect(markdown).toContain('- Ceremony ticks used: 12');
});

test('an unfinished ticket is proposed for carry-over, not silently dropped', async () => {
  await seedFinishedSprint();
  await store.putTicket({
    id: 'TKT-0003',
    title: 'Add categoryBreakdown report',
    status: 'in_qa',
    sprint: 'S-1',
    contract: { inputs: [], outputs: [], acceptance: ['it works'], done: [], env: 'clone' },
    depends: [],
    oracle_refs: [],
    kb_refs: [],
    history: [],
    security: false,
  });
  const report = buildSprintReport(store, { tickets: ['TKT-0001', 'TKT-0002', 'TKT-0003'] });
  expect(report.proposes_next.some((line) => line.includes('TKT-0003'))).toBe(true);
  // An unfinished ticket is carried, not reported as a failure.
  expect(report.went_wrong).not.toContain('TKT-0003');
});
