import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GateDecision } from '../gates';
import { GateService } from '../gates';
import { SprintNotDoneError, sprintReview } from './review';
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

describe('sprintReview', () => {
  test('throws if any ticket in the sprint is not done', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'in_progress' }));
    const sprint = makeSprint('S-1', { tickets: ['TKT-0001'] as never });
    await fx.store.putSprint(sprint);
    const gateService = new GateService(fx.store);

    let merged = false;
    await expect(
      sprintReview(fx.store, gateService, sprint, {
        mergeIntegrationToMain: () => {
          merged = true;
        },
      }),
    ).rejects.toBeInstanceOf(SprintNotDoneError);
    expect(merged).toBe(false);
  });

  test('delegated (em/architect, approved): calls the merge callback and plans the next layer', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'em' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store, { delegate: approveDelegate });
    let merged = false;
    const result = await sprintReview(fx.store, gateService, sprint, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(true);
    expect(result.outcome).toBe('delegated');
    expect(result.nextSprint?.id).toBe('S-2');
    expect(result.nextSprint?.tickets).toEqual(['TKT-0002']);

    const reloadedSprint = fx.store.getSprint('S-1' as never);
    expect(reloadedSprint.review_at).toBeDefined();
  });

  test('human-owned: opens a pending demo hil_request and pre-plans without writing a sprint', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    await fx.store.putTicket(makeTicket('TKT-0002', { depends: ['TKT-0001'] as never }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'human' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store);
    let merged = false;
    const result = await sprintReview(fx.store, gateService, sprint, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(false);
    expect(result.outcome).toBe('human');
    expect(result.hilRequest.hil_kind).toBe('demo');
    expect(result.hilRequest.status).toBe('pending');
    expect(result.preplannedFrontier).toEqual(['TKT-0002']);
    expect(fx.store.listSprints()).toHaveLength(1); // no S-2 written yet
  });

  test('a denied delegated gate merges nothing and plans nothing', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001', { status: 'done' }));
    const sprint = makeSprint('S-1', {
      tickets: ['TKT-0001'] as never,
      gates: { sprint_review: 'em' },
    });
    await fx.store.putSprint(sprint);

    const gateService = new GateService(fx.store, { delegate: denyDelegate });
    let merged = false;
    const result = await sprintReview(fx.store, gateService, sprint, {
      mergeIntegrationToMain: () => {
        merged = true;
      },
    });

    expect(merged).toBe(false);
    expect(result.outcome).toBe('denied');
    expect(result.nextSprint).toBeUndefined();
  });
});
