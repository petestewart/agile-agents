import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Ticket, TicketId } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { StateStore } from '../store';
import {
  type DoneMerger,
  type QaSpawner,
  type ReviewRunner,
  type ReviewStarter,
  advanceArchitectInbox,
  advanceDoneTickets,
  advanceEngineerVerdicts,
  advanceHilResolutions,
  advanceMergeConflicts,
  advanceQaSpawns,
  advanceResumes,
  advanceReviewRequests,
  advanceReviewerEscalations,
  advanceSecurityReviews,
  dispatchTurn,
  releaseStaleTicketSessions,
} from './pipeline-glue';
import { agentIdFor, securityReviewerIdFor } from './runner';

/** A `ReviewRunner` test double — `live` is the fake's own in-process-map stand-in, deliberately never touching the store, matching the real `Runner.isLive`/`Runner.promptAgent` contract (`runner.ts`). */
function fakeReviewRunner(
  initiallyLive: AgentId[] = [],
): ReviewRunner & { prompted: Array<{ agentId: AgentId; text: string }> } {
  const live = new Set(initiallyLive);
  const prompted: Array<{ agentId: AgentId; text: string }> = [];
  return {
    prompted,
    isLive: (agentId) => live.has(agentId),
    promptAgent: async (agentId, text) => {
      if (!live.has(agentId)) throw new Error(`fakeReviewRunner: ${agentId} is not live`);
      prompted.push({ agentId, text });
    },
  };
}

let repo: string;
let store: StateStore;
let bus: Bus;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-pipeline-glue-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeTicket(id: TicketId, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'in_progress',
    contract: {},
    history: [],
    ...overrides,
  });
}

function fakeEngineerRunner(initiallyLive: AgentId[] = []) {
  const base = fakeReviewRunner(initiallyLive);
  const spawned: Array<{ ticket: TicketId; extraContext?: string }> = [];
  return {
    ...base,
    spawned,
    spawn: async (_role: 'engineer', ticket: TicketId, opts?: { extraContext?: string }) => {
      spawned.push({ ticket, extraContext: opts?.extraContext });
    },
  };
}

async function sendVerdict(
  kind: 'review_verdict' | 'qa_verdict',
  ticket: TicketId,
  body: string,
  refs: string[] = [],
): Promise<void> {
  const from = (kind === 'review_verdict' ? 'reviewer-0001' : 'qa-0001') as AgentId;
  const engineerId = agentIdFor('engineer', ticket);
  const result = await bus.send({
    id: ulid(),
    ts: new Date().toISOString(),
    from,
    to: [engineerId],
    kind,
    priority: 'normal',
    ticket,
    body,
    refs,
    requires_ack: false,
  });
  if (!result.ok) throw new Error(`sendVerdict: ${result.reason}`);
}

