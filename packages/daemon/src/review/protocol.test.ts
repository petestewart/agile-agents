import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Finding, Ticket, TicketId } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus/bus';
import { runInit } from '../init';
import { agentIdFor } from '../runner/runner';
import { ticketBranchName } from '../runner/worktrees';
import { StateStore } from '../store/store';
import {
  ReReviewViolationError,
  ReviewProtocol,
  type ReviewRunner,
  type SubmitVerdictInput,
  requiresSecurityPass,
} from './protocol';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let fakeRunner: ReviewRunner & { spawnCalls: TicketId[] };

const REVIEWER_ID = 'reviewer-1' as AgentId;
const SECURITY_REVIEWER_ID = 'reviewer-2' as AgentId;
const ENGINEER_ID = 'eng-1' as AgentId;

function git(args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-review-proto-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial'], { cwd: repo });

  // Real `integration` + ticket branches so `ReviewProtocol.submitVerdict`
  // can compute its own diff hunks (opus review, blocker 1) instead of
  // trusting a caller-supplied value. Line 10 of `src/a.ts` is where
  // `ruleFinding()` below points — modified on the ticket branch so it
  // falls inside a real hunk.
  const branch = ticketBranchName(makeTicket());
  git(['checkout', '-q', '-b', 'integration']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  const base = `${Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`;
  writeFileSync(join(repo, 'src', 'a.ts'), base);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', branch]);
  const lines = base.split('\n');
  lines[9] = '// line 10 CHANGED';
  writeFileSync(join(repo, 'src', 'a.ts'), lines.join('\n'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'engineer edit']);

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

function protocol(): ReviewProtocol {
  return new ReviewProtocol({
    store,
    bus,
    runner: fakeRunner,
    repoRoot: repo,
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

  test('attempts still increments when the ticket was pointed without a routing block (opus review, nit)', async () => {
    const noRouting = makeTicket();
    // biome-ignore lint/performance/noDelete: constructing a fixture missing an optional field.
    delete (noRouting as { routing?: unknown }).routing;
    await store.putTicket(noRouting);
    const outcome = await protocol().submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [ruleFinding()],
      verdict: 'request_changes',
    });
    expect(outcome).toEqual({ status: 'in_progress', attempts: 1, escalated: false });
    expect(store.getTicket('TKT-0001' as TicketId).routing?.attempts).toBe(1);
  });

  test('clean resubmission approves and moves the ticket to in_qa', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();
    await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [ruleFinding()],
      verdict: 'request_changes',
    });
    // Engineer fixed it and resubmitted for round 2 — back to in_review the
    // same way `start()` would put it there.
    await store.transitionTicket('TKT-0001' as TicketId, 'in_review', { by: 'daemon' });
    const outcome = await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 2,
      findings: [],
      verdict: 'approve',
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
    });

    // Nothing in the worktree changed between rounds — the reviewer now
    // tries to raise a finding at that same, still-unchanged location.
    await store.transitionTicket('TKT-0001' as TicketId, 'in_progress', { by: 'daemon' });
    await store.transitionTicket('TKT-0001' as TicketId, 'in_review', { by: 'daemon' });

    await expect(
      proto.submitVerdict(REVIEWER_ID, {
        ticket: 'TKT-0001' as TicketId,
        round: 2,
        findings: [ruleFinding()],
        verdict: 'request_changes',
      }),
    ).rejects.toThrow(ReReviewViolationError);
  });

  test('a client-supplied fake `hunks` value cannot suppress the rejection (opus review, blocker 1)', async () => {
    await store.putTicket(makeTicket());
    const proto = protocol();

    await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'approve',
    });
    await store.transitionTicket('TKT-0001' as TicketId, 'in_progress', { by: 'daemon' });
    await store.transitionTicket('TKT-0001' as TicketId, 'in_review', { by: 'daemon' });

    // A reviewer session forging a `hunks` array that claims the location
    // was never seen before (or was already different) must not be able to
    // buy its way past the convergence check — the daemon ignores this
    // entirely and computes the real diff itself.
    const forged = {
      ticket: 'TKT-0001' as TicketId,
      round: 2,
      findings: [ruleFinding()],
      verdict: 'request_changes',
      hunks: [{ path: 'src/a.ts', newStart: 999, newEnd: 999, hash: 'totally-fake' }],
    } as unknown as SubmitVerdictInput;

    await expect(proto.submitVerdict(REVIEWER_ID, forged)).rejects.toThrow(ReReviewViolationError);
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
    });
    expect(outcome).toEqual({ status: 'escalated_by_reviewer' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');
    const emInbox = bus.poll('em' as AgentId, {});
    expect(emInbox.some((m) => m.kind === 'escalate')).toBe(true);
  });

  test('security: true requires primary + security approve from DISTINCT reviewer agents (opus review, blocker 2)', async () => {
    await store.putTicket(makeTicket({ security: true }));
    const proto = protocol();

    const outcome = await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'approve',
    });
    expect(outcome).toEqual({ status: 'security_pass_required' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');

    const outcome2 = await proto.submitVerdict(SECURITY_REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      pass: 'security',
      findings: [],
      verdict: 'approve',
    });
    expect(outcome2).toEqual({ status: 'in_qa' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_qa');
  });

  test('a lone security-pass approve never moves the ticket on its own (opus review, blocker 2)', async () => {
    await store.putTicket(makeTicket({ security: true }));
    const outcome = await protocol().submitVerdict(SECURITY_REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      pass: 'security',
      findings: [],
      verdict: 'approve',
    });
    expect(outcome).toEqual({ status: 'security_pass_required' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');
  });

  test('the SAME reviewer agent approving both passes does not satisfy the security gate (opus review, blocker 2)', async () => {
    await store.putTicket(makeTicket({ security: true }));
    const proto = protocol();
    await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      findings: [],
      verdict: 'approve',
    });
    const outcome = await proto.submitVerdict(REVIEWER_ID, {
      ticket: 'TKT-0001' as TicketId,
      round: 1,
      pass: 'security',
      findings: [],
      verdict: 'approve',
    });
    expect(outcome).toEqual({ status: 'security_pass_required' });
    expect(store.getTicket('TKT-0001' as TicketId).status).toBe('in_review');
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
