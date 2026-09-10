import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Ticket, TicketId } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  type DoneMerger,
  type QaSpawner,
  type ReviewRunner,
  type ReviewStarter,
  advanceDoneTickets,
  advanceEngineerVerdicts,
  advanceQaSpawns,
  advanceReviewRequests,
} from './pipeline-glue';
import { agentIdFor } from './runner';

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
