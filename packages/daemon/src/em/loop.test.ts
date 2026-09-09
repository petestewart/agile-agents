import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ulid } from '@agile-agents/shared';
import { Bus } from '../bus';
import type { GateDecision } from '../gates';
import { GateService } from '../gates';
import { QUORUM_TIMEOUT_MS, createHalt } from '../halts';
import { EmLoop, currentSprint } from './loop';
import { planSprint } from './sprint';
import { type Fixture, fakeRunner, makeFixture, makeTicket } from './test-helpers';

let fx: Fixture;
let bus: Bus;
let now: number;

function clock(): Date {
  return new Date(now);
}

beforeEach(() => {
  fx = makeFixture();
  now = new Date('2026-01-01T00:00:00Z').getTime();
  bus = new Bus(fx.store, fx.stateRoot, { now: clock });
});

afterEach(() => {
  fx.cleanup();
});

function approveDelegate(): GateDecision {
  return { decision: 'approve', by: 'em', rationale: 'automated' };
}

/** Drives a `ready` ticket straight to `done` through the legal transition edges, without spawning a real (or fake) agent — for tests where only the end state matters, not the assign/review/QA path itself (covered elsewhere). */
async function fastForwardToDone(store: Fixture['store'], ticketId: string): Promise<void> {
  await store.transitionTicket(ticketId as never, 'assigned', { by: 'em' });
  await store.transitionTicket(ticketId as never, 'in_progress', { by: 'eng-1' });
  await store.transitionTicket(ticketId as never, 'in_review', { by: 'eng-1' });
  await store.transitionTicket(ticketId as never, 'in_qa', { by: 'reviewer-1' });
  await store.transitionTicket(ticketId as never, 'done', { by: 'qa-1' });
}

function makeLoop(overrides: { mergeIntegrationToMain?: () => void } = {}) {
  const runner = fakeRunner(fx.store);
  const gateService = new GateService(fx.store, { delegate: approveDelegate, clock });
  const loop = new EmLoop({
    store: fx.store,
    bus,
    runner,
    gateService,
    now: clock,
    sprintReview: {
      mergeIntegrationToMain: overrides.mergeIntegrationToMain ?? (() => {}),
    },
  });
  return { loop, runner, gateService };
}

