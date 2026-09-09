import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Finding, Ticket, TicketId } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus/bus';
import { runInit } from '../init';
import { agentIdFor } from '../runner/runner';
import { StateStore } from '../store/store';
import type { DiffHunk } from './diff-summary';
import {
  ReReviewViolationError,
  ReviewProtocol,
  type ReviewRunner,
  requiresSecurityPass,
} from './protocol';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let fakeRunner: ReviewRunner & { spawnCalls: TicketId[] };

const REVIEWER_ID = 'reviewer-1' as AgentId;
const ENGINEER_ID = 'eng-1' as AgentId;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-review-proto-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
  fakeRunner = {
    spawnCalls: [],
    async spawn(_role, ticket) {
      fakeRunner.spawnCalls.push(ticket);
      return { agentId: REVIEWER_ID, worktree: join(repo, '.worktrees', ticket) };
    },
  };
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id: 'TKT-0001',
    title: 'Fixture ticket',
    status: 'in_review',
    contract: {},
    history: [],
    routing: { attempts: 0, max_attempts: 2, escalation: ['standard', 'hard'] },
    estimate: {
      points: 3,
      tier: 'standard',
      reasoning: 'medium',
      pointed_by: 'architect',
      pointed_at: '2026-09-01',
    },
    ...overrides,
  });
}

function protocol(): ReviewProtocol {
  return new ReviewProtocol({
    store,
    bus,
    runner: fakeRunner,
    now: () => new Date('2026-09-09T00:00:00Z'),
  });
}

function ruleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'blocker',
    rule: 'RULE-001',
    location: { path: 'src/a.ts', line: 10 },
    message: 'planted violation',
    ...overrides,
  };
}

function hunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return { path: 'src/a.ts', newStart: 5, newEnd: 20, hash: 'h1', ...overrides };
}

describe('ReviewProtocol.start', () => {
  test('transitions in_progress -> in_review and spawns the reviewer', async () => {
    await store.putTicket(makeTicket({ status: 'in_progress' }));
    const result = await protocol().start('TKT-0001' as TicketId);
    expect(result.round).toBe(1);
    expect(fakeRunner.spawnCalls).toEqual(['TKT-0001']);
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');
  });
});

