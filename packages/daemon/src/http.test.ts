import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { Bus } from './bus';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { runInit } from './init';
import { QuestionService } from './questions';
import { StateStore } from './store';
import { type FakeJiraHandle, HttpJiraClient, JiraSync, startFakeJira } from './sync';

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

  test('GET /api/sync/jira 503s when Jira is not configured', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/jira`);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'jira sync is not configured',
    });
  });

  test('POST /api/sync/jira/link and /unlink 503 when Jira is not configured', async () => {
    for (const path of ['/api/sync/jira/link', '/api/sync/jira/unlink']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        body: JSON.stringify({ project: 'LED' }),
      });
      expect(res.status).toBe(503);
    }
  });
});

// --- Tests against a real .agile/ state root (T020: snapshot, live tail, HIL actions) ---

describe('feed with a real store', () => {
  let repo: string;
  let store: StateStore;
  let gates: GateService;
  let questions: QuestionService;
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
    questions = new QuestionService(store);
    feedServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      questions,
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
      questions: Array<{ status: string }>;
    };
    expect(body.type).toBe('snapshot');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.sprint.tickets).toEqual({ done: 1, in_flight: 0, stale: 0, total: 1 });
    expect(Array.isArray(body.halts)).toBe(true);
    expect(body.hil).toHaveLength(1);
    expect(body.hil[0]?.status).toBe('pending');
    // T040: open questions ride the same attention-queue snapshot.
    expect(body.questions).toEqual([]);
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
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { status: string; decision: string; decided_by: string };
    expect(updated.status).toBe('resolved');
    expect(updated.decision).toBe('approve');
    expect(updated.decided_by).toBe('human');

    // Assert against the on-disk HIL file, not just the HTTP response.
    const onDisk = store.getEntity(`board/hil/${created.id}.yaml`, (v) => v as { status: string });
    expect(onDisk.status).toBe('resolved');

    // gate.list (via GateService.list()) reflects the resolution too.
    const list = gates.list();
    expect(list.find((r) => r.id === created.id)?.status).toBe('resolved');
  });

  // T039 (§17 "Control room v2"): the Needs-you card's typed answer.
  test('POST /api/hil/:id/approve carries a note; /deny resolves with deny; /note stores without resolving', async () => {
    const approved = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const withNote = await fetch(
      `http://127.0.0.1:${feedServer.port}/api/hil/${approved.id}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'yes, but only for the seed script' }),
      },
    );
    expect(withNote.status).toBe(200);
    expect((await withNote.json()) as { note: string }).toMatchObject({
      status: 'resolved',
      decision: 'approve',
      note: 'yes, but only for the seed script',
    });

    const denied = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const denyRes = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${denied.id}/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'not on a shared branch' }),
    });
    expect(denyRes.status).toBe(200);
    expect((await denyRes.json()) as unknown).toMatchObject({
      decision: 'deny',
      note: 'not on a shared branch',
    });

    // A note with no button press resolves nothing.
    const noted = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const noteRes = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${noted.id}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'only for the seed script' }),
    });
    expect(noteRes.status).toBe(200);
    expect((await noteRes.json()) as unknown).toMatchObject({
      status: 'pending',
      note: 'only for the seed script',
    });
    expect(gates.list().find((r) => r.id === noted.id)?.status).toBe('pending');

    // An empty note on /note is a 400; an over-long note is a 400 too.
    const empty = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${noted.id}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '   ' }),
    });
    expect(empty.status).toBe(400);
    const tooLong = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${noted.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x'.repeat(801) }),
    });
    expect(tooLong.status).toBe(400);
  });

  // T032: `by` must never be trusted from the request body — a page could
  // otherwise forge the audit trail's actor. Same hardcode as T025's
  // halt/chat/propose routes; this asserts it holds for approve too.
  test('POST /api/hil/:id/approve ignores a forged `by` in the body and always records `human`', async () => {
    const created = await gates.request('unblock', { policy: policy(), hilKind: 'unblock' });
    const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'architect' }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { decided_by: string };
    expect(updated.decided_by).toBe('human');
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

// --- T045: Jira two-way sync link/unlink actions (§17 v2 Tickets pane) ---

describe('T045 Jira sync routes', () => {
  let repo: string;
  let configPath: string;
  let store: StateStore;
  let jira: FakeJiraHandle;
  let sync: JiraSync;
  let syncServer: HttpServerHandle;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-sync-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    const init = runInit(repo);
    configPath = join(repo, 'agile.config.yaml');
    store = StateStore.open(init.stateRoot);
    jira = startFakeJira();
    sync = new JiraSync({
      store,
      client: new HttpJiraClient({
        baseUrl: jira.baseUrl,
        email: 'pete@example.com',
        apiToken: 'token-123',
      }),
      configPath,
      onError: () => {},
    });
    syncServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      jiraSync: sync,
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await syncServer.stop();
    jira.stop();
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  test('GET /api/sync/jira reports an unlinked repo', async () => {
    const res = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { linked: boolean; mapped: number }).toEqual({
      linked: false,
      mapped: 0,
    });
  });

  test('link round-trips a project key through the POST body, and status reflects it', async () => {
    const linked = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'LED' }),
    });
    expect(linked.status).toBe(200);
    expect((await linked.json()) as { project: string }).toMatchObject({
      linked: true,
      project: 'LED',
      source: 'config',
    });

    const status = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira`);
    expect((await status.json()) as { project: string }).toMatchObject({
      linked: true,
      project: 'LED',
    });
    // The link lands in the host-local config file, never under `.agile/`.
    expect(readFileSync(configPath, 'utf8')).toContain('project: LED');
  });

  test('unlink clears the link', async () => {
    await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'LED' }),
    });
    const unlinked = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/unlink`, {
      method: 'POST',
    });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()) as { unlinked: boolean }).toMatchObject({
      unlinked: true,
      project: 'LED',
    });

    const status = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira`);
    expect((await status.json()) as { linked: boolean }).toMatchObject({ linked: false });
    expect(sync.linkedProject()).toBeUndefined();
  });

  test('a project key that is not a Jira key is a 400 and writes nothing', async () => {
    const res = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'not a key' }),
    });
    expect(res.status).toBe(400);
    expect(sync.linkedProject()).toBeUndefined();
  });

  describe('cross-origin protection on the sync POSTs', () => {
    test('a same-origin Origin header is accepted', async () => {
      const res = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${syncServer.port}` },
        body: JSON.stringify({ project: 'LED' }),
      });
      expect(res.status).toBe(200);
      expect(sync.linkedProject()).toBe('LED');
    });

    test('an Origin naming a different origin is rejected with 403 and does not link', async () => {
      const res = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: JSON.stringify({ project: 'LED' }),
      });
      expect(res.status).toBe(403);
      expect(sync.linkedProject()).toBeUndefined();
    });

    test('no Origin header at all (e.g. a CLI/server client) is accepted', async () => {
      const res = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
        method: 'POST',
        body: JSON.stringify({ project: 'LED' }),
      });
      expect(res.status).toBe(200);
    });

    test('Sec-Fetch-Site: same-origin is accepted, cross-site is rejected with 403', async () => {
      const ok = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/link`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ project: 'LED' }),
      });
      expect(ok.status).toBe(200);

      const rejected = await fetch(`http://127.0.0.1:${syncServer.port}/api/sync/jira/unlink`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(rejected.status).toBe(403);
      // Still linked: the rejected unlink changed nothing.
      expect(sync.linkedProject()).toBe('LED');
    });
  });
});