describe('EmLoop.tick', () => {
  test('a full sprint scenario: plan -> assign -> (engineer finishes) -> sprint review -> merge -> next layer planned, with retro persisted', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001'));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    // Repo-default policy delegates sprint_review to `human` — override for
    // this scenario so the delegated (merge-and-plan) branch is exercised.
    await fx.store.putPolicy({
      ...fx.store.getPolicy(),
      gates: { ...fx.store.getPolicy().gates, sprint_review: 'em' },
    });
    const sprint = await planSprint(fx.store, { goal: 'layer 1', cap: 1, now: clock });
    expect(sprint.tickets).toEqual(['TKT-0001']);

    let mergeCalls = 0;
    const { loop } = makeLoop({
      mergeIntegrationToMain: () => {
        mergeCalls += 1;
      },
    });

    // Tick 1: assigns TKT-0001 to an engineer.
    const first = await loop.tick();
    expect(first.assigned).toHaveLength(1);
    expect(first.assigned[0]?.ticket).toBe('TKT-0001');
    expect(first.sprintReview).toBeUndefined(); // ticket still in_progress
    expect(mergeCalls).toBe(0);

    // Engineer finishes the ticket (review/QA are out of this ticket's scope
    // — the transition to `done` is simulated directly, matching every
    // other T015 test's treatment of the engineer/reviewer/QA loop as a
    // black box), and logs one ledger line so the retro block has something
    // real to compute from.
    let ticket = fx.store.getTicket('TKT-0001');
    ticket = await fx.store.transitionTicket(ticket.id, 'in_review', {
      by: ticket.assignee ?? 'eng-1',
    });
    ticket = await fx.store.transitionTicket(ticket.id, 'in_qa', { by: 'reviewer-1' });
    await fx.store.transitionTicket(ticket.id, 'done', { by: 'qa-1' });
    await fx.store.appendLedgerLine(sprint.id, {
      ts: clock().toISOString(),
      sprint: sprint.id,
      ticket: 'TKT-0001',
      agent: 'eng-1',
      model: 'claude',
      in_tokens: 100,
      out_tokens: 50,
      cost_usd: 0.02,
      kind: 'engineer',
    });

    // Tick 2: sprint review fires (all sprint tickets done). Delegated ->
    // resolves synchronously within this same tick -> merge runs, retro is
    // persisted, and the next layer is planned.
    const second = await loop.tick();
    expect(mergeCalls).toBe(1);
    expect(second.sprintReview?.outcome).toBe('approved');
    expect(second.sprintReview?.nextSprint?.tickets).toEqual(['TKT-0002']);
    expect(second.sprintReview?.retro).toBeDefined();

    const reviewedSprint = fx.store.getSprint(sprint.id);
    expect(reviewedSprint.review_at).toBeDefined();
    expect(reviewedSprint.retro).toEqual(second.sprintReview?.retro);

    const live = currentSprint(fx.store);
    expect(live?.id).toBe(second.sprintReview?.nextSprint?.id);
  });

  test('does not re-run sprint review once a sprint has already been reviewed', async () => {
    // Review-round nit: the ticket must actually be in `sprint.tickets` (not
    // just pre-seeded `done`, which `computeFrontier` would never pick up —
    // only `ready` tickets qualify) so this test isolates the `review_at`
    // guard itself, not `tick()`'s separate `tickets.length > 0` early-out.
    await fx.store.putTicket(makeTicket('TKT-0001'));
    const sprint = await planSprint(fx.store, { goal: 'g', now: clock });
    expect(sprint.tickets).toEqual(['TKT-0001']);
    await fastForwardToDone(fx.store, 'TKT-0001');
    // Force it "reviewed" already.
    await fx.store.putSprint({
      ...fx.store.getSprint(sprint.id),
      review_at: clock().toISOString(),
    });

    let mergeCalls = 0;
    const { loop } = makeLoop({
      mergeIntegrationToMain: () => {
        mergeCalls += 1;
      },
    });

    const result = await loop.tick();
    expect(result.sprintReview).toBeUndefined();
    expect(mergeCalls).toBe(0);
  });

  test('human-owned sprint review: request -> tick (still pending) -> approve via GateService -> tick -> merged + next sprint (review-round blocker 1)', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001'));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    // Repo default is sprint_review: human already (see init.ts) — no override needed.
    const sprint = await planSprint(fx.store, { goal: 'layer 1', cap: 1, now: clock });
    await fastForwardToDone(fx.store, 'TKT-0001');

    let mergeCalls = 0;
    const { loop, gateService } = makeLoop({
      mergeIntegrationToMain: () => {
        mergeCalls += 1;
      },
    });

    // Tick 1: all tickets done -> requests sprint_review; owner is human -> pending.
    const first = await loop.tick();
    expect(first.sprintReview?.outcome).toBe('pending');
    expect(mergeCalls).toBe(0);
    expect(fx.store.getSprint(sprint.id).review_at).toBeUndefined();

    // Tick 2, before anyone answers: still pending, no re-request, no merge.
    const pendingBefore = gateService.list().filter((r) => r.status === 'pending');
    expect(pendingBefore).toHaveLength(1);
    const second = await loop.tick();
    expect(second.sprintReview?.outcome).toBe('pending');
    expect(mergeCalls).toBe(0);
    expect(gateService.list().filter((r) => r.status === 'pending')).toHaveLength(1); // no duplicate request

    // A human approves directly through the GateService (not via the loop).
    const hilId = pendingBefore[0]?.id;
    if (!hilId) throw new Error('expected a pending hil request');
    await gateService.respond(hilId, 'approve', 'human');

    // Tick 3: resolves -> merge + next layer planned.
    const third = await loop.tick();
    expect(third.sprintReview?.outcome).toBe('approved');
    expect(mergeCalls).toBe(1);
    expect(third.sprintReview?.nextSprint?.tickets).toEqual(['TKT-0002']);
    expect(fx.store.getSprint(sprint.id).review_at).toBeDefined();
  });

  test('a denied human review posts a decision message and does not merge or re-request', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001'));
    const sprint = await planSprint(fx.store, { goal: 'layer 1', now: clock });
    await fastForwardToDone(fx.store, 'TKT-0001');

    let mergeCalls = 0;
    const { loop, gateService } = makeLoop({
      mergeIntegrationToMain: () => {
        mergeCalls += 1;
      },
    });

    await loop.tick(); // requests, pending
    const pending = gateService.list().find((r) => r.status === 'pending');
    if (!pending) throw new Error('expected a pending hil request');
    await gateService.respond(pending.id, 'deny', 'human');

    const result = await loop.tick();
    expect(result.sprintReview?.outcome).toBe('denied');
    expect(mergeCalls).toBe(0);
    expect(fx.store.getSprint(sprint.id).review_at).toBeDefined();

    const inbox = bus.poll('human');
    expect(inbox.some((m) => m.kind === 'decision' && m.body.includes('denied'))).toBe(true);
  });

  test("discovery triage (review-round blocker 2): a discovery message in em's inbox is forwarded to architect", async () => {
    await fx.store.putTicket(makeTicket('TKT-0001'));
    const { loop } = makeLoop();

    const sent = await bus.send({
      id: ulid(now),
      ts: clock().toISOString(),
      from: 'eng-1',
      to: ['em'],
      kind: 'discovery',
      priority: 'normal',
      ticket: 'TKT-0001',
      body: 'found a scoped ripple into the auth spec',
      refs: [],
      requires_ack: false,
    });
    expect(sent.ok).toBe(true);

    const result = await loop.tick();
    expect(result.discoveries.forwardedMessageIds).toHaveLength(1);

    const architectInbox = bus.poll('architect');
    expect(
      architectInbox.some((m) => m.kind === 'discovery' && m.body.includes('scoped ripple')),
    ).toBe(true);
    // Drained from em's own inbox.
    expect(bus.poll('em').some((m) => m.kind === 'discovery')).toBe(false);
  });

  test('quorum timeout (review-round blocker 3): a halt reaches quorum via the 10-minute timeout even with one agent never reporting', async () => {
    await fx.store.putAgent('eng-1' as never, {
      vendor: 'claude',
      model: 'claude',
      pid: 1,
      ticket: 'TKT-0001' as never,
      last_seen: clock().toISOString(),
    });
    const halt = await createHalt(
      fx.store,
      { scope: ['TKT-0001'] as never, reason: 'oracle conflict', raised_by: 'architect' },
      () => now,
    );
    expect(halt.affected).toEqual(['eng-1']);

    const { loop } = makeLoop();

    // Tick right away: standup_call goes out, but nobody has reported —
    // quorum stays pending (well under the timeout).
    await loop.tick();
    expect(fx.store.getHalt(halt.id).quorum).toBe('pending');

    // Advance the fake clock past the 10-minute quorum timeout with eng-1
    // never reporting in.
    now += QUORUM_TIMEOUT_MS + 1000;
    await loop.tick();
    expect(fx.store.getHalt(halt.id).quorum).toBe('reached');
  });
});