describe('ReviewProtocol.submitVerdict', () => {
  test('request_changes citing a planted rule violation: ticket -> in_progress, attempts 1, review_verdict sent', async () => {
    await store.putTicket(makeTicket());
    const outcome = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [ruleFinding()],
      verdict: 'request_changes',
      hunks: [hunk()],
    });
    expect(outcome).toEqual({ status: 'in_progress', attempts: 1, escalated: false });

    const ticket = store.getTicket('TKT-0001' as TicketId);
    expect(ticket.status).toBe('in_progress');
    expect(ticket.routing?.attempts).toBe(1);

    const inbox = bus.poll(agentIdFor('engineer', 'TKT-0001' as TicketId), {});
    expect(
      inbox.some((m) => m.kind === 'review_verdict' && m.body.includes('request_changes')),
    ).toBe(true);
  });

  test('clean resubmission approves and moves the ticket to in_qa', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();
    await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [ruleFinding()],
      verdict: 'request_changes',
      hunks: [hunk()],
    });
    // Engineer fixed it (a different hunk hash) and resubmitted for round 2
    // — back to in_review the same way `start()` would put it there.
    await store.transitionTicket('TKT-0001' as TicketId, 'in_review', { by: 'daemon' });
    const outcome = await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 2,
      findings: [],
      verdict: 'approve',
      hunks: [hunk({ hash: 'h2' })],
    });
    expect(outcome).toEqual({ status: 'in_qa' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_qa');
  });

  test('rejects a round-2 finding whose location was visible, unchanged, in round 1', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();

    // Round 1: reviewer approves without noticing the RULE-001 spot (its
    // hunk is recorded regardless of whether it was flagged).
    await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'approve',
      hunks: [hunk()],
    });

    // The engineer resubmits (nothing at that location changed — same hunk
    // hash) and the reviewer now tries to raise a finding there for the
    // first time.
    await store.transitionTicket('TKT-0001' as TicketId, 'in_progress', { by: 'daemon' });
    await store.transitionTicket('TKT-0001' as TicketId, 'in_review', { by: 'daemon' });

    await expect(
      proto.submitVerdict(REVIEWER_ID, {
        ticket: 'TKT-0001' as TicketId,
        round: 2,
        findings: [ruleFinding()],
        verdict: 'request_changes',
        hunks: [hunk()], // same hash as round 1 — unchanged
      }),
    ).rejects.toThrow(ReReviewViolationError);
  });

  test('attempts reaching max_attempts sends an escalate message to em', async () => {
    await store.putTicket(
      makeTicket({ routing: { attempts: 1, max_attempts: 2, escalation: ['standard', 'hard'] } }),
    );
    const outcome = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [ruleFinding()],
      verdict: 'request_changes',
      hunks: [hunk()],
    });
    expect(outcome).toEqual({ status: 'in_progress', attempts: 2, escalated: true });
    const emInbox = bus.poll('em' as AgentId, {});
    expect(emInbox.some((m) => m.kind === 'escalate' && m.body.includes('would escalate'))).toBe(
      true,
    );
  });

  test('escalate verdict notifies em without transitioning the ticket', async () => {
    await store.putTicket(makeTicket());
    const outcome = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'escalate',
      hunks: [],
    });
    expect(outcome).toEqual({ status: 'escalated_by_reviewer' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');
    const emInbox = bus.poll('em' as AgentId, {});
    expect(emInbox.some((m) => m.kind === 'escalate')).toBe(true);
  });

  test('security: true requires a second, security-pass approval before in_qa', async () => {
    await store.putTicket(makeTicket({ security: true }));
    const outcome = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'approve',
      hunks: [],
    });
    expect(outcome).toEqual({ status: 'security_pass_required' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');

    const outcome2 = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      pass: 'security',
      findings: [],
      verdict: 'approve',
      hunks: [],
    });
    expect(outcome2).toEqual({ status: 'in_qa' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_qa');
  });

  test('hard tier also requires a security pass', () => {
    const ticket = makeTicket({
      security: false,
      estimate: {
        points: 5,
        tier: 'hard',
        reasoning: 'high',
        pointed_by: 'architect',
        pointed_at: '2026-09-01',
      },
    });
    expect(requiresSecurityPass(ticket)).toBe(true);
  });

  test('trivial/standard tier with security: false does not require a security pass', () => {
    expect(requiresSecurityPass(makeTicket())).toBe(false);
  });
});

describe('ReviewProtocol.dispute', () => {
  test('a single dispute does not route to the architect', async () => {
    await store.putTicket(makeTicket());
    const outcome = await protocol().dispute(ENGINEER_ID, {
      ticket: 'TKT-0001' as TicketId,
      finding: ruleFinding(),
    });
    expect(outcome).toEqual({ count: 1, routedToArchitect: false });
    const architectInbox = bus.poll('architect' as AgentId, {});
    expect(architectInbox).toEqual([]);
  });

  test('a second disagreement on the same finding routes a question to the architect via em', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();
    await proto.dispute(ENGINEER_ID, { ticket: 'TKT-0001' as TicketId, finding: ruleFinding() });
    const outcome = await proto.dispute(ENGINEER_ID, {
      ticket: 'TKT-0001' as TicketId,
      finding: ruleFinding({ message: 'restated dispute' }),
    });
    expect(outcome).toEqual({ count: 2, routedToArchitect: true });

    const architectInbox = bus.poll('architect' as AgentId, {});
    expect(architectInbox).toHaveLength(1);
    expect(architectInbox[0]?.kind).toBe('question');
    expect(architectInbox[0]?.from).toBe('em');
  });

  test('disputing a different finding does not compound the count', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();
    await proto.dispute(ENGINEER_ID, { ticket: 'TKT-0001' as TicketId, finding: ruleFinding() });
    const outcome = await proto.dispute(ENGINEER_ID, {
      ticket: 'TKT-0001' as TicketId,
      finding: ruleFinding({ location: { path: 'src/b.ts', line: 1 } }),
    });
    expect(outcome).toEqual({ count: 1, routedToArchitect: false });
  });
});