// --- T040 questions routes (§17 "Control room v2" -> "Questions vs Decisions") ---

describe('T040 question routes', () => {
  let repo: string;
  let store: StateStore;
  let questions: QuestionService;
  let qServer: HttpServerHandle;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-questions-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    const init = runInit(repo);
    store = StateStore.open(init.stateRoot);
    questions = new QuestionService(store);
    qServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      questions,
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await qServer.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${qServer.port}${path}`;
  }

  test('POST /api/questions raises one as `human`, GET lists it, and ?status=open filters', async () => {
    const res = await fetch(url('/api/questions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // T032: a forged raised_by in the body must be ignored.
      body: JSON.stringify({ text: 'which storage wins?', raised_by: 'architect' }),
    });
    expect(res.status).toBe(201);
    const raised = (await res.json()) as { id: string; raised_by: string; status: string };
    expect(raised.raised_by).toBe('human');
    expect(raised.status).toBe('open');

    const list = (await (await fetch(url('/api/questions'))).json()) as unknown[];
    expect(list).toHaveLength(1);
    const open = (await (await fetch(url('/api/questions?status=open'))).json()) as unknown[];
    expect(open).toHaveLength(1);
  });

  test('POST /api/questions/:id/answer with a reply answers it and delivers to the raiser', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'is the ticket right?' });
    const res = await fetch(url(`/api/questions/${q.id}/answer`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'no — refine it', resolved_as: 'reply' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { status: string; answered_by: string } };
    expect(body.question.status).toBe('answered');
    expect(body.question.answered_by).toBe('human');
    expect(questions.listOpen()).toHaveLength(0);
    expect(store.listEntities('bus/inbox/eng-1', (v) => v)).toHaveLength(1);
  });

  test('answering with "record as decision" publishes a DEC-* and links it', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'sqlite or files?' });
    const res = await fetch(url(`/api/questions/${q.id}/answer`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'files for v0', resolved_as: 'decision' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { resolved_as: string } };
    expect(body.question.resolved_as).toMatch(/^DEC-\d{4}$/);
    expect(Object.keys(store.listOracleIndex())).toContain(body.question.resolved_as);
  });

  test('bad ids, empty answers, double answers and cross-origin posts are refused', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'q' });
    expect(
      (
        await fetch(url('/api/questions/Q-nope/answer'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: 'a' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url(`/api/questions/${q.id}/answer`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: '   ' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url('/api/questions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
          body: JSON.stringify({ text: 'drive-by' }),
        })
      ).status,
    ).toBe(403);

    const answer = () =>
      fetch(url(`/api/questions/${q.id}/answer`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'a', resolved_as: 'reply' }),
      });
    expect((await answer()).status).toBe(200);
    expect((await answer()).status).toBe(409);
  });

  test('an unknown question 404s', async () => {
    const res = await fetch(url('/api/questions/Q-01ARZ3NDEKTSV4RRFFQ69G5FAV/answer'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'a' }),
    });
    expect(res.status).toBe(404);
  });
});