describe('advanceEngineerVerdicts', () => {
  test('re-prompts the live engineer with a request_changes verdict (ticket back in_progress), once, and acks it', async () => {
    // The first live run (2026-09-10): after `review_request` the engineer's
    // turn ends; a rework verdict landed in its inbox and nothing ever
    // prompted it again, so it sat idle until the liveness sweep reaped it.
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'in_progress' }));
    const engineerId = agentIdFor('engineer', 'TKT-0001' as TicketId);
    await sendVerdict(
      'review_verdict',
      'TKT-0001' as TicketId,
      'round 1: request_changes (2 finding(s))',
      ['board/reviews/TKT-0001-r1.yaml'],
    );
    const runner = fakeEngineerRunner([engineerId]);
    const seen = new Set<string>();

    expect(await advanceEngineerVerdicts(store, bus, runner, seen)).toEqual(['TKT-0001']);
    expect(runner.prompted).toHaveLength(1);
    expect(runner.prompted[0]?.agentId).toBe(engineerId);
    expect(runner.prompted[0]?.text).toContain('request_changes');
    expect(runner.prompted[0]?.text).toContain('board/reviews/TKT-0001-r1.yaml');
    expect(runner.prompted[0]?.text).toContain('review_request');
    expect(runner.spawned).toHaveLength(0);
    expect(bus.poll(engineerId)).toHaveLength(0); // acked

    expect(await advanceEngineerVerdicts(store, bus, runner, seen)).toEqual([]);
    expect(runner.prompted).toHaveLength(1);
  });

  test('spawns a fresh engineer carrying the verdict as handoff context when the session is gone', async () => {
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));
    await sendVerdict('qa_verdict', 'TKT-0002' as TicketId, 'round 1: FAIL 1/3 criteria');
    const runner = fakeEngineerRunner(); // nothing live
    const seen = new Set<string>();

    expect(await advanceEngineerVerdicts(store, bus, runner, seen)).toEqual(['TKT-0002']);
    expect(runner.prompted).toHaveLength(0);
    expect(runner.spawned).toHaveLength(1);
    expect(runner.spawned[0]?.ticket).toBe('TKT-0002');
    expect(runner.spawned[0]?.extraContext).toContain('QA verdict on TKT-0002');
  });

  test('acks a non-rework verdict (ticket moved on to in_qa) without prompting', async () => {
    await store.putTicket(makeTicket('TKT-0003' as TicketId, { status: 'in_qa' }));
    const engineerId = agentIdFor('engineer', 'TKT-0003' as TicketId);
    await sendVerdict('review_verdict', 'TKT-0003' as TicketId, 'round 1: approve (0 finding(s))');
    const runner = fakeEngineerRunner([engineerId]);

    expect(await advanceEngineerVerdicts(store, bus, runner, new Set())).toEqual([]);
    expect(runner.prompted).toHaveLength(0);
    expect(runner.spawned).toHaveLength(0);
    expect(bus.poll(engineerId)).toHaveLength(0);
  });

  test('a prompt that throws leaves the verdict unread so the next tick retries', async () => {
    await store.putTicket(makeTicket('TKT-0004' as TicketId, { status: 'in_progress' }));
    const engineerId = agentIdFor('engineer', 'TKT-0004' as TicketId);
    await sendVerdict(
      'review_verdict',
      'TKT-0004' as TicketId,
      'round 1: request_changes (1 finding(s))',
    );
    const runner = fakeEngineerRunner([engineerId]);
    runner.promptAgent = async () => {
      throw new Error('session died');
    };
    const seen = new Set<string>();

    expect(await advanceEngineerVerdicts(store, bus, runner, seen)).toEqual([]);
    expect(seen.size).toBe(0);
    expect(bus.poll(engineerId)).toHaveLength(1);
  });
});

describe('advanceHilResolutions', () => {
  const resolved = (id: string, decision: 'approve' | 'deny', ticket = 'TKT-0001') => ({
    id,
    gate: 'unblock',
    ticket: ticket as TicketId,
    status: 'resolved' as const,
    decision,
    decided_by: 'em',
    summary: 'eng-0001 asked to run `git push origin TKT-0001`',
    fyi: { body: 'gate "unblock" approved by em (gate policy, owner: em) — ticket branch only' },
  });

  test('tells the live engineer its unblock request was approved, once', async () => {
    const engineerId = agentIdFor('engineer', 'TKT-0001' as TicketId);
    const runner = fakeReviewRunner([engineerId]);
    const seen = new Set<string>();
    const gates = { list: () => [resolved('HIL-1', 'approve')] };
    expect(await advanceHilResolutions(gates, runner, seen)).toEqual(['HIL-1']);
    expect(runner.prompted[0]?.agentId).toBe(engineerId);
    expect(runner.prompted[0]?.text).toContain('APPROVED');
    expect(runner.prompted[0]?.text).toContain('git push origin TKT-0001');
    expect(await advanceHilResolutions(gates, runner, seen)).toEqual([]);
    expect(runner.prompted).toHaveLength(1);
  });

  test('a denial carries the rationale and says not to retry', async () => {
    const engineerId = agentIdFor('engineer', 'TKT-0002' as TicketId);
    const runner = fakeReviewRunner([engineerId]);
    const gates = { list: () => [resolved('HIL-2', 'deny', 'TKT-0002')] };
    await advanceHilResolutions(gates, runner, new Set());
    expect(runner.prompted[0]?.text).toContain('DENIED');
    expect(runner.prompted[0]?.text).toContain('Do not retry');
  });

  test('pending requests, non-unblock gates, and dead engineers are left alone (dead ones are marked seen)', async () => {
    const runner = fakeReviewRunner();
    const seen = new Set<string>();
    const gates = {
      list: () => [
        { ...resolved('HIL-3', 'approve'), status: 'pending' as const },
        { ...resolved('HIL-4', 'approve'), gate: 'approve_plan' },
        resolved('HIL-5', 'approve'),
      ],
    };
    expect(await advanceHilResolutions(gates, runner, seen)).toEqual([]);
    expect(runner.prompted).toHaveLength(0);
    expect([...seen]).toEqual(['HIL-5']);
  });
});

