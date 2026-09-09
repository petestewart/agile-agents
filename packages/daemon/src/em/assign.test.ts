import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TicketId } from '@agile-agents/shared';
import { Bus } from '../bus';
import { assignReady, defaultRoute } from './assign';
import { type Fixture, fakeRunner, makeFixture, makeSprint, makeTicket } from './test-helpers';

let fx: Fixture;
let bus: Bus;

beforeEach(() => {
  fx = makeFixture();
  bus = new Bus(fx.store, fx.stateRoot);
});

afterEach(() => {
  fx.cleanup();
});

describe('assignReady', () => {
  test('assigns exactly the ready tickets in the sprint, sending an assign message to each', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'in_progress' }));
    await fx.store.putSprint(
      makeSprint('S-1', { tickets: ['TKT-0001', 'TKT-0002'] as TicketId[] }),
    );

    const runner = fakeRunner(fx.store);
    const sprint = fx.store.getSprint('S-1' as never);
    const assigned = await assignReady(fx.store, bus, runner, sprint);

    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.ticket).toBe('TKT-0001');
    expect(assigned[0]?.agentId).toBe('eng-0001');

    const ticket = fx.store.getTicket('TKT-0001' as TicketId);
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignee).toBe('eng-0001');

    const inbox = bus.poll('eng-0001');
    expect(inbox.some((m) => m.kind === 'assign' && m.ticket === 'TKT-0001')).toBe(true);
  });

  test('records the routed model onto ticket.routing', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putSprint(makeSprint('S-1', { tickets: ['TKT-0001'] as TicketId[] }));
    const sprint = fx.store.getSprint('S-1' as never);
    const runner = fakeRunner(fx.store);

    const route = () => ({ vendor: 'claude', model: 'claude-opus-x' });
    await assignReady(fx.store, bus, runner, sprint, { route });

    const ticket = fx.store.getTicket('TKT-0001' as TicketId);
    expect(ticket.routing?.model).toBe('claude-opus-x');
    expect(ticket.routing?.max_attempts).toBe(2);
  });

  test('the default route is the single-Claude-entry v0 stub', () => {
    expect(defaultRoute({ role: 'engineer', tier: 'standard' })).toEqual({
      vendor: 'claude',
      model: 'claude',
    });
  });

  test('skips a ticket already picked up by a live agent (idempotent against re-scans)', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putSprint(makeSprint('S-1', { tickets: ['TKT-0001'] as TicketId[] }));
    const sprint = fx.store.getSprint('S-1' as never);
    const runner = fakeRunner(fx.store);

    const first = await assignReady(fx.store, bus, runner, sprint);
    expect(first).toHaveLength(1);

    // Ticket is now in_progress, not ready -> a re-scan assigns nothing new.
    const second = await assignReady(fx.store, bus, runner, sprint);
    expect(second).toHaveLength(0);
  });
});
