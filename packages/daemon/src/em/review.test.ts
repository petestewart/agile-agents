import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GateDecision } from '../gates';
import { GateService } from '../gates';
import { SprintNotDoneError, requestSprintReview, resolveSprintReview } from './review';
import { type Fixture, makeFixture, makeSprint, makeTicket } from './test-helpers';

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function approveDelegate(): GateDecision {
  return { decision: 'approve', by: 'architect', rationale: 'looks good' };
}

function denyDelegate(): GateDecision {
  return { decision: 'deny', by: 'architect', rationale: 'not yet' };
}

describe('requestSprintReview', () => {
  test('throws if any ticket in the sprint is not done', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'in_progress' }));
    const sprint = makeSprint('S-1', { tickets: ['TKT-0001'] as never });
    await fx.store.putSprint(sprint);
    const gateService = new GateService(fx.store);

    await expect(requestSprintReview(fx.store, gateService, sprint)).rejects.toBeInstanceOf(
      SprintNotDoneError,
    );
  });
});

describe('resolveSprintReview', () => {
  test('delegated + approved: calls the merge callback, plans the next layer, and persists retro', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'em' },
    });
    await fx.store.putSprint(sprint);
    await fx.store.appendLedgerLine(sprint.id, {
      ts: new Date().toISOString(),
      sprint: sprint.id,
      ticket: 'TKT-0001',
      agent: 'eng-1',
      model: 'claude',
      in_tokens: 10,
      out_tokens: 10,
      cost_usd: 0.01,
      kind: 'engineer',
    });

    const gateService = new GateService(fx.store, { delegate: approveDelegate });
    let merged = false;
    const hilRequest = await requestSprintReview(fx.store, gateService, sprint);
    expect(hilRequest.status).toBe('resolved'); // delegated gates resolve synchronously

    const result = await resolveSprintReview(fx.store, sprint, hilRequest, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(true);
    expect(result.outcome).toBe('approved');
    expect(result.nextSprint?.id).toBe('S-2');
    expect(result.nextSprint?.tickets).toEqual(['TKT-0002']);
    expect(result.retro).toBeDefined();

    const reloadedSprint = fx.store.getSprint('S-1' as never);
    expect(reloadedSprint.review_at).toBeDefined();
    expect(reloadedSprint.retro).toEqual(result.retro);
  });

  test('human-owned: stays pending, pre-plans without writing a sprint or touching review_at', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'human' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store);
    let merged = false;
    const hilRequest = await requestSprintReview(fx.store, gateService, sprint);
    expect(hilRequest.status).toBe('pending');

    const result = await resolveSprintReview(fx.store, sprint, hilRequest, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(false);
    expect(result.outcome).toBe('pending');
    expect(result.preplannedFrontier).toEqual(['TKT-0002']);
    expect(fx.store.listSprints()).toHaveLength(1); // no S-2 written yet

    const reloadedSprint = fx.store.getSprint('S-1' as never);
    expect(reloadedSprint.review_at).toBeUndefined(); // not stamped while still pending
    expect(reloadedSprint.retro).toBeUndefined();
  });

  test('pending -> approved across two resolve calls once a human answers via the GateService directly (the tick-loop shape)', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'human' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store);
    let merged = false;
    const opts = {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    };

    const hilRequest = await requestSprintReview(fx.store, gateService, sprint);
    const first = await resolveSprintReview(fx.store, sprint, hilRequest, opts);
    expect(first.outcome).toBe('pending');
    expect(merged).toBe(false);

    // Still pending on a second check before anyone answers.
    const stillPending = await resolveSprintReview(
      fx.store,
      sprint,
      gateService.get(hilRequest.id),
      opts,
    );
    expect(stillPending.outcome).toBe('pending');
    expect(merged).toBe(false);

    // A human answers directly through the GateService.
    await gateService.respond(hilRequest.id, 'approve', 'human');

    const resolved = await resolveSprintReview(
      fx.store,
      sprint,
      gateService.get(hilRequest.id),
      opts,
    );
    expect(resolved.outcome).toBe('approved');
    expect(merged).toBe(true);
    expect(resolved.nextSprint).toBeDefined();
  });

  test('a denied delegated gate merges nothing, plans nothing, but still stamps review_at + retro', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'em' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store, { delegate: denyDelegate });
    let merged = false;
    const hilRequest = await requestSprintReview(fx.store, gateService, sprint);
    const result = await resolveSprintReview(fx.store, sprint, hilRequest, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(false);
    expect(result.outcome).toBe('denied');
    expect(result.nextSprint).toBeUndefined();
    expect(result.retro).toBeDefined();

    const reloadedSprint = fx.store.getSprint('S-1' as never);
    expect(reloadedSprint.review_at).toBeDefined();
  });
});