describe('advanceArchitectInbox', () => {
  async function sendToArchitect(kind: 'discovery' | 'question', ticket: TicketId, body: string) {
    const result = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em' as AgentId,
      to: ['architect' as AgentId],
      kind,
      priority: 'normal',
      ticket,
      body,
      refs: [],
      requires_ack: false,
    });
    if (!result.ok) throw new Error(`sendToArchitect: ${result.reason}`);
  }

  test('spawns the architect with the message as handoff context when none is live, then acks', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId));
    await sendToArchitect(
      'discovery',
      'TKT-0001' as TicketId,
      'SPEC-tasks-002 clauses 1 and 2 contradict',
    );
    const spawned: Array<{ ticket: TicketId; extraContext?: string }> = [];
    const runner = {
      ...fakeReviewRunner(),
      spawn: async (_role: 'architect', ticket: TicketId, opts?: { extraContext?: string }) => {
        spawned.push({ ticket, extraContext: opts?.extraContext });
      },
    };
    const seen = new Set<string>();
    expect(await advanceArchitectInbox(bus, runner, seen)).toHaveLength(1);
    expect(spawned[0]?.ticket).toBe('TKT-0001');
    expect(spawned[0]?.extraContext).toContain('discovery from em on TKT-0001');
    expect(spawned[0]?.extraContext).toContain('contradict');
    expect(bus.poll('architect' as AgentId)).toHaveLength(0);
    expect(await advanceArchitectInbox(bus, runner, seen)).toEqual([]);
  });

  test('prompts a live architect instead of spawning a second one', async () => {
    await store.putTicket(makeTicket('TKT-0002' as TicketId));
    await sendToArchitect('question', 'TKT-0002' as TicketId, 'which clause governs?');
    const base = fakeReviewRunner(['architect' as AgentId]);
    const runner = {
      ...base,
      spawn: async () => {
        throw new Error('must not spawn');
      },
    };
    await advanceArchitectInbox(bus, runner, new Set());
    expect(base.prompted[0]?.agentId).toBe('architect');
    expect(base.prompted[0]?.text).toContain('which clause governs?');
  });
});

