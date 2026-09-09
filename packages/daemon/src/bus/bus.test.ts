import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ticket } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { Bus } from './bus';

let repo: string;
let stateRoot: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-bus-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'draft',
    contract: {},
    history: [],
    ...overrides,
  });
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: ulid(),
    ts: new Date().toISOString(),
    from: 'eng-1',
    to: ['em'],
    kind: 'question',
    priority: 'normal',
    body: 'hello',
    ...overrides,
  };
}

describe('Bus.send — routing enforcement', () => {
  test('accepts a legal route and files the message in the recipient inbox', async () => {
    const bus = new Bus(store, stateRoot);
    const result = await bus.send(baseMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.recipients).toEqual(['em']);
    const inbox = bus.poll('em');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe('hello');
  });

  test('rejects a disallowed route with a reason, and writes nothing', async () => {
    const bus = new Bus(store, stateRoot);
    const result = await bus.send(baseMessage({ from: 'eng-1', to: ['eng-2'], kind: 'question' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/engineers never message each other/);
    expect(bus.poll('eng-2')).toHaveLength(0);
  });

  test('rejects a message over the body cap, and writes nothing', async () => {
    const bus = new Bus(store, stateRoot);
    const result = await bus.send(baseMessage({ body: 'x'.repeat(801) }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/exceeds the 800-char cap/);
    expect(bus.poll('em')).toHaveLength(0);
  });

  test('every delivered message mints a `message` event', async () => {
    const bus = new Bus(store, stateRoot);
    await bus.send(baseMessage());
    const events = store.listEvents().filter((e) => e.kind === 'message');
    expect(events).toHaveLength(1);
    expect(events[0]?.agent).toBe('eng-1');
  });

  test('a `to: ticket:<id>` message fans out to the assignee and every agent registered on the ticket', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'in_progress', assignee: 'eng-1' }));
    await store.putAgent('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      ticket: 'TKT-0001',
      pid: 1,
      last_seen: new Date().toISOString(),
    });
    await store.putAgent('reviewer-1', {
      vendor: 'claude',
      model: 'sonnet',
      ticket: 'TKT-0001',
      pid: 2,
      last_seen: new Date().toISOString(),
    });

    const bus = new Bus(store, stateRoot);
    const result = await bus.send(
      baseMessage({
        from: 'architect',
        to: ['ticket:TKT-0001'],
        kind: 'decision',
        ticket: 'TKT-0001',
        body: 'decided',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(new Set(result.recipients)).toEqual(new Set(['eng-1', 'reviewer-1']));
    expect(bus.poll('eng-1')).toHaveLength(1);
    expect(bus.poll('reviewer-1')).toHaveLength(1);
  });

  test('a broadcast (halt) fans out to every registered agent except the sender', async () => {
    await store.putAgent('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      pid: 1,
      last_seen: new Date().toISOString(),
    });
    await store.putAgent('reviewer-1', {
      vendor: 'claude',
      model: 'sonnet',
      pid: 2,
      last_seen: new Date().toISOString(),
    });

    const bus = new Bus(store, stateRoot);
    const result = await bus.send(
      baseMessage({ from: 'architect', to: ['broadcast'], kind: 'halt', body: 'stop' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(new Set(result.recipients)).toEqual(new Set(['eng-1', 'reviewer-1']));
  });

  test('broadcast is rejected for a kind other than halt/resume', async () => {
    const bus = new Bus(store, stateRoot);
    const result = await bus.send(
      baseMessage({ from: 'architect', to: ['broadcast'], kind: 'fyi' }),
    );
    expect(result.ok).toBe(false);
  });

  test('a message that names a ticket is also filed under bus/threads/<ticket>/', async () => {
    const bus = new Bus(store, stateRoot);
    const message = baseMessage({
      from: 'eng-1',
      to: ['em'],
      kind: 'discovery',
      ticket: 'TKT-0001',
    });
    await bus.send(message);
    const thread = store.getEntity(
      join('bus', 'threads', 'TKT-0001', `${(message as { id: string }).id}.yaml`),
      (x) => x,
    );
    expect(thread).toBeTruthy();
  });
});

describe('Bus.poll', () => {
  test('orders unread messages urgent > normal > low, moves nothing', async () => {
    const bus = new Bus(store, stateRoot);
    await bus.send(baseMessage({ id: ulid(), priority: 'low', body: 'low-1' }));
    await bus.send(baseMessage({ id: ulid(), priority: 'urgent', body: 'urgent-1' }));
    await bus.send(baseMessage({ id: ulid(), priority: 'normal', body: 'normal-1' }));

    const first = bus.poll('em');
    expect(first.map((m) => m.priority)).toEqual(['urgent', 'normal', 'low']);

    // Polling again returns the same three messages — poll moves nothing.
    const second = bus.poll('em');
    expect(second).toHaveLength(3);
  });

  test('filters by priority when asked', async () => {
    const bus = new Bus(store, stateRoot);
    await bus.send(baseMessage({ id: ulid(), priority: 'low' }));
    await bus.send(baseMessage({ id: ulid(), priority: 'urgent' }));
    expect(bus.poll('em', { priority: 'urgent' })).toHaveLength(1);
  });
});

describe('Bus.ack', () => {
  test('moves the message out of the unread inbox', async () => {
    const bus = new Bus(store, stateRoot);
    const message = baseMessage();
    await bus.send(message);
    expect(bus.poll('em')).toHaveLength(1);

    await bus.ack('em', (message as { id: string }).id);
    expect(bus.poll('em')).toHaveLength(0);

    const done = store.getEntity(
      join('bus', 'inbox', 'em', 'done', `${(message as { id: string }).id}.yaml`),
      (x) => x,
    );
    expect(done).toBeTruthy();
  });

  test('acking an unknown id throws', async () => {
    const bus = new Bus(store, stateRoot);
    await expect(bus.ack('em', ulid())).rejects.toThrow();
  });
});

describe('Bus.heartbeat', () => {
  test('creates a registry entry on first heartbeat and updates last_seen thereafter', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const bus = new Bus(store, stateRoot, { now: () => now });

    await bus.heartbeat('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      pid: 42,
      ticket: 'TKT-0001',
    });
    expect(store.getAgent('eng-1').last_seen).toBe(now.toISOString());
    expect(store.getAgent('eng-1').ticket).toBe('TKT-0001');

    now = new Date('2026-01-01T00:05:00.000Z');
    await bus.heartbeat('eng-1');
    const record = store.getAgent('eng-1');
    expect(record.last_seen).toBe(now.toISOString());
    // Fields not in the patch survive the update.
    expect(record.vendor).toBe('claude');
    expect(record.ticket).toBe('TKT-0001');
  });
});

describe('Bus.checkLiveness', () => {
  test('an unresponsive agent on a live ticket: escalate to em + ticket back to ready + agent removed', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'in_progress', assignee: 'eng-1' }));
    const start = new Date('2026-01-01T00:00:00.000Z');
    let now = start;
    const bus = new Bus(store, stateRoot, { now: () => now, livenessTimeoutMs: 5 * 60 * 1000 });

    await bus.heartbeat('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      pid: 1,
      ticket: 'TKT-0001',
    });

    // Well past the 5-minute timeout.
    now = new Date(start.getTime() + 6 * 60 * 1000);
    const escalations = await bus.checkLiveness(now);

    expect(escalations).toEqual([{ agent: 'eng-1', ticket: 'TKT-0001' }]);
    expect(store.getTicket('TKT-0001').status).toBe('ready');
    expect(() => store.getAgent('eng-1')).toThrow();

    const emInbox = bus.poll('em');
    expect(emInbox.some((m) => m.kind === 'escalate' && m.ticket === 'TKT-0001')).toBe(true);
  });

  test('does not escalate an agent still within the liveness window', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'in_progress', assignee: 'eng-1' }));
    const start = new Date('2026-01-01T00:00:00.000Z');
    let now = start;
    const bus = new Bus(store, stateRoot, { now: () => now, livenessTimeoutMs: 5 * 60 * 1000 });
    await bus.heartbeat('eng-1', { vendor: 'claude', model: 'sonnet', pid: 1, ticket: 'TKT-0001' });

    now = new Date(start.getTime() + 60 * 1000);
    const escalations = await bus.checkLiveness(now);
    expect(escalations).toEqual([]);
    expect(store.getTicket('TKT-0001').status).toBe('in_progress');
  });

  test('does not escalate an idle agent (no ticket)', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    let now = start;
    const bus = new Bus(store, stateRoot, { now: () => now, livenessTimeoutMs: 5 * 60 * 1000 });
    await bus.heartbeat('eng-1', { vendor: 'claude', model: 'sonnet', pid: 1 });

    now = new Date(start.getTime() + 60 * 60 * 1000);
    expect(await bus.checkLiveness(now)).toEqual([]);
  });
});

