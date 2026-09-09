import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Bus } from '../bus';
import type { GateDecision } from '../gates';
import { GateService } from '../gates';
import { EmLoop, currentSprint } from './loop';
import { planSprint } from './sprint';
import { type Fixture, fakeRunner, makeFixture, makeTicket } from './test-helpers';

let fx: Fixture;
let bus: Bus;

beforeEach(() => {
  fx = makeFixture();
  bus = new Bus(fx.store, fx.stateRoot);
});

afterEach(() => {
  fx.cleanup();
});

function approveDelegate(): GateDecision {
  return { decision: 'approve', by: 'em', rationale: 'automated' };
}

describe('EmLoop.tick', () => {
  test('a full sprint scenario: plan -> assign -> (engineer finishes) -> sprint review -> merge -> next layer planned', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001'));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    // Repo-default policy delegates sprint_review to `human` — override for
    // this scenario so the delegated (merge-and-plan) branch is exercised.
    await fx.store.putPolicy({
      ...fx.store.getPolicy(),
      gates: { ...fx.store.getPolicy().gates, sprint_review: 'em' },
    });
    const sprint = await planSprint(fx.store, { goal: 'layer 1', cap: 1 });
    expect(sprint.tickets).toEqual(['TKT-0001']);

    const runner = fakeRunner(fx.store);
    const gateService = new GateService(fx.store, { delegate: approveDelegate });
    let mergeCalls = 0;
    const loop = new EmLoop({
      store: fx.store,
      bus,
      runner,
      gateService,
      sprintReview: {
        mergeIntegrationToMain: () => {
          mergeCalls += 1;
        },
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
    // black box).
    let ticket = fx.store.getTicket('TKT-0001');
    ticket = await fx.store.transitionTicket(ticket.id, 'in_review', {
      by: ticket.assignee ?? 'eng-1',
    });
    ticket = await fx.store.transitionTicket(ticket.id, 'in_qa', { by: 'reviewer-1' });
    await fx.store.transitionTicket(ticket.id, 'done', { by: 'qa-1' });

    // Tick 2: sprint review fires (all sprint tickets done), delegated ->
    // merge runs and the next layer is planned.
    const second = await loop.tick();
    expect(mergeCalls).toBe(1);
    expect(second.sprintReview?.outcome).toBe('delegated');
    expect(second.sprintReview?.nextSprint?.tickets).toEqual(['TKT-0002']);

    const live = currentSprint(fx.store);
    expect(live?.id).toBe(second.sprintReview?.nextSprint?.id);
  });

  test('does not re-run sprint review once a sprint has already been reviewed', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    const sprint = await planSprint(fx.store, { goal: 'g' });
    // Force it "reviewed" already.
    await fx.store.putSprint({ ...sprint, review_at: new Date().toISOString() });

    const runner = fakeRunner(fx.store);
    const gateService = new GateService(fx.store, { delegate: approveDelegate });
    let mergeCalls = 0;
    const loop = new EmLoop({
      store: fx.store,
      bus,
      runner,
      gateService,
      sprintReview: {
        mergeIntegrationToMain: () => {
          mergeCalls += 1;
        },
      },
    });

    const result = await loop.tick();
    expect(result.sprintReview).toBeUndefined();
    expect(mergeCalls).toBe(0);
  });
});