describe('advanceSecurityReviews', () => {
  const hardEstimate = {
    points: 5 as const,
    tier: 'hard' as const,
    reasoning: 'high' as const,
    pointed_by: 'architect',
    pointed_at: new Date().toISOString(),
  };
  async function putReview(
    ticket: TicketId,
    round: number,
    pass: 'primary' | 'security',
    verdict: 'approve' | 'request_changes',
    agent: string,
  ) {
    await store.putEntity(reviewRecordRelPath(ticket, round, pass), validateReviewRecord, {
      ticket,
      round,
      pass,
      agent,
      ts: new Date().toISOString(),
      findings: [],
      verdict,
      hunks: [],
    });
  }
  function fakeSecurityRunner(live: AgentId[] = []) {
    const spawned: Array<{ ticket: TicketId; agentId?: AgentId; extraContext?: string }> = [];
    return {
      spawned,
      isLive: (id: AgentId) => live.includes(id),
      spawn: async (
        _role: 'reviewer',
        ticket: TicketId,
        opts?: { agentId?: AgentId; extraContext?: string },
      ) => {
        spawned.push({ ticket, agentId: opts?.agentId, extraContext: opts?.extraContext });
      },
    };
  }

  test('a hard ticket with a primary approve and no security record spawns reviewer-sec-<digits>, once', async () => {
    await store.putTicket(
      makeTicket('TKT-0001' as TicketId, { status: 'in_review', estimate: hardEstimate }),
    );
    await putReview('TKT-0001' as TicketId, 1, 'primary', 'approve', 'reviewer-0001');
    const runner = fakeSecurityRunner();
    const seen = new Set<string>();
    expect(await advanceSecurityReviews(store, runner, seen)).toEqual(['TKT-0001']);
    expect(runner.spawned[0]?.agentId).toBe('reviewer-sec-0001');
    expect(runner.spawned[0]?.extraContext).toContain(
      'SECURITY-pass reviewer for TKT-0001 (round 1)',
    );
    expect(runner.spawned[0]?.extraContext).toContain('pass: "security"');
    expect(await advanceSecurityReviews(store, runner, seen)).toEqual([]);
    expect(runner.spawned).toHaveLength(1);
  });

  test('no spawn when the ticket needs no security pass, the primary did not approve, or the security record already exists', async () => {
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_review' }));
    await putReview('TKT-0002' as TicketId, 1, 'primary', 'approve', 'reviewer-0002');
    await store.putTicket(
      makeTicket('TKT-0003' as TicketId, { status: 'in_review', estimate: hardEstimate }),
    );
    await putReview('TKT-0003' as TicketId, 1, 'primary', 'request_changes', 'reviewer-0003');
    await store.putTicket(
      makeTicket('TKT-0004' as TicketId, { status: 'in_review', security: true }),
    );
    await putReview('TKT-0004' as TicketId, 1, 'primary', 'approve', 'reviewer-0004');
    await putReview('TKT-0004' as TicketId, 1, 'security', 'approve', 'reviewer-sec-0004');
    const runner = fakeSecurityRunner();
    expect(await advanceSecurityReviews(store, runner, new Set())).toEqual([]);
    expect(runner.spawned).toHaveLength(0);
  });
});

