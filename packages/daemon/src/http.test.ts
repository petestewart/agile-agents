import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { runInit } from './init';
import { StateStore } from './store';

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

describe('GET / and /feed', () => {
  test('serve the static feed page without a store (feed routes just 503 for data)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/feed`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>Agile Agents');
    expect(body).toContain('/ws');

    const root = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(root.status).toBe(200);
  });
});

describe('feed routes without a store', () => {
  test('GET /api/snapshot 503s', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
    expect(res.status).toBe(503);
  });
});

// --- Tests against a real .agile/ state root (T020: snapshot, live tail, HIL actions) ---

describe('feed with a real store', () => {
  let repo: string;
  let store: StateStore;
  let gates: GateService;
  let feedServer: HttpServerHandle;

  function policy(overrides: Partial<Policy['gates']> = {}): Policy {
    return { gates: { unblock: 'human', ...overrides }, breaker_signals: [] };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-feed-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    const init = runInit(repo);
    store = StateStore.open(init.stateRoot);
    gates = new GateService(store);
    feedServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await feedServer.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  test('GET /api/snapshot has the documented shape', async () => {
    await store.putTicket({
      id: 'TKT-0001',
      title: 'Test',
      status: 'done',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });
    await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });

    const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      events: unknown[];
      sprint: { tickets: { done: number; in_flight: number; stale: number; total: number } };
      halts: unknown[];
      hil: Array<{ status: string }>;
    };
    expect(body.type).toBe('snapshot');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.sprint.tickets).toEqual({ done: 1, in_flight: 0, stale: 0, total: 1 });
    expect(Array.isArray(body.halts)).toBe(true);
    expect(body.hil).toHaveLength(1);
    expect(body.hil[0]?.status).toBe('pending');
  });

  test('WS sends hello, then a snapshot, then a live event within 1s of a store append', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${feedServer.port}/ws`);
    const gotEvent = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for live event')), 5000);
      ws.onmessage = (ev) => {
        const frame = JSON.parse(ev.data as string) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'event') {
          clearTimeout(timeout);
          resolve();
        }
      };
      ws.onerror = (event) => {
        clearTimeout(timeout);
        reject(event);
      };
    });

    // Wait for hello + snapshot before triggering the mutation, so ordering is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.map((f) => f.type)).toEqual(['hello', 'snapshot']);

    const start = Date.now();
    await store.putTicket({
      id: 'TKT-0002',
      title: 'Live event',
      status: 'draft',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    await gotEvent;
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);

    const eventFrame = frames.find((f) => f.type === 'event') as { event: { kind: string } };
    expect(eventFrame.event.kind).toBe('ticket_put');
    ws.close();
  });

  test('POST /api/hil/:id/approve resolves a real pending request created through the GateService', async () => {
    const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    expect(created.status).toBe('pending');

    const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'pete' }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { status: string; decision: string; decided_by: string };
    expect(updated.status).toBe('resolved');
    expect(updated.decision).toBe('approve');
    expect(updated.decided_by).toBe('pete');

    // Assert against the on-disk HIL file, not just the HTTP response.
    const onDisk = store.getEntity(`board/hil/${created.id}.yaml`, (v) => v as { status: string });
    expect(onDisk.status).toBe('resolved');

    // gate.list (via GateService.list()) reflects the resolution too.
    const list = gates.list();
    expect(list.find((r) => r.id === created.id)?.status).toBe('resolved');
  });

  test('POST /api/hil/:id/approve twice: the second call 409s (already resolved)', async () => {
    const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const url = `http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`;
    const first = await fetch(url, { method: 'POST', body: JSON.stringify({ by: 'a' }) });
    expect(first.status).toBe(200);
    const second = await fetch(url, { method: 'POST', body: JSON.stringify({ by: 'b' }) });
    expect(second.status).toBe(409);
  });

  test('POST /api/hil/:id/delegate delegates a pending request without a configured delegate fn (fails closed, 4xx)', async () => {
    const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/delegate`, {
      method: 'POST',
      body: JSON.stringify({ to: 'em' }),
    });
    // No delegate function is wired in this test's GateService (fail-closed,
    // §18 review decision) — asserts the route surfaces that as a client
    // error rather than a 500 or a silent auto-approve.
    expect(res.status).toBe(400);
  });

  test('POST /api/hil/:id/approve 404s for an unknown id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${feedServer.port}/api/hil/HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV/approve`,
      { method: 'POST', body: JSON.stringify({ by: 'a' }) },
    );
    expect(res.status).toBe(404);
  });
});
