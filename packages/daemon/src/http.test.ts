import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type HttpServerHandle, startHttpServer } from './http';

let server: HttpServerHandle;

beforeEach(() => {
  server = startHttpServer({
    port: 0, // ephemeral
    version: '0.0.0-test',
    stateRoot: '/tmp/fake-state-root',
    startedAt: Date.now(),
  });
});

afterEach(async () => {
  await server.stop();
});

describe('GET /health', () => {
  test('returns daemon version, state root, pid, uptime', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      stateRoot: string;
      pid: number;
      uptime: number;
    };
    expect(body.version).toBe('0.0.0-test');
    expect(body.stateRoot).toBe('/tmp/fake-state-root');
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptime).toBe('number');
  });
});

describe('unknown routes', () => {
  test('404s', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});

describe('WebSocket /ws', () => {
  test('accepts a connection and sends a hello frame', async () => {
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.onmessage = (event) => {
        resolve(event.data as string);
        ws.close();
      };
      ws.onerror = (event) => reject(event);
    });
    const frame = JSON.parse(message) as { type: string; version: string; stateRoot: string };
    expect(frame.type).toBe('hello');
    expect(frame.version).toBe('0.0.0-test');
    expect(frame.stateRoot).toBe('/tmp/fake-state-root');
  });
});
