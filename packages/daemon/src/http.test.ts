import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { Bus } from './bus';
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

  describe('cross-origin protection on HIL POSTs (review nit)', () => {
    test('a same-origin Origin header is accepted', async () => {
      const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${feedServer.port}` },
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(200);
    });

    test('an Origin naming a different origin is rejected with 403 and does not resolve the request', async () => {
      const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(403);
      expect(gates.get(created.id).status).toBe('pending');
    });

    test('no Origin header at all (e.g. a CLI/server client) is accepted', async () => {
      const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(200);
    });

    test('Sec-Fetch-Site: same-origin is accepted, cross-site is rejected with 403', async () => {
      const sameOrigin = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
      const ok = await fetch(
        `http://127.0.0.1:${feedServer.port}/api/hil/${sameOrigin.id}/approve`,
        {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify({ by: 'a' }),
        },
      );
      expect(ok.status).toBe(200);

      const crossSite = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
      const rejected = await fetch(
        `http://127.0.0.1:${feedServer.port}/api/hil/${crossSite.id}/approve`,
        {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
          body: JSON.stringify({ by: 'a' }),
        },
      );
      expect(rejected.status).toBe(403);
      expect(gates.get(crossSite.id).status).toBe('pending');
    });
  });
});

// --- T025 control room reads/writes (verify-before-build inventory found
// none of these endpoints existed before this ticket — every one below is a
// GET backed by an existing StateStore getter, or a POST/DELETE through an
// existing daemon verb: createHalt/releaseHalt, Bus.send). ---

