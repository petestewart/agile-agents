import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DaemonHandle, startDaemon } from './daemon';
import { runInit } from './init';
import type { JsonRpcResponse } from './rpc';
import { StateStore } from './store';

let repo: string;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-daemon-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
});

afterEach(async () => {
  await handle?.stop();
  rmSync(repo, { recursive: true, force: true });
});

describe('startDaemon', () => {
  test('acquires the lock, and /health serves version + stateRoot', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);

    const res = await fetch(`http://127.0.0.1:${handle.http.port}/health`);
    const body = (await res.json()) as { version: string; stateRoot: string };
    expect(body.stateRoot).toBe(handle.config.stateRoot);
    expect(typeof body.version).toBe('string');
  });

  test('a second daemon for the same repo fails with a clear lock error', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await expect(
      startDaemon({ cwd: repo, port: 0, socketPath: join(repo, '.agile-daemon.sock') }),
    ).rejects.toThrow(/already running/);
  });

  test('graceful shutdown removes the lock and closes the listeners', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    const { lockPath } = handle.config;
    const { port } = handle.http;
    const { socketPath } = handle.rpc;

    await handle.stop();
    handle = undefined; // already stopped; afterEach shouldn't stop it again

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test('stop() is idempotent', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    await handle.stop();
  });

  test('after shutdown, a fresh daemon can start for the same repo', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);
  });
});

function call(socketPath: string, request: Record<string, unknown>): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line) as JsonRpcResponse);
      }
    });
    socket.on('error', reject);
  });
}

describe('state.* RPC methods (T005)', () => {
  test('state.ticket_get/state.ticket_list are real once .agile/ exists; other state.* stay stubbed', async () => {
    runInit(repo);
    const store = StateStore.open(join(repo, '.agile'));
    await store.putTicket({
      id: 'TKT-0001',
      title: 'Test',
      status: 'draft',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });

    const get = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'state.ticket_get',
      params: { id: 'TKT-0001' },
    });
    expect('result' in get && (get.result as { id: string }).id).toBe('TKT-0001');

    const list = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'state.ticket_list',
    });
    expect('result' in list && (list.result as unknown[]).length).toBe(1);

    const stillStubbed = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 3,
      method: 'state.ticket_transition',
    });
    expect('error' in stillStubbed && stillStubbed.error.code).toBe(-32001);
  });
});
