import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Message, ulid } from '@agile-agents/shared';
import { Bus } from '../bus';
import { createHalt } from '../halts';
import { handToArchitect, processStandupReports, releaseIfResolved, standupCall } from './standup';
import { type Fixture, makeFixture } from './test-helpers';

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

/**
 * Sends a `standup_report` through the real bus (`bus/routing.ts`'s
 * `ENGINEER_TO_EM_KINDS` now allows `engineer -> em standup_report` — see
 * that file's header for the §5 citation). No bypass: this goes through
 * `Bus.send`'s full validate + route-check + fan-out path, same as
 * production.
 */
async function sendStandupReport(
  message: Omit<Message, 'id' | 'ts'> & { id?: string; ts?: string },
): Promise<Message> {
  const input = { id: ulid(now), ts: new Date(now).toISOString(), ...message };
  const result = await bus.send(input);
  if (!result.ok) throw new Error(`sendStandupReport: ${result.reason}`);
  return result.message;
}

async function registerAgent(agent: string, ticket?: string): Promise<void> {
  await fx.store.putAgent(agent as never, {
    vendor: 'claude',
    model: 'claude',
    pid: 1,
    ticket: ticket as never,
    last_seen: clock().toISOString(),
  });
}

describe('standupCall', () => {
  test('sends an urgent standup_call to every affected agent, and no one else', async () => {
    await registerAgent('eng-1', 'TKT-0001');
    await registerAgent('eng-2', 'TKT-0002');
    const halt = await createHalt(
      fx.store,
      { scope: ['TKT-0001'] as never, reason: 'oracle conflict', raised_by: 'architect' },
      () => now,
    );
    expect(halt.affected).toEqual(['eng-1']);

    await standupCall(bus, halt, clock);

    const inbox1 = bus.poll('eng-1' as never);
    expect(inbox1.some((m) => m.kind === 'standup_call' && m.priority === 'urgent')).toBe(true);
    const inbox2 = bus.poll('eng-2' as never);
    expect(inbox2.some((m) => m.kind === 'standup_call')).toBe(false);
  });

  test('a no-op when the halt has no affected agents', async () => {
    const halt = await createHalt(
      fx.store,
      { scope: 'global', reason: 'nobody registered yet', raised_by: 'architect' },
      () => now,
    );
    expect(halt.affected).toEqual([]);
    await standupCall(bus, halt, clock); // should not throw
  });
});

describe('processStandupReports + quorum', () => {
  test('folds standup_report messages (correlated via refs) into the halt and reaches quorum once every affected agent reports', async () => {
    await registerAgent('eng-1', 'TKT-0001');
    await registerAgent('eng-2', 'TKT-0002');
    const halt = await createHalt(
      fx.store,
      { scope: ['TKT-0001', 'TKT-0002'] as never, reason: 'global-ish', raised_by: 'architect' },
      () => now,
    );
    await standupCall(bus, halt, clock);

    // eng-1 reports in, naming the halt via refs.
    await sendStandupReport({
      from: 'eng-1',
      to: ['em'],
      kind: 'standup_report',
      priority: 'normal',
      body: 'stashed WIP',
      refs: [halt.id],
      requires_ack: false,
    });

    let processed = await processStandupReports(fx.store, bus, () => now);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.agent).toBe('eng-1');
    let reloaded = fx.store.getHalt(halt.id);
    expect(reloaded.quorum).toBe('pending');
    // Acked, not left in the inbox.
    expect(bus.poll('em' as never).some((m) => m.kind === 'standup_report')).toBe(false);

    // eng-2 reports in too -> quorum reached.
    await sendStandupReport({
      from: 'eng-2',
      to: ['em'],
      kind: 'standup_report',
      priority: 'normal',
      body: 'stashed WIP',
      refs: [halt.id],
      requires_ack: false,
    });
    processed = await processStandupReports(fx.store, bus, () => now);
    expect(processed).toHaveLength(1);
    reloaded = fx.store.getHalt(halt.id);
    expect(reloaded.quorum).toBe('reached');
  });

  test('a standup_report with no recognizable halt id in refs is left unacked, not guessed at', async () => {
    await sendStandupReport({
      from: 'eng-1',
      to: ['em'],
      kind: 'standup_report',
      priority: 'normal',
      body: 'no halt named',
      refs: [],
      requires_ack: false,
    });
    const processed = await processStandupReports(fx.store, bus, () => now);
    expect(processed).toHaveLength(0);
    expect(bus.poll('em' as never).some((m) => m.kind === 'standup_report')).toBe(true);
  });
});

describe('handToArchitect', () => {
  test('sends an urgent escalate to architect naming the halt', async () => {
    const halt = await createHalt(
      fx.store,
      { scope: 'global', reason: 'needs a call', raised_by: 'architect' },
      () => now,
    );
    await handToArchitect(bus, halt, clock);
    const inbox = bus.poll('architect' as never);
    expect(inbox.some((m) => m.kind === 'escalate' && m.refs.includes(halt.id))).toBe(true);
  });
});

describe('releaseIfResolved', () => {
  test('releases the halt and broadcasts resume once quorum is reached AND the resolving decision is published', async () => {
    await registerAgent('eng-1', 'TKT-0001');
    const halt = await createHalt(
      fx.store,
      {
        scope: ['TKT-0001'] as never,
        reason: 'oracle conflict',
        raised_by: 'architect',
        resolves_when: 'DEC-0001' as never,
      },
      () => now,
    );

    // Quorum not reached yet, and no decision published -> no-op.
    expect(await releaseIfResolved(fx.store, bus, halt, clock)).toBe(false);

    await sendStandupReport({
      from: 'eng-1',
      to: ['em'],
      kind: 'standup_report',
      priority: 'normal',
      body: 'wip stashed',
      refs: [halt.id],
      requires_ack: false,
    });
    await processStandupReports(fx.store, bus, () => now);
    let reloaded = fx.store.getHalt(halt.id);
    expect(reloaded.quorum).toBe('reached');

    // Quorum reached but no decision yet -> still a no-op.
    expect(await releaseIfResolved(fx.store, bus, reloaded, clock)).toBe(false);

    // Architect publishes the decision.
    await fx.store.putOracleEntry(
      {
        id: 'DEC-0001' as never,
        title: 'resolved',
        status: 'active',
        supersedes: [],
        depends: [],
        affects: [],
        decided: '2026-01-01',
        by: 'architect',
        rationale: 'because',
      },
      'The decision body.',
    );

    reloaded = fx.store.getHalt(halt.id);
    expect(await releaseIfResolved(fx.store, bus, reloaded, clock)).toBe(true);
    expect(() => fx.store.getHalt(halt.id)).toThrow();

    // Sender ('em') is excluded from its own broadcast fan-out (bus.ts's
    // resolveRecipients) — check a different registered agent.
    const broadcastInbox = bus.poll('eng-1' as never);
    expect(broadcastInbox.some((m) => m.kind === 'resume')).toBe(true);
  });
});
