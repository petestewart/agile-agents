import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JsonRpcResponse, type RpcServerHandle, startRpcServer } from './rpc';

let dir: string;
let socketPath: string;
let server: RpcServerHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-rpc-'));
  socketPath = join(dir, 'agile.sock');
  server = startRpcServer({
    socketPath,
    version: '0.0.0-test',
    stateRoot: join(dir, '.agile'),
    startedAt: Date.now(),
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(request: Record<string, unknown>): Promise<JsonRpcResponse> {
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

describe('JSON-RPC over the unix socket', () => {
  test('daemon.ping responds pong', async () => {
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'daemon.ping' });
    expect('result' in response && response.result).toBe('pong');
  });

  test('daemon.status returns version, stateRoot, pid, uptime', async () => {
    const response = await call({ jsonrpc: '2.0', id: 2, method: 'daemon.status' });
    expect('result' in response).toBe(true);
    if ('result' in response) {
      const status = response.result as {
        version: string;
        stateRoot: string;
        pid: number;
        uptime: number;
      };
      expect(status.version).toBe('0.0.0-test');
      expect(status.stateRoot).toBe(join(dir, '.agile'));
      expect(status.pid).toBe(process.pid);
      expect(typeof status.uptime).toBe('number');
    }
  });

  for (const ns of ['bus', 'state', 'hook', 'gate']) {
    test(`${ns}.* returns a structured not-implemented error`, async () => {
      const response = await call({ jsonrpc: '2.0', id: 3, method: `${ns}.something` });
      expect('error' in response).toBe(true);
      if ('error' in response) {
        expect(response.error.message).toContain('not implemented');
        expect(response.error.data).toEqual({ namespace: ns });
      }
    });
  }

  test('an unknown method outside the stub namespaces gets method-not-found', async () => {
    const response = await call({ jsonrpc: '2.0', id: 4, method: 'nonsense.method' });
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error.code).toBe(-32601);
    }
  });

  test('invalid JSON gets a parse error, not a crash', async () => {
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const socket = connect(socketPath);
      let buffer = '';
      socket.on('connect', () => socket.write('not json\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          socket.end();
          resolve(JSON.parse(buffer.split('\n')[0] ?? '') as JsonRpcResponse);
        }
      });
      socket.on('error', reject);
    });
    expect('error' in response).toBe(true);
  });
});

test('close() removes the socket file', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'agile-rpc-close-'));
  const socketPath2 = join(dir2, 'agile.sock');
  const handle = startRpcServer({
    socketPath: socketPath2,
    version: '0.0.0-test',
    stateRoot: dir2,
    startedAt: Date.now(),
  });
  expect(existsSync(socketPath2)).toBe(true);
  await handle.close();
  expect(existsSync(socketPath2)).toBe(false);
  rmSync(dir2, { recursive: true, force: true });
});