describe('Bus.sweepRedelivery — the ladder', () => {
  test('bumps low -> normal -> urgent as each deadline passes, then escalates to em', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    let now = start;
    const bus = new Bus(store, stateRoot, { now: () => now });

    const id = ulid(now.getTime());
    await bus.send(
      baseMessage({
        id,
        from: 'em',
        to: ['eng-1'],
        kind: 'assign',
        priority: 'low',
        requires_ack: true,
        deadline: new Date(start.getTime() + 60_000).toISOString(),
      }),
    );

    // Before the deadline: no change.
    now = new Date(start.getTime() + 30_000);
    let sweep = await bus.sweepRedelivery(now);
    expect(sweep.redelivered).toHaveLength(0);
    expect(bus.poll('eng-1')[0]?.priority).toBe('low');

    // Past the deadline: low -> normal.
    now = new Date(start.getTime() + 61_000);
    sweep = await bus.sweepRedelivery(now);
    expect(sweep.redelivered).toEqual([{ agent: 'eng-1', id, from: 'low', to: 'normal' }]);
    expect(bus.poll('eng-1')[0]?.priority).toBe('normal');

    // Past the new deadline: normal -> urgent.
    now = new Date(now.getTime() + 61_000);
    sweep = await bus.sweepRedelivery(now);
    expect(sweep.redelivered).toEqual([{ agent: 'eng-1', id, from: 'normal', to: 'urgent' }]);
    expect(bus.poll('eng-1')[0]?.priority).toBe('urgent');

    // Past the new deadline again, already urgent: escalate to em instead of redelivering again.
    now = new Date(now.getTime() + 61_000);
    sweep = await bus.sweepRedelivery(now);
    expect(sweep.redelivered).toHaveLength(0);
    expect(sweep.escalated).toEqual([{ agent: 'eng-1', id }]);
    expect(bus.poll('em').some((m) => m.kind === 'escalate')).toBe(true);
    // requires_ack cleared so it isn't escalated again on the next sweep.
    expect(bus.poll('eng-1')[0]?.requires_ack).toBe(false);

    now = new Date(now.getTime() + 1);
    sweep = await bus.sweepRedelivery(now);
    expect(sweep.escalated).toHaveLength(0);
  });

  test('a message with no deadline is never redelivered', async () => {
    const bus = new Bus(store, stateRoot);
    await bus.send(baseMessage({ from: 'em', to: ['eng-1'], kind: 'assign', requires_ack: true }));
    const sweep = await bus.sweepRedelivery(new Date(Date.now() + 10 * 60 * 1000));
    expect(sweep.redelivered).toHaveLength(0);
    expect(sweep.escalated).toHaveLength(0);
  });

  test('a message not requiring ack is never redelivered', async () => {
    const bus = new Bus(store, stateRoot);
    await bus.send(baseMessage({ from: 'em', to: ['eng-1'], kind: 'assign' }));
    const sweep = await bus.sweepRedelivery(new Date(Date.now() + 10 * 60 * 1000));
    expect(sweep.redelivered).toHaveLength(0);
  });
});
