import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, validateAgentMessage } from '@agile-agents/shared';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store';
import { Bus } from './bus';
import { buildBusRpcMethods } from './rpc-methods';

const SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let methods: Record<string, ReturnType<typeof buildBusRpcMethods>[string]>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-bus-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
  methods = buildBusRpcMethods(bus);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('buildBusRpcMethods via dispatch', () => {
  test('bus.poll / bus.ack round-trip, and bus.send is gone', async () => {
    const message = validateAgentMessage({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'human',
      to: [SESSION],
      kind: 'hil_response',
      priority: 'normal',
      body: 'hi',
    });
    await store.putEntity(
      join('bus', 'inbox', SESSION, `${message.id}.yaml`),
      validateAgentMessage,
      message,
    );

    const pollResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'bus.poll',
      params: { agent: SESSION },
    });
    expect(pollResponse && 'result' in pollResponse ? pollResponse.result : undefined).toEqual([
      expect.objectContaining({ id: message.id }),
    ]);

    const ackResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 3,
      method: 'bus.ack',
      params: { agent: SESSION, id: message.id },
    });
    expect(ackResponse && 'result' in ackResponse && ackResponse.result).toBeTruthy();

    const pollAfterAck = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 4,
      method: 'bus.poll',
      params: { agent: SESSION },
    });
    expect(pollAfterAck && 'result' in pollAfterAck ? pollAfterAck.result : undefined).toEqual([]);

    expect(Object.keys(methods)).not.toContain('bus.send');
  });

  test('bus.heartbeat updates last_seen', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'bus.heartbeat',
      params: { agent: SESSION, patch: { vendor: 'claude', model: 'sonnet', pid: 1 } },
    });
    expect(response && 'result' in response && response.result).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
    });
    expect(store.getAgent(SESSION).last_seen).toBeTruthy();
  });
});
