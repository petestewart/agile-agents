import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentMessage, ulid, validateAgentMessage } from '@agile-agents/shared';
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

const SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Files one message straight into `agent`'s inbox, the way its producers (`gates/service.ts`) do. */
async function file(overrides: Partial<AgentMessage> = {}): Promise<AgentMessage> {
  const message = validateAgentMessage({
    id: ulid(),
    ts: new Date().toISOString(),
    from: 'human',
    to: [SESSION],
    kind: 'hil_response',
    priority: 'normal',
    body: 'hello',
    ...overrides,
  });
  await store.putEntity(
    join('bus', 'inbox', SESSION, `${message.id}.yaml`),
    validateAgentMessage,
    message,
  );
  return message;
}

describe('Bus.poll', () => {
  test('orders unread messages urgent > normal > low, moves nothing', async () => {
    const bus = new Bus(store, stateRoot);
    await file({ priority: 'low', body: 'low-1' });
    await file({ priority: 'urgent', body: 'urgent-1' });
    await file({ priority: 'normal', body: 'normal-1' });

    const first = bus.poll(SESSION);
    expect(first.map((m) => m.priority)).toEqual(['urgent', 'normal', 'low']);

    // Polling again returns the same three messages — poll moves nothing.
    expect(bus.poll(SESSION)).toHaveLength(3);
  });

  test('filters by priority when asked', async () => {
    const bus = new Bus(store, stateRoot);
    await file({ priority: 'low' });
    await file({ priority: 'urgent' });
    expect(bus.poll(SESSION, { priority: 'urgent' })).toHaveLength(1);
  });

  test('an agent with no inbox has nothing to poll', () => {
    expect(new Bus(store, stateRoot).poll('human')).toEqual([]);
  });
});

describe('Bus.ack', () => {
  test('moves the message out of the unread inbox', async () => {
    const bus = new Bus(store, stateRoot);
    const message = await file();
    expect(bus.poll(SESSION)).toHaveLength(1);

    await bus.ack(SESSION, message.id);
    expect(bus.poll(SESSION)).toHaveLength(0);

    const done = store.getEntity(
      join('bus', 'inbox', SESSION, 'done', `${message.id}.yaml`),
      (x) => x,
    );
    expect(done).toBeTruthy();
  });

  test('acking an already-acked message is a no-op that returns it; an unknown id throws', async () => {
    const bus = new Bus(store, stateRoot);
    const message = await file();
    const first = await bus.ack(SESSION, message.id);
    const second = await bus.ack(SESSION, message.id);
    expect(second.id).toBe(first.id);
    expect(bus.poll(SESSION)).toHaveLength(0);
    await expect(bus.ack(SESSION, ulid())).rejects.toThrow();
  });
});

describe('Bus.heartbeat', () => {
  test('creates a registry entry on first heartbeat and updates last_seen thereafter', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const bus = new Bus(store, stateRoot, { now: () => now });

    await bus.heartbeat(SESSION, {
      vendor: 'claude',
      model: 'sonnet',
      pid: 42,
      stream: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(store.getAgent(SESSION).last_seen).toBe(now.toISOString());
    expect(store.getAgent(SESSION).stream).toBe('01J9ZZZZZZZZZZZZZZZZZZZZZZ');

    now = new Date('2026-01-01T00:05:00.000Z');
    await bus.heartbeat(SESSION);
    const record = store.getAgent(SESSION);
    expect(record.last_seen).toBe(now.toISOString());
    // Fields not in the patch survive the update.
    expect(record.vendor).toBe('claude');
    expect(record.stream).toBe('01J9ZZZZZZZZZZZZZZZZZZZZZZ');
  });
});
