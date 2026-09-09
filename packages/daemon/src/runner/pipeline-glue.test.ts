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
  type ReviewStarter,
  advanceDoneTickets,
  advanceQaSpawns,
  advanceReviewRequests,
} from './pipeline-glue';
import { agentIdFor } from './runner';

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

    const first = await advanceReviewRequests(store, bus, reviewer, seen);
    expect(first).toEqual(['TKT-0001']);
    expect(started).toEqual(['TKT-0001']);
    expect(bus.poll(reviewerId)).toHaveLength(0); // acked

    // A second poll with nothing new in the inbox starts nothing again.
    const second = await advanceReviewRequests(store, bus, reviewer, seen);
    expect(second).toEqual([]);
    expect(started).toEqual(['TKT-0001']);
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
    const result = await advanceReviewRequests(store, bus, reviewer, new Set());
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