describe('advanceReviewRequests', () => {
  test('starts review for every unread review_request and acks it, exactly once', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId));
    const reviewerId = agentIdFor('reviewer', 'TKT-0001' as TicketId);
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'eng-0001' as AgentId,
      to: [reviewerId],
      kind: 'review_request',
      priority: 'normal',
      ticket: 'TKT-0001' as TicketId,
      body: 'ready for review',
      refs: [],
      requires_ack: false,
    });

    const started: TicketId[] = [];
    const reviewer: ReviewStarter = {
      start: async (ticket) => {
        started.push(ticket);
      },
    };
    const seen = new Set<string>();
    const runner = fakeReviewRunner(); // nothing live — every request must spawn.

    const first = await advanceReviewRequests(store, bus, reviewer, runner, seen);
    expect(first).toEqual(['TKT-0001']);
    expect(started).toEqual(['TKT-0001']);
    expect(bus.poll(reviewerId)).toHaveLength(0); // acked

    // A second poll with nothing new in the inbox starts nothing again.
    const second = await advanceReviewRequests(store, bus, reviewer, runner, seen);
    expect(second).toEqual([]);
    expect(started).toEqual(['TKT-0001']);
  });

  test('re-prompts a live reviewer session for a second review_request instead of re-spawning it', async () => {
    // T021 round 3 (opus review round 2 blocker 2): a re-review after
    // `request_changes` sends a second `review_request` to the *same*
    // reviewer agent id (`agentIdFor`'s one-id-per-(role,ticket)
    // convention) — `ReviewProtocol.start`'s `Runner.spawn` would throw
    // "already running" for it since nothing ever tells that session to
    // exit between rounds, so this must not call `reviewer.start` a
    // second time. Round 2 stopped there (only replicated `start`'s
    // ticket-transition side effect); round 3 also delivers the request
    // to the live session via `runner.promptAgent` — a session is
    // otherwise only ever prompted once, at spawn, so skipping `start`
    // alone would silently strand a live re-review with no way to answer.
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));
    const reviewerId = agentIdFor('reviewer', 'TKT-0002' as TicketId);
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'eng-0002' as AgentId,
      to: [reviewerId],
      kind: 'review_request',
      priority: 'normal',
      ticket: 'TKT-0002' as TicketId,
      body: 'fixed, ready for round 2',
      refs: [],
      requires_ack: false,
    });

    const started: TicketId[] = [];
    const reviewer: ReviewStarter = {
      start: async (ticket) => {
        started.push(ticket);
      },
    };
    const runner = fakeReviewRunner([reviewerId]); // the round-1 session is still live.

    const result = await advanceReviewRequests(store, bus, reviewer, runner, new Set());
    expect(result).toEqual(['TKT-0002']);
    expect(started).toEqual([]); // never re-spawned
    expect(runner.prompted).toEqual([{ agentId: reviewerId, text: 'fixed, ready for round 2' }]);
    expect(store.getTicket('TKT-0002' as TicketId).status).toBe('in_review');
    expect(bus.poll(reviewerId)).toHaveLength(0); // acked
  });

  test('a stale AgentRecord with no live runner session still spawns — liveness never comes from the durable store', async () => {
    // T021 round 3 (QA round 2 / opus review round 2 blocker 1): a round-2
    // attempt at the reuse branch checked `store.getAgent(...)` (the
    // durable `AgentRecord`) instead of the runner's own in-process map.
    // That record survives a daemon restart (`runner.ts`'s own `list()`
    // doc comment) — so a ticket re-assigned after a restart, with a
    // reviewer record left over from before it, would have its very first
    // `review_request` acked and the ticket moved to `in_review` with no
    // reviewer ever spawned. Reproduces that exact setup: an `AgentRecord`
    // on record, but the runner (a fresh process, post-"restart") reports
    // it not live.
    await store.putTicket(makeTicket('TKT-0003' as TicketId, { status: 'in_progress' }));
    const reviewerId = agentIdFor('reviewer', 'TKT-0003' as TicketId);
    await store.putAgent(reviewerId, {
      vendor: 'claude',
      model: 'claude',
      last_seen: new Date().toISOString(),
    });
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'eng-0003' as AgentId,
      to: [reviewerId],
      kind: 'review_request',
      priority: 'normal',
      ticket: 'TKT-0003' as TicketId,
      body: 'ready for review',
      refs: [],
      requires_ack: false,
    });

    const started: TicketId[] = [];
    const reviewer: ReviewStarter = {
      start: async (ticket) => {
        started.push(ticket);
      },
    };
    const runner = fakeReviewRunner(); // nothing live in this process, despite the stale record.

    const result = await advanceReviewRequests(store, bus, reviewer, runner, new Set());
    expect(result).toEqual(['TKT-0003']);
    expect(started).toEqual(['TKT-0003']); // spawned for real, not suppressed
    expect(runner.prompted).toEqual([]);
  });

  test('ignores non-review_request messages and messages with no ticket', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId));
    const reviewerId = agentIdFor('reviewer', 'TKT-0001' as TicketId);
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em' as AgentId,
      to: [reviewerId],
      kind: 'fyi',
      priority: 'normal',
      ticket: 'TKT-0001' as TicketId,
      body: 'not a review request',
      refs: [],
      requires_ack: false,
    });

    let calls = 0;
    const reviewer: ReviewStarter = {
      start: async () => {
        calls += 1;
      },
    };
    const result = await advanceReviewRequests(store, bus, reviewer, fakeReviewRunner(), new Set());
    expect(result).toEqual([]);
    expect(calls).toBe(0);
    // Non-review_request traffic is left alone (some other consumer's).
    expect(bus.poll(reviewerId)).toHaveLength(1);
  });
});

