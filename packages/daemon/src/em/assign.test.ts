import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TicketId } from '@agile-agents/shared';
import { Bus } from '../bus';
import { assignReady, deadSpawnBackoffMs, deadSpawnStreak, defaultRoute } from './assign';
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

  test('the default route is Claude first (T022: candidates are wired in, but Claude still wins)', () => {
    expect(defaultRoute({ role: 'engineer', tier: 'standard' })).toEqual({
      vendor: 'claude',
      model: 'claude',
    });
    expect(defaultRoute({ role: 'reviewer', tier: 'standard' })).toEqual({
      vendor: 'claude',
      model: 'claude',
    });
  });

  // T022 round 2 (N1): the routed candidate's vendor/account now survive
  // onto `ticket.routing` too, not just `model` — what `Runner.spawn`
  // actually reads to pick a provider.
  test('records the routed vendor and account onto ticket.routing', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putSprint(makeSprint('S-1', { tickets: ['TKT-0001'] as TicketId[] }));
    const sprint = fx.store.getSprint('S-1' as never);
    const runner = fakeRunner(fx.store);

    const route = () => ({ vendor: 'pi', account: 'pi-on-claude-max', model: 'claude-sonnet' });
    await assignReady(fx.store, bus, runner, sprint, { route });

    const ticket = fx.store.getTicket('TKT-0001' as TicketId);
    expect(ticket.routing?.vendor).toBe('pi');
    expect(ticket.routing?.account).toBe('pi-on-claude-max');
    expect(ticket.routing?.model).toBe('claude-sonnet');
  });

  test('backs off re-assigning a ticket whose spawns keep dying before any work (vendor rejecting prompts)', async () => {
    const dead =
      '2026-09-11 in_progress -> ready by eng-0001 — prompt failed: The turn did not finish cleanly (prompt rejected)';
    const history = [
      '2026-09-11 ready -> assigned by eng-0001',
      '2026-09-11 assigned -> in_progress by eng-0001',
      dead,
      '2026-09-11 ready -> assigned by eng-0001',
      '2026-09-11 assigned -> in_progress by eng-0001',
      dead,
    ];
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { history }));
    await fx.store.putSprint(makeSprint('S-1', { tickets: ['TKT-0001'] as TicketId[] }));
    const sprint = fx.store.getSprint('S-1' as never);
    const runner = fakeRunner(fx.store);
    expect(deadSpawnStreak({ history })).toBe(2);
    expect(deadSpawnBackoffMs(2)).toBe(30_000);

    let t = Date.parse('2026-09-11T14:00:00Z');
    const now = () => new Date(t);
    expect(await assignReady(fx.store, bus, runner, sprint, { now })).toHaveLength(0);
    t += 10_000;
    expect(await assignReady(fx.store, bus, runner, sprint, { now })).toHaveLength(0);
    t += 25_000; // past the 30 s backoff for a streak of 2
    expect(await assignReady(fx.store, bus, runner, sprint, { now })).toHaveLength(1);
  });

  test('a ticket with no dead-spawn streak is assigned at once', () => {
    expect(deadSpawnStreak({ history: ['2026-09-11 ready -> assigned by eng-0001'] })).toBe(0);
    expect(deadSpawnBackoffMs(7)).toBe(600_000);
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
