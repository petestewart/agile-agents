import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store';
import { Bus } from './bus';
import { buildBusRpcMethods } from './rpc-methods';
import { ulid } from './ulid';

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
  test('bus.send / bus.poll / bus.ack round-trip', async () => {
    const message = {
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'eng-1',
      to: ['em'],
      kind: 'question',
      priority: 'normal',
      body: 'hi',
    };

    const sendResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'bus.send',
      params: { message },
    });
    expect(sendResponse && 'result' in sendResponse && sendResponse.result).toBeTruthy();

    const pollResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'bus.poll',
      params: { agent: 'em' },
    });
    expect(pollResponse && 'result' in pollResponse ? pollResponse.result : undefined).toEqual([
      expect.objectContaining({ id: message.id }),
    ]);

    const ackResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 3,
      method: 'bus.ack',
      params: { agent: 'em', id: message.id },
    });
    expect(ackResponse && 'result' in ackResponse && ackResponse.result).toBeTruthy();

    const pollAfterAck = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 4,
      method: 'bus.poll',
      params: { agent: 'em' },
    });
    expect(pollAfterAck && 'result' in pollAfterAck ? pollAfterAck.result : undefined).toEqual([]);
  });

  test('bus.send surfaces a routing rejection as a result, not an RPC error', async () => {
    const message = {
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'eng-1',
      to: ['eng-2'],
      kind: 'question',
      priority: 'normal',
      body: 'hi',
    };
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'bus.send',
      params: { message },
    });
    expect(response && 'result' in response).toBe(true);
    if (response && 'result' in response) {
      expect(response.result).toMatchObject({ ok: false });
    }
  });

  test('bus.heartbeat updates last_seen', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'bus.heartbeat',
      params: { agent: 'eng-1', patch: { vendor: 'claude', model: 'sonnet', pid: 1 } },
    });
    expect(response && 'result' in response && response.result).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
    });
    expect(store.getAgent('eng-1').last_seen).toBeTruthy();
  });
});