describe('advanceQaSpawns', () => {
  test('spawns qa for every in_qa ticket exactly once per process lifetime', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'in_qa' }));
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));

    const spawnCalls: TicketId[] = [];
    const runner: QaSpawner = {
      spawn: async (_role, ticket) => {
        spawnCalls.push(ticket);
      },
    };
    const seen = new Set<TicketId>();

    const first = await advanceQaSpawns(store, runner, seen);
    expect(first).toEqual(['TKT-0001']);
    expect(spawnCalls).toEqual(['TKT-0001']);

    // Re-running does not re-spawn.
    const second = await advanceQaSpawns(store, runner, seen);
    expect(second).toEqual([]);
    expect(spawnCalls).toEqual(['TKT-0001']);
  });
});

describe('advanceDoneTickets', () => {
  test('merges every done ticket exactly once, using the merge record as the durable idempotency source', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));

    const mergeCalls: TicketId[] = [];
    const statuses = new Map<TicketId, unknown>();
    const merger: DoneMerger = {
      status: (ticket) => statuses.get(ticket),
      onTicketDone: async (ticket) => {
        mergeCalls.push(ticket);
        statuses.set(ticket, { merged: true });
      },
    };
    const seen = new Set<TicketId>();

    const first = await advanceDoneTickets(store, merger, seen);
    expect(first).toEqual(['TKT-0001']);
    expect(mergeCalls).toEqual(['TKT-0001']);

    const second = await advanceDoneTickets(store, merger, seen);
    expect(second).toEqual([]);
    expect(mergeCalls).toEqual(['TKT-0001']);
  });

  test('a ticket already merged by a prior process (durable MergeRecord, empty local Set) is not re-merged', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    const mergeCalls: TicketId[] = [];
    const merger: DoneMerger = {
      status: () => ({ merged: true }), // durable record already exists
      onTicketDone: async (ticket) => {
        mergeCalls.push(ticket);
      },
    };
    const result = await advanceDoneTickets(store, merger, new Set());
    expect(result).toEqual([]);
    expect(mergeCalls).toEqual([]);
  });
});

describe('advanceResumes', () => {
  const agentRecord = (ticket: TicketId) => ({
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    pid: 1234,
    last_seen: '2026-09-11T00:00:00Z',
    role: 'engineer' as const,
    ticket,
  });
  async function broadcastResume(): Promise<void> {
    const result = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['broadcast'],
      kind: 'resume',
      priority: 'normal',
      body: 'halt H-1 released — decision DEC-0001 published',
      refs: ['H-1'],
      requires_ack: false,
    });
    if (!result.ok) throw new Error(`broadcastResume: ${result.reason}`);
  }

  test('re-prompts a live idle agent once with the resume, and acks it', async () => {
    const eng = agentIdFor('engineer', 'TKT-0001' as TicketId);
    await store.putAgent(eng, agentRecord('TKT-0001' as TicketId));
    await broadcastResume();
    const runner = fakeEngineerRunner([eng]);
    const seen = new Set<string>();
    expect(await advanceResumes(store, bus, runner, seen)).toEqual([eng]);
    expect(runner.prompted[0]?.agentId).toBe(eng);
    expect(runner.prompted[0]?.text).toContain('DEC-0001');
    expect(runner.prompted[0]?.text).toContain('TKT-0001');
    expect(bus.poll(eng)).toHaveLength(0);
    expect(await advanceResumes(store, bus, runner, seen)).toEqual([]);
    expect(runner.prompted).toHaveLength(1);
  });

  test('an agent that is no longer live just has its copy acked — assignReady re-spawns it with fresh context', async () => {
    const eng = agentIdFor('engineer', 'TKT-0002' as TicketId);
    await store.putAgent(eng, agentRecord('TKT-0002' as TicketId));
    await broadcastResume();
    const runner = fakeEngineerRunner();
    expect(await advanceResumes(store, bus, runner, new Set())).toEqual([]);
    expect(runner.prompted).toHaveLength(0);
    expect(bus.poll(eng)).toHaveLength(0);
  });
});