describe('T025 control room routes', () => {
  let repo: string;
  let stateRoot: string;
  let store: StateStore;
  let gates: GateService;
  let bus: Bus;
  let crServer: HttpServerHandle;

  function policy(overrides: Partial<Policy['gates']> = {}): Policy {
    return { gates: { unblock: 'human', ...overrides }, breaker_signals: [] };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-cr-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    const init = runInit(repo);
    stateRoot = init.stateRoot;
    store = StateStore.open(stateRoot);
    gates = new GateService(store);
    bus = new Bus(store, stateRoot);
    crServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      bus,
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await crServer.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  test('GET /api/agents lists registered agents', async () => {
    await bus.heartbeat('eng-1', { vendor: 'claude', model: 'sonnet' });
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; record: { vendor: string } }>;
    expect(body.find((a) => a.id === 'eng-1')?.record.vendor).toBe('claude');
  });

  test('GET /api/tickets and /api/tickets/:id return the ticket plus its stanzas', async () => {
    await store.putTicket({
      id: 'TKT-0101',
      title: 'Read endpoint fixture',
      status: 'draft',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    const list = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets`);
    expect(list.status).toBe(200);
    const tickets = (await list.json()) as Array<{ id: string }>;
    expect(tickets.some((t) => t.id === 'TKT-0101')).toBe(true);

    const detail = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0101`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { ticket: { id: string }; stanzas: unknown[] };
    expect(body.ticket.id).toBe('TKT-0101');
    expect(Array.isArray(body.stanzas)).toBe(true);
  });

  test('GET /api/tickets/:id 404s for an unknown ticket', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-9999`);
    expect(res.status).toBe(404);
  });

  test('GET /api/oracle and /api/oracle/:id return the index and one entry', async () => {
    await store.putOracleEntry(
      {
        id: 'DEC-0001',
        title: 'Test decision',
        status: 'active',
        supersedes: [],
        depends: [],
        affects: [],
        decided: '2026-09-08',
        by: 'architect',
        rationale: 'fixture',
      },
      'Full decision body.',
    );

    const index = await fetch(`http://127.0.0.1:${crServer.port}/api/oracle`);
    expect(index.status).toBe(200);
    const indexBody = (await index.json()) as Record<string, { title: string }>;
    expect(indexBody['DEC-0001']?.title).toBe('Test decision');

    const entry = await fetch(`http://127.0.0.1:${crServer.port}/api/oracle/DEC-0001`);
    expect(entry.status).toBe(200);
    const entryBody = (await entry.json()) as { entry: { id: string }; body: string };
    expect(entryBody.entry.id).toBe('DEC-0001');
    expect(entryBody.body.trim()).toBe('Full decision body.');
  });

  test('GET /api/oracle/:id 404s for an unknown id', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/oracle/DEC-9999`);
    expect(res.status).toBe(404);
  });

  test('GET /api/kb and /api/kb/:id return the index and one fact', async () => {
    await store.putKbFact(
      {
        id: 'KB-0001',
        kind: 'gotcha',
        scope: ['auth'],
        confidence: 'observed',
        source: 'TKT-0101',
        expires: null,
      },
      'Fixture fact body.',
    );

    const index = await fetch(`http://127.0.0.1:${crServer.port}/api/kb`);
    expect(index.status).toBe(200);
    const indexBody = (await index.json()) as Record<string, { kind: string }>;
    expect(indexBody['KB-0001']?.kind).toBe('gotcha');

    const fact = await fetch(`http://127.0.0.1:${crServer.port}/api/kb/KB-0001`);
    expect(fact.status).toBe(200);
    const factBody = (await fact.json()) as { fact: { id: string }; body: string };
    expect(factBody.fact.id).toBe('KB-0001');
    expect(factBody.body.trim()).toBe('Fixture fact body.');
  });

  test('GET /api/policy returns the repo policy', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Policy;
    expect(body.gates).toBeDefined();
  });

  test('POST /api/halt creates a real halt (via createHalt) that shows up in the snapshot', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/halt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test halt' }),
    });
    expect(res.status).toBe(201);
    const halt = (await res.json()) as { id: string; scope: string; raised_by: string };
    expect(halt.scope).toBe('global');
    expect(halt.raised_by).toBe('human');

    expect(store.listHalts().some((h) => h.id === halt.id)).toBe(true);

    const del = await fetch(`http://127.0.0.1:${crServer.port}/api/halt/${halt.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(store.listHalts().some((h) => h.id === halt.id)).toBe(false);
  });

  test('DELETE /api/halt/:id 404s for an unknown halt', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/halt/H-999`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  test('T025 review round 1 blocker 1: DELETE /api/halt/:id 400s a traversal id instead of reaching the store', async () => {
    const res = await fetch(
      `http://127.0.0.1:${crServer.port}/api/halt/${encodeURIComponent('../../../victim')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('invalid halt id');
  });

  test('T025 review round 1 blocker 2: POST /api/halt ignores a forged raised_by and always writes human', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/halt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test halt', raised_by: 'architect' }),
    });
    expect(res.status).toBe(201);
    const halt = (await res.json()) as { id: string; raised_by: string };
    expect(halt.raised_by).toBe('human');
    expect(store.getHalt(halt.id as never).raised_by).toBe('human');
  });

  test('POST /api/chat/em lands a real fyi message on the em inbox via Bus.send', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/chat/em`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'steer: reroute TKT-0233 off openai' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: { kind: string; to: string[] } };
    expect(body.ok).toBe(true);
    expect(body.message.kind).toBe('fyi');
    expect(body.message.to).toEqual(['em']);

    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.body.includes('reroute TKT-0233'))).toBe(true);
  });

  test('POST /api/chat/em without a body is a 400', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/chat/em`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/chat/em without a wired Bus 503s (documented daemon.ts wiring gap)', async () => {
    const noBusServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      // no `bus` — mirrors today's real `daemon.ts`, which does not pass one yet.
    });
    try {
      const res = await fetch(`http://127.0.0.1:${noBusServer.port}/api/chat/em`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      });
      expect(res.status).toBe(503);
    } finally {
      await noBusServer.stop();
    }
  });

  test('POST /api/oracle/propose sends a decision request to the architect, never writes the oracle directly', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/oracle/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'DEC-0042', body: 'Widen the grace window to 60s.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: { kind: string; to: string[] } };
    expect(body.ok).toBe(true);
    expect(body.message.kind).toBe('decision');
    expect(body.message.to).toEqual(['architect']);

    const inbox = bus.poll('architect');
    expect(inbox.some((m) => m.body.includes('DEC-0042') && m.body.includes('60s'))).toBe(true);
    // Never a direct write — no such entry exists in the oracle index.
    expect(store.listOracleIndex()['DEC-0042']).toBeUndefined();
  });

  test('control room SPA is served under /control-room (falls back to 404 pre-build, same as a missing feed.html would)', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/control-room`);
    // Either served (if `bun run build` has produced dist-app/index.html in
    // this checkout) or 404 (fresh checkout, ui package not built yet) —
    // both are acceptable; a 500 is not.
    expect([200, 404]).toContain(res.status);
  });
});
