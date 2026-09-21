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
import { qaReportRelPath, ulid, validateMergeRecord, validateQaReport } from '@agile-agents/shared';
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

/**
 * A sprint that has stopped: `em/review.ts` stamps `review_at` (and the
 * retro block) when the `sprint_review` gate resolves, and T050 makes that
 * the difference between the review narrative and a progress report — so
 * the fixture for the narrative has to carry it.
 */
async function seedFinishedSprint(): Promise<void> {
  await store.putSprint({
    id: 'S-1',
    goal: 'Transfers, reversals, category report',
    tickets: ['TKT-0001', 'TKT-0002'],
    budget_tokens: 1000,
    started: new Date().toISOString(),
    review_at: new Date().toISOString(),
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
  const mine = await gates.request('classifier_review', {
    policy: { gates: { classifier_review: 'human' }, breaker_signals: [] },
    stream: ulid(),
    summary: 'QA wants to create a test file',
  });
  await gates.respond(mine.id, 'approve', 'human');

  const delegated = await gates.request('classifier_review', {
    policy: { gates: { classifier_review: 'em' }, breaker_signals: [] },
    stream: ulid(),
    summary: 'QA wants to create a test file',
  });
  expect(delegated.status).toBe('resolved');

  const report = buildSprintReport(store, { gates });
  expect(report.decisions).toHaveLength(1);
  expect(report.decisions[0]?.decided_by).toBe('em');
  expect(report.decisions[0]?.gate).toContain('QA wants to create a test file');
  expect(report.decisions[0]?.outcome).toContain('Allowed');
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

/**
 * T050 — the defect this closes: 1m27s into a live sprint, with every
 * ticket `in_progress` and no `sprint_review` gate anywhere, the narrative
 * read "0 of 3 ticket(s) finished", "Nothing went wrong" and "Carry
 * TKT-2001, TKT-2002 and TKT-2003 into the next sprint — 3 tickets did not
 * finish", and the control room offered it as a review to accept.
 */
async function seedRunningSprint(): Promise<void> {
  await store.putSprint({
    id: 'S-1',
    goal: 'Transfers, reversals, category report',
    tickets: ['TKT-0001', 'TKT-0002', 'TKT-0003'],
    budget_tokens: 1000,
    started: new Date().toISOString(),
    carried_over: [],
  });
  for (const id of ['TKT-0001', 'TKT-0002', 'TKT-0003'] as const) {
    await store.putTicket({
      id,
      title: `Ticket ${id}`,
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
}

test('a running sprint is phase "running", has no proposal, and never reads like a finished sprint', async () => {
  await seedRunningSprint();
  const report = buildSprintReport(store, { gates: new GateService(store) });

  expect(report.phase).toBe('running');
  expect(report.decision).toBeUndefined();
  // The three sentences from the screenshot, none of which may appear.
  expect(report.proposes_next).toEqual([]);
  expect(report.built).not.toContain('0 of 3 ticket(s) finished and');
  expect(report.went_wrong).not.toContain('Nothing went wrong');
  expect(JSON.stringify(report)).not.toContain('did not finish');
  // What it says instead: the same facts, labelled as in progress.
  expect(report.built).toContain('In progress');
  expect(report.built).toContain('0 of 3 finished so far');
  expect(report.built).toContain('3 tickets still in flight');
  expect(report.went_wrong).toContain('still running');
  expect(report.per_ticket).toHaveLength(3);

  const markdown = renderSprintReportMarkdown(report);
  expect(markdown).toContain('# Sprint progress');
  expect(markdown).toContain('**Status:** the sprint is still running');
  expect(markdown).not.toContain('## What the EM proposes next');
});

// T121: `sprint_review` is a deleted gate kind (cockpit design §3.1), so no
// gate can flip the report into a review phase any more. T122 deletes this
// module with the rest of the ceremony layer.
test('no gate flips the report out of the running phase any more', async () => {
  await seedRunningSprint();
  const gates = new GateService(store);
  const request = await gates.request('land', {
    policy: { gates: { land: 'human' }, breaker_signals: [] },
    stream: ulid(),
    summary: 'S-1 is ready for your review',
  });
  expect(buildSprintReport(store, { gates }).phase).toBe('running');
  await gates.respond(request.id, 'approve', 'human', 'ship it');
  expect(buildSprintReport(store, { gates }).phase).toBe('running');
});