describe('advanceMergeConflicts', () => {
  const conflictRecord = {
    status: 'conflict',
    summary: 'rebase conflict onto integration: src/tasks.test.ts (also touched by TKT-0002)',
  };

  test('prompts the live engineer once with the conflict, then retries the merge when the branch is rebased', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'done' }));
    const runner = fakeEngineerRunner([agentIdFor('engineer', 'TKT-0001' as TicketId)]);
    let resolved = false;
    const retried: TicketId[] = [];
    const merger = {
      status: (t: TicketId) => (t === 'TKT-0001' ? conflictRecord : { status: 'merged' }),
      conflictResolved: (t: TicketId) => t === 'TKT-0001' && resolved,
      retryAfterConflict: async (t: TicketId) => {
        retried.push(t);
      },
    };
    const prompted = new Set<TicketId>();
    expect(await advanceMergeConflicts(store, runner, merger, prompted)).toEqual([]);
    expect(runner.prompted).toHaveLength(1);
    expect(runner.prompted[0]?.text).toContain('src/tasks.test.ts');
    expect(runner.prompted[0]?.text).toContain('git rebase integration');
    expect(runner.spawned).toHaveLength(0);
    // Second tick, still unresolved: no second prompt.
    expect(await advanceMergeConflicts(store, runner, merger, prompted)).toEqual([]);
    expect(runner.prompted).toHaveLength(1);
    // Engineer rebased: the merge is retried and the ticket can be prompted again on a fresh conflict.
    resolved = true;
    expect(await advanceMergeConflicts(store, runner, merger, prompted)).toEqual(['TKT-0001']);
    expect(retried).toEqual(['TKT-0001']);
    expect(prompted.has('TKT-0001' as TicketId)).toBe(false);
  });

  test('spawns the engineer with the conflict as handoff context when its session is gone', async () => {
    await store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    const runner = fakeEngineerRunner();
    const merger = {
      status: () => conflictRecord,
      conflictResolved: () => false,
      retryAfterConflict: async () => {},
    };
    await advanceMergeConflicts(store, runner, merger, new Set());
    expect(runner.spawned).toHaveLength(1);
    expect(runner.spawned[0]?.ticket).toBe('TKT-0001');
    expect(runner.spawned[0]?.extraContext).toContain('could not be merged');
  });
});

describe('advanceReviewerEscalations', () => {
  async function sendEscalate(ticket: TicketId, body: string, refs: string[] = []) {
    const result = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: agentIdFor('reviewer', ticket),
      to: ['em'],
      kind: 'escalate',
      priority: 'normal',
      ticket,
      body,
      refs,
      requires_ack: false,
    });
    if (!result.ok) throw new Error(`sendEscalate: ${result.reason}`);
  }

  test("a reviewer's escalate stales the in_review ticket and forwards it to the architect with the record", async () => {
    // Fifth live run (2026-09-10): reviewer-1003 escalated round 1 (its
    // spec had been superseded by DEC-1002); the message sat in em's inbox,
    // the reviewer idled, and the architect was never asked.
    await store.putTicket(makeTicket('TKT-1003' as TicketId, { status: 'in_review' }));
    await sendEscalate(
      'TKT-1003' as TicketId,
      'reviewer escalates round 1: ticket/contract issue',
      ['board/reviews/TKT-1003-r1.yaml'],
    );
    const seen = new Set<string>();

    expect(await advanceReviewerEscalations(store, bus, seen)).toEqual(['TKT-1003']);
    const ticket = store.getTicket('TKT-1003' as TicketId);
    expect(ticket.status).toBe('stale');
    expect(ticket.history.at(-1)).toContain('reviewer escalation by reviewer-1003');

    const architectInbox = bus.poll('architect' as AgentId);
    expect(architectInbox).toHaveLength(1);
    expect(architectInbox[0]?.kind).toBe('escalate');
    expect(architectInbox[0]?.from).toBe('em');
    expect(architectInbox[0]?.ticket).toBe('TKT-1003');
    expect(architectInbox[0]?.refs).toEqual(['board/reviews/TKT-1003-r1.yaml']);
    expect(architectInbox[0]?.body).toContain('ticket_refine TKT-1003');
    expect(bus.poll('em' as AgentId).filter((m) => m.kind === 'escalate')).toHaveLength(0);

    // Idempotent: nothing left to route.
    expect(await advanceReviewerEscalations(store, bus, seen)).toEqual([]);
    expect(bus.poll('architect' as AgentId)).toHaveLength(1);
  });

  test('escalates from other senders, or on a ticket no longer in_review, are left to em', async () => {
    await store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));
    await sendEscalate('TKT-0002' as TicketId, 'late escalate');
    const daemonNote = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'daemon',
      to: ['em'],
      kind: 'escalate',
      priority: 'urgent',
      ticket: 'TKT-0002',
      body: 'eng-0002 (engineer) session ended: process exited (code 0)',
      refs: [],
      requires_ack: true,
    });
    expect(daemonNote.ok).toBe(true);
    const seen = new Set<string>();

    expect(await advanceReviewerEscalations(store, bus, seen)).toEqual([]);
    expect(store.getTicket('TKT-0002' as TicketId).status).toBe('in_progress');
    expect(bus.poll('architect' as AgentId)).toHaveLength(0);
    // The reviewer's stale copy is acked (nothing to route); the daemon's
    // own notice stays for em's loop.
    const remaining = bus.poll('em' as AgentId).filter((m) => m.kind === 'escalate');
    expect(remaining.map((m) => m.from)).toEqual(['daemon']);
  });
});

