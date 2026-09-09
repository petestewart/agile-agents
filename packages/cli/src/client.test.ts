import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RpcServerHandle, startRpcServer } from '@agile-agents/daemon';
import { RpcCallError, RpcConnectionError, callRpc } from './client';

let dir: string;
let socketPath: string;
let rpc: RpcServerHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-cli-client-'));
  socketPath = join(dir, 'test.sock');
});

afterEach(async () => {
  await rpc?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('callRpc', () => {
  test('round-trips a successful call', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'echo.ping': (params) => ({ echoed: params }) },
    });

    const result = await callRpc<{ echoed: unknown }>(socketPath, 'echo.ping', { hello: 'world' });
    expect(result.echoed).toEqual({ hello: 'world' });
  });

  test('rejects with RpcCallError on a daemon-reported error', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
    });

    await expect(callRpc(socketPath, 'nonexistent.method')).rejects.toThrow(RpcCallError);
  });

  test('rejects with RpcConnectionError when nothing is listening', async () => {
    expect(existsSync(socketPath)).toBe(false);
    await expect(callRpc(socketPath, 'daemon.ping', undefined, { timeoutMs: 500 })).rejects.toThrow(
      RpcConnectionError,
    );
  });

  test('daemon.status returns pid/version/stateRoot/uptime', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '9.9.9',
      stateRoot: dir,
      startedAt: Date.now(),
    });
    const status = await callRpc<{ version: string; pid: number }>(socketPath, 'daemon.status');
    expect(status.version).toBe('9.9.9');
    expect(status.pid).toBe(process.pid);
  });
});
