import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ulid } from '@agile-agents/shared';
import { Bus } from '../bus';
import { triageDiscoveries } from './discovery';
import { type Fixture, makeFixture } from './test-helpers';

let fx: Fixture;
let bus: Bus;
let now: number;

beforeEach(() => {
  fx = makeFixture();
  now = new Date('2026-01-01T00:00:00Z').getTime();
  bus = new Bus(fx.store, fx.stateRoot, { now: () => new Date(now) });
});

afterEach(() => {
  fx.cleanup();
});

describe('triageDiscoveries', () => {
  test("forwards a discovery message from em's inbox to architect, and acks it", async () => {
    const sent = await bus.send({
      id: ulid(now),
      ts: new Date(now).toISOString(),
      from: 'eng-1',
      to: ['em'],
      kind: 'discovery',
      priority: 'normal',
      ticket: 'TKT-0001',
      body: 'scoped ripple into SPEC-auth-003',
      refs: [],
      requires_ack: false,
    });
    expect(sent.ok).toBe(true);

    const result = await triageDiscoveries(fx.store, bus, [], new Set(), () => new Date(now));
    expect(result.forwardedMessageIds).toEqual([sent.ok ? sent.message.id : '']);

    const architectInbox = bus.poll('architect');
    expect(architectInbox).toHaveLength(1);
    expect(architectInbox[0]?.kind).toBe('discovery');
    expect(architectInbox[0]?.body).toContain('scoped ripple');
    expect(architectInbox[0]?.ticket).toBe('TKT-0001');

    expect(bus.poll('em')).toHaveLength(0);
  });

  test("ignores non-discovery messages in em's inbox", async () => {
    await bus.send({
      id: ulid(now),
      ts: new Date(now).toISOString(),
      from: 'eng-1',
      to: ['em'],
      kind: 'question',
      priority: 'normal',
      body: 'need an answer',
      refs: [],
      requires_ack: false,
    });

    const result = await triageDiscoveries(fx.store, bus, [], new Set(), () => new Date(now));
    expect(result.forwardedMessageIds).toEqual([]);
    expect(bus.poll('em')).toHaveLength(1); // untouched
    expect(bus.poll('architect')).toHaveLength(0);
  });

  test('forwards an unseen discovery board stanza on a sprint ticket, and never re-forwards it', async () => {
    await fx.store.putTicket({
      id: 'TKT-0001',
      title: 't',
      status: 'in_progress',
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      history: [],
      security: false,
    } as never);
    await fx.store.appendStanza({
      ts: new Date(now).toISOString(),
      ticket: 'TKT-0001',
      agent: 'eng-1',
      kind: 'discovery',
      summary: 'found something odd',
      discovery: { tier: 'scoped', affects: [], proposed: 'split the ticket' },
    } as never);

    const seen = new Set<string>();
    const first = await triageDiscoveries(
      fx.store,
      bus,
      ['TKT-0001'] as never,
      seen,
      () => new Date(now),
    );
    expect(first.forwardedStanzaKeys).toHaveLength(1);
    expect(bus.poll('architect').some((m) => m.body.includes('split the ticket'))).toBe(true);

    // A second call with the same `seen` set does not re-forward.
    const second = await triageDiscoveries(
      fx.store,
      bus,
      ['TKT-0001'] as never,
      seen,
      () => new Date(now),
    );
    expect(second.forwardedStanzaKeys).toHaveLength(0);
    expect(bus.poll('architect')).toHaveLength(1);
  });
});