describe('releaseStaleTicketSessions', () => {
  test('stops every live session on a stale ticket, once, and leaves other tickets alone', () => {
    // The ripple path: a live engineer on a ticket the ripple just staled
    // makes `Runner.spawn` throw "already running" forever once the ticket
    // is readied again.
    const stale = makeTicket('TKT-0001' as TicketId, { status: 'stale' });
    const active = makeTicket('TKT-0002' as TicketId, { status: 'in_progress' });
    // Re-refined before the glue saw it stale (seventh live run): the old
    // engineer session must go too, or `assignReady` never re-spawns.
    const readied = makeTicket('TKT-0003' as TicketId, { status: 'ready' });
    const live = new Set<AgentId>([
      agentIdFor('engineer', stale.id),
      agentIdFor('reviewer', stale.id),
      securityReviewerIdFor(stale.id),
      agentIdFor('engineer', active.id),
      agentIdFor('engineer', readied.id),
    ]);
    const stopped: AgentId[] = [];
    const runner = {
      isLive: (id: AgentId) => live.has(id),
      stop: (id: AgentId) => {
        stopped.push(id);
        live.delete(id);
        return true;
      },
    };
    const fakeStore = { listTickets: () => [stale, active, readied] };

    expect(releaseStaleTicketSessions(fakeStore, runner)).toEqual([
      'eng-0001',
      'reviewer-0001',
      'reviewer-sec-0001',
      'eng-0003',
    ]);
    expect(live.has(agentIdFor('engineer', active.id))).toBe(true);
    expect(releaseStaleTicketSessions(fakeStore, runner)).toEqual([]);
  });
});

describe('dispatchTurn', () => {
  test('returns once the turn is accepted, not when the model finishes it', async () => {
    // Sixth live run (2026-09-10): every glue re-prompt awaited the whole
    // model turn, freezing the driver loop for minutes per hand-off.
    let finish: (() => void) | undefined;
    const runner = {
      promptAgent: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    const started = Date.now();
    await dispatchTurn(runner, 'eng-0001' as AgentId, 'go', 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(finish).toBeDefined();
    finish?.();
  });

  test('an immediate rejection (session gone) still throws so the caller retries next tick', async () => {
    const runner = {
      promptAgent: async () => {
        throw new Error('not live');
      },
    };
    await expect(dispatchTurn(runner, 'eng-0001' as AgentId, 'go', 50)).rejects.toThrow('not live');
  });

  test('a turn that fails after acceptance is swallowed (the session recovers itself)', async () => {
    let fail: ((err: Error) => void) | undefined;
    const runner = {
      promptAgent: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    };
    await dispatchTurn(runner, 'eng-0001' as AgentId, 'go', 20);
    fail?.(new Error('turn died later'));
    await new Promise((r) => setTimeout(r, 10));
  });
});
