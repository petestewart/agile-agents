import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TicketId, validateQaReport, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus/bus';
import { runInit } from '../init';
import { StateStore } from '../store/store';
import { QaEnvUnsupportedError } from './env';
import { QaProtocol } from './protocol';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
/** Doubles as the QA clone's worktree — real `bun test` invocations run against fixture files placed here. */
let qaWorktree: string;

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-qa-protocol-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'initial commit'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);

  qaWorktree = mkdtempSync(join(tmpdir(), 'agile-qa-clone-'));
  writeFileSync(
    join(qaWorktree, 'pass.test.ts'),
    "import { test, expect } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
  );
  writeFileSync(
    join(qaWorktree, 'fail.test.ts'),
    "import { test, expect } from 'bun:test';\ntest('fails', () => { expect(1).toBe(2); });\n",
  );
  // Deterministic "flaky": fails the first time it's run in this worktree
  // (writes a marker file), passes the second (marker already exists) —
  // this ticket's Design note: "a deterministic 'flaky' test (fails first
  // run via a marker file, passes second)".
  writeFileSync(
    join(qaWorktree, 'flaky.test.ts'),
    [
      "import { test, expect } from 'bun:test';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "test('flaky', () => {",
      "  if (!existsSync('flaky.marker')) {",
      "    writeFileSync('flaky.marker', '1');",
      '    expect(false).toBe(true);',
      '  } else {',
      '    expect(true).toBe(true);',
      '  }',
      '});',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(qaWorktree, { recursive: true, force: true });
});

function makeProtocol(): QaProtocol {
  return new QaProtocol({ store, bus, repoRoot: repo });
}

function makeTicket(id: TicketId, overrides: Record<string, unknown> = {}) {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'in_qa',
    contract: { acceptance: [] },
    assignee: 'eng-1',
    worktree: `.worktrees/${id}`,
    history: [],
    ...overrides,
  });
}

describe('QaProtocol.start', () => {
  test('refuses a compose env', async () => {
    const ticket = makeTicket('TKT-0001' as TicketId, {
      contract: { acceptance: ['x'], env: 'compose: docker/compose.test.yml' },
    });
    await store.putTicket(ticket);
    expect(() => makeProtocol().start(ticket, qaWorktree)).toThrow(QaEnvUnsupportedError);
  });

  test('round increments across QA rounds on the same ticket', async () => {
    const ticket = makeTicket('TKT-0002' as TicketId, { contract: { acceptance: ['a'] } });
    await store.putTicket(ticket);
    const protocol = makeProtocol();
    expect(protocol.start(ticket, qaWorktree).round).toBe(1);

    // Simulate an already-recorded prior round by writing straight into
    // board/qa/ (what a real reject would have left behind).
    await store.putEntity('board/qa/TKT-0002-r1.yaml', validateQaReport, {
      ticket: 'TKT-0002',
      round: 1,
      lines: [{ criterion: 'a', status: 'fail', evidence: 'x' }],
      verdict: 'reject',
    });
    expect(protocol.start(ticket, qaWorktree).round).toBe(2);
  });
});

describe('QaProtocol end-to-end (real test_run, fixture project)', () => {
  test('accept: a passing + a flaky criterion accepts, transitions to done, files a KB fact', async () => {
    const ticket = makeTicket('TKT-0010' as TicketId, {
      contract: { acceptance: ['the pass suite passes', 'the flaky suite eventually passes'] },
    });
    await store.putTicket(ticket);
    const protocol = makeProtocol();

    protocol.start(ticket, qaWorktree);
    protocol.plan(ticket.id, { 0: 'bun test pass.test.ts', 1: 'bun test flaky.test.ts' });
    const results = await protocol.run(ticket.id);
    expect(results.map((r) => r.status)).toEqual(['pass', 'flaky']);

    const report = await protocol.submit(ticket.id, 'qa-10');
    expect(report.verdict).toBe('accept');
    expect(report.lines).toHaveLength(2);

    const stored = store.getTicket(ticket.id);
    expect(stored.status).toBe('done');

    // qa_verdict delivered to the engineer + em copy, one message.
    const engineerInbox = bus.poll('eng-1');
    expect(engineerInbox.some((m) => m.kind === 'qa_verdict')).toBe(true);
    const emInbox = bus.poll('em');
    expect(emInbox.some((m) => m.kind === 'qa_verdict')).toBe(true);

    // Flaky finding filed to the KB (§13 "Flakiness").
    const kbIndex = store.listKbIndex();
    const flakyFacts = Object.values(kbIndex).filter((f) => f.kind === 'gotcha');
    expect(flakyFacts.length).toBeGreaterThanOrEqual(1);
  });

  test('reject: a failing criterion rejects, bumps attempts, and escalates at max_attempts', async () => {
    const ticket = makeTicket('TKT-0011' as TicketId, {
      contract: { acceptance: ['the fail suite passes'] },
      routing: { attempts: 0, max_attempts: 1, escalation: [] },
    });
    await store.putTicket(ticket);
    const protocol = makeProtocol();

    protocol.start(ticket, qaWorktree);
    protocol.plan(ticket.id, { 0: 'bun test fail.test.ts' });
    await protocol.run(ticket.id);
    const report = await protocol.submit(ticket.id, 'qa-11');

    expect(report.verdict).toBe('reject');
    const stored = store.getTicket(ticket.id);
    expect(stored.status).toBe('in_progress');
    expect(stored.routing?.attempts).toBe(1);

    // attempts (1) >= max_attempts (1) -> escalate to em.
    const emInbox = bus.poll('em');
    expect(emInbox.some((m) => m.kind === 'escalate')).toBe(true);
  });

  test('skipped criterion (no qa_plan command) does not force a reject but escalates the finding', async () => {
    const ticket = makeTicket('TKT-0012' as TicketId, {
      contract: { acceptance: ['a UI criterion nothing can exercise headlessly'] },
    });
    await store.putTicket(ticket);
    const protocol = makeProtocol();

    protocol.start(ticket, qaWorktree);
    // No qa_plan call at all — the criterion stays unplanned.
    const results = await protocol.run(ticket.id);
    expect(results[0]?.status).toBe('skipped');

    const report = await protocol.submit(ticket.id, 'qa-12');
    expect(report.verdict).toBe('accept');

    const emInbox = bus.poll('em');
    expect(emInbox.some((m) => m.kind === 'escalate')).toBe(true);
  });

  test('qa.status reflects the in-flight round and clears after submit', async () => {
    const ticket = makeTicket('TKT-0013' as TicketId, {
      contract: { acceptance: ['x', 'y'] },
    });
    await store.putTicket(ticket);
    const protocol = makeProtocol();

    expect(protocol.status(ticket.id)).toBeUndefined();
    protocol.start(ticket, qaWorktree);
    protocol.plan(ticket.id, { 0: 'bun test pass.test.ts' });
    expect(protocol.status(ticket.id)).toEqual({
      round: 1,
      criteriaCount: 2,
      plannedCount: 1,
      ranCount: 0,
    });

    await protocol.run(ticket.id);
    expect(protocol.status(ticket.id)?.ranCount).toBe(2);

    await protocol.submit(ticket.id, 'qa-13');
    expect(protocol.status(ticket.id)).toBeUndefined();
  });
});
