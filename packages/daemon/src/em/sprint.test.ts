import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TicketId } from '@agile-agents/shared';
import { computeFrontier, nextSprintId, planSprint } from './sprint';
import { type Fixture, makeFixture, makeSprint, makeTicket } from './test-helpers';

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('computeFrontier', () => {
  // A 6-ticket epic: TKT-0001 done; TKT-0002/0003 ready with 0001 as their
  // only dependency; TKT-0004 ready but depends on 0002 (not done yet, so
  // excluded); TKT-0005 draft (not ready, excluded even with no deps);
  // TKT-0006 ready with no deps but already claimed by a sprint.
  async function seedEpic(): Promise<void> {
    const tickets = [
      makeTicket('TKT-0001' as TicketId, { status: 'done' }),
      makeTicket('TKT-0002' as TicketId, { depends: ['TKT-0001' as TicketId] }),
      makeTicket('TKT-0003' as TicketId, { depends: ['TKT-0001' as TicketId] }),
      makeTicket('TKT-0004' as TicketId, { depends: ['TKT-0002' as TicketId] }),
      makeTicket('TKT-0005' as TicketId, { status: 'draft' }),
      makeTicket('TKT-0006' as TicketId, { sprint: 'S-1' as never }),
    ];
    for (const t of tickets) await fx.store.putTicket(t);
  }

  test('frontier is every ready ticket whose depends are all done, excluding draft and already-sprinted tickets', async () => {
    await seedEpic();
    const frontier = computeFrontier(fx.store.listTickets());
    expect(frontier.sort()).toEqual(['TKT-0002', 'TKT-0003']);
  });

  test('cap limits the frontier size, deterministically (lowest id first)', async () => {
    await seedEpic();
    const frontier = computeFrontier(fx.store.listTickets(), { cap: 1 });
    expect(frontier).toEqual(['TKT-0002']);
  });

  test('a ticket blocked/in_progress/done is never in the frontier even with satisfied deps', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    await fx.store.putTicket(
      makeTicket('TKT-0002' as TicketId, {
        status: 'in_progress',
        depends: ['TKT-0001' as TicketId],
      }),
    );
    await fx.store.putTicket(
      makeTicket('TKT-0003' as TicketId, { status: 'blocked', depends: ['TKT-0001' as TicketId] }),
    );
    expect(computeFrontier(fx.store.listTickets())).toEqual([]);
  });

  test('empty ticket list -> empty frontier', () => {
    expect(computeFrontier([])).toEqual([]);
  });
});

describe('nextSprintId', () => {
  test('S-1 when no sprints exist yet', () => {
    expect(nextSprintId(fx.store)).toBe('S-1');
  });

  test('monotonic across existing sprints', async () => {
    await fx.store.putSprint(makeSprint('S-1', { goal: 'first' }));
    await fx.store.putSprint(makeSprint('S-3', { goal: 'skip-ahead' }));
    expect(nextSprintId(fx.store)).toBe('S-4');
  });
});

describe('planSprint', () => {
  test('writes a sprint with the correct frontier, a recommended gates block, and stamps sprint onto each frontier ticket', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    await fx.store.putTicket(
      makeTicket('TKT-0002' as TicketId, { depends: ['TKT-0001' as TicketId] }),
    );
    await fx.store.putTicket(
      makeTicket('TKT-0003' as TicketId, { depends: ['TKT-0001' as TicketId] }),
    );

    const sprint = await planSprint(fx.store, { goal: 'layer one' });
    expect(sprint.id).toBe('S-1');
    expect(sprint.goal).toBe('layer one');
    expect(sprint.tickets.sort()).toEqual(['TKT-0002', 'TKT-0003']);
    expect(sprint.gates).toEqual(fx.store.getPolicy().gates);

    const t2 = fx.store.getTicket('TKT-0002' as TicketId);
    expect(t2.sprint).toBe('S-1');
  });

  test('a second planSprint call excludes tickets already claimed by the first', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    await fx.store.putTicket(makeTicket('TKT-0002' as TicketId));
    await fx.store.putTicket(makeTicket('TKT-0003' as TicketId));

    const first = await planSprint(fx.store, { cap: 1 });
    expect(first.tickets).toEqual(['TKT-0002']);

    const second = await planSprint(fx.store);
    expect(second.tickets).toEqual(['TKT-0003']);
  });

  test('cap is respected on the written sprint', async () => {
    for (const id of ['TKT-0001', 'TKT-0002', 'TKT-0003'] as TicketId[]) {
      await fx.store.putTicket(makeTicket(id));
    }
    const sprint = await planSprint(fx.store, { cap: 2 });
    expect(sprint.tickets).toHaveLength(2);
  });
});
