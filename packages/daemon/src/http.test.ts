import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Policy, ulid } from '@agile-agents/shared';
import { Bus } from './bus';
import { EmChatService } from './em/chat';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { runInit } from './init';
import { PlanService } from './plan';
import { QuestionService } from './questions';
import { ensureTicketWorktree } from './runner/worktrees';
import { StateStore } from './store';
import { StreamService } from './streams';

// T121: gates are raised on a stream; the HIL routes only need an id, the
// question routes need a real one (the questions suite creates it).
let STREAM = ulid();
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

describe('GET /, /feed and the /control-room redirect (T112)', () => {
  test('/feed serves the static feed page without a store (feed routes just 503 for data)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/feed`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>Agile Agents');
    expect(body).toContain('/ws');
  });

  test('/ serves the control room, and /control-room redirects to it keeping the query', async () => {
    const root = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    // The SPA's assets keep their own `/control-room/` base.
    expect(await root.text()).toContain('/control-room/assets/');

    const moved = await fetch(`http://127.0.0.1:${server.port}/control-room?view=sprint`, {
      redirect: 'manual',
    });
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('/?view=sprint');
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
    return { gates: { classifier_review: 'human', ...overrides }, breaker_signals: [] };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-feed-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    // T111: the state home lives outside the repo.
    const init = runInit(join(repo, 'home'));
    store = StateStore.open(init.stateRoot);
    gates = new GateService(store);
    questions = new QuestionService(store, new StreamService(store));
    feedServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      repoRoot: repo,
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
    await gates.request('classifier_review', { policy: policy(), stream: STREAM });

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
    const created = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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
    const approved = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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

    const denied = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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
    const noted = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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
    const created = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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
    const created = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
    const url = `http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`;
    const first = await fetch(url, { method: 'POST', body: JSON.stringify({ by: 'a' }) });
    expect(first.status).toBe(200);
    const second = await fetch(url, { method: 'POST', body: JSON.stringify({ by: 'b' }) });
    expect(second.status).toBe(409);
  });

  test('POST /api/hil/:id/delegate delegates a pending request without a configured delegate fn (fails closed, 4xx)', async () => {
    const created = await gates.request('classifier_review', { policy: policy(), stream: STREAM });
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
      const created = await gates.request('classifier_review', {
        policy: policy(),
        stream: STREAM,
      });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${feedServer.port}` },
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(200);
    });

    test('an Origin naming a different origin is rejected with 403 and does not resolve the request', async () => {
      const created = await gates.request('classifier_review', {
        policy: policy(),
        stream: STREAM,
      });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(403);
      expect(gates.get(created.id).status).toBe('pending');
    });

    test('no Origin header at all (e.g. a CLI/server client) is accepted', async () => {
      const created = await gates.request('classifier_review', {
        policy: policy(),
        stream: STREAM,
      });
      const res = await fetch(`http://127.0.0.1:${feedServer.port}/api/hil/${created.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ by: 'a' }),
      });
      expect(res.status).toBe(200);
    });

    test('Sec-Fetch-Site: same-origin is accepted, cross-site is rejected with 403', async () => {
      const sameOrigin = await gates.request('classifier_review', {
        policy: policy(),
        stream: STREAM,
      });
      const ok = await fetch(
        `http://127.0.0.1:${feedServer.port}/api/hil/${sameOrigin.id}/approve`,
        {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-origin' },
          body: JSON.stringify({ by: 'a' }),
        },
      );
      expect(ok.status).toBe(200);

      const crossSite = await gates.request('classifier_review', {
        policy: policy(),
        stream: STREAM,
      });
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
  let emChat: EmChatService;

  function policy(overrides: Partial<Policy['gates']> = {}): Policy {
    return { gates: { classifier_review: 'human', ...overrides }, breaker_signals: [] };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-cr-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    // T111: the state home lives outside the repo.
    const init = runInit(join(repo, 'home'));
    stateRoot = init.stateRoot;
    store = StateStore.open(stateRoot);
    gates = new GateService(store);
    bus = new Bus(store, stateRoot);
    // T041: a stand-in resident EM (no vendor process) so the chat routes
    // and the `/ws` chat frames are exercised offline.
    emChat = new EmChatService({
      store,
      bus,
      repoRoot: repo,
      gates,
      resident: {
        prompt: () =>
          Object.assign(
            {
              [Symbol.asyncIterator]: async function* () {
                yield 'TKT-1001 is in review, ';
                yield 'TKT-1002 is unassigned.';
              },
            },
            { done: Promise.resolve('TKT-1001 is in review, TKT-1002 is unassigned.') },
          ),
      },
    });
    crServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      repoRoot: repo,
      startedAt: Date.now(),
      store,
      gates,
      bus,
      emChat,
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

  /**
   * T044: the ticket-detail reads (`story`, `thread`, `diff`) and the
   * sprint-review narrative. The diff route's path guard is the one with
   * teeth — a `worktree` field pointing anywhere outside `.worktrees/` must
   * be refused rather than run `git diff` against.
   */
  describe('T044 ticket detail + sprint review', () => {
    async function seedTicket(id = 'TKT-0102', worktree?: string): Promise<void> {
      await store.putTicket({
        id,
        title: 'Ticket detail fixture',
        status: 'in_review',
        contract: { inputs: [], outputs: [], acceptance: ['it works'], done: [], env: 'clone' },
        depends: [],
        oracle_refs: [],
        kb_refs: [],
        history: [],
        security: false,
        ...(worktree ? { worktree } : {}),
      });
    }

    test('GET /api/tickets/:id/story returns the ticket story with its steps', async () => {
      await seedTicket();
      await store.appendStanza({
        ts: new Date().toISOString(),
        ticket: 'TKT-0102',
        agent: 'eng-0102',
        kind: 'done',
        summary: '+10 −0 in 1 file',
      });
      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0102/story`);
      expect(res.status).toBe(200);
      const story = (await res.json()) as {
        ticket: string;
        steps: Array<{ headline?: string; text: string }>;
      };
      expect(story.ticket).toBe('TKT-0102');
      expect(story.steps.some((step) => step.headline === 'Built')).toBe(true);
    });

    test('GET /api/tickets/:id/thread returns the ticket bus thread', async () => {
      await seedTicket();
      await bus.send({
        id: ulid(),
        ts: new Date().toISOString(),
        from: 'reviewer-0102',
        to: ['eng-0102'],
        kind: 'review_verdict',
        priority: 'normal',
        ticket: 'TKT-0102',
        body: 'round 1: approve (0 finding(s))',
        refs: [],
        requires_ack: false,
      });
      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0102/thread`);
      expect(res.status).toBe(200);
      const thread = (await res.json()) as Array<{ kind: string; body: string }>;
      expect(thread).toHaveLength(1);
      expect(thread[0]?.kind).toBe('review_verdict');
    });

    test('GET /api/tickets/:id/diff returns the worktree diff against integration', async () => {
      await seedTicket('TKT-0103');
      const ticket = store.getTicket('TKT-0103');
      const worktree = ensureTicketWorktree(repo, ticket);
      writeFileSync(join(worktree.path, 'added.ts'), 'export const added = 1;\n');
      Bun.spawnSync(['git', 'add', '-A'], { cwd: worktree.path });
      Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add file'], {
        cwd: worktree.path,
      });
      await store.putTicket({ ...ticket, worktree: join('.worktrees', 'TKT-0103') });

      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0103/diff`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { patch: string; range: string; truncated: boolean };
      expect(body.range).toBe('integration...HEAD');
      expect(body.patch).toContain('added.ts');
      expect(body.patch).toContain('export const added = 1;');
      expect(body.truncated).toBe(false);
    });

    test('GET /api/tickets/:id/diff refuses a worktree path that resolves outside .worktrees/', async () => {
      // The escape has to be reachable on disk to prove the guard, not the
      // filesystem, is what refuses it.
      await seedTicket('TKT-0104');
      const ticket = store.getTicket('TKT-0104');
      ensureTicketWorktree(repo, ticket);
      await store.putTicket({
        ...ticket,
        worktree: join('.worktrees', 'TKT-0104', '..', '..'),
      });

      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0104/diff`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('outside');

      // An absolute path outside the repo is refused the same way.
      await store.putTicket({ ...store.getTicket('TKT-0104'), worktree: '/etc' });
      const absolute = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0104/diff`);
      expect(absolute.status).toBe(400);
    });

    test('GET /api/tickets/:id/diff 404s when the ticket has no worktree yet', async () => {
      await seedTicket('TKT-0105');
      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/tickets/TKT-0105/diff`);
      expect(res.status).toBe(404);
    });

    test('GET /api/sprint/review returns the narrative the run report renders', async () => {
      await store.putSprint({
        id: 'S-1',
        goal: 'ship the ledger',
        tickets: ['TKT-0106'],
        budget_tokens: 100,
        started: new Date().toISOString(),
        carried_over: [],
      });
      await seedTicket('TKT-0106');
      const res = await fetch(`http://127.0.0.1:${crServer.port}/api/sprint/review`);
      expect(res.status).toBe(200);
      const report = (await res.json()) as {
        sprint: string;
        asked: string;
        built: string;
        went_wrong: string;
        where: string;
      };
      expect(report.sprint).toBe('S-1');
      expect(report.asked).toContain('ship the ledger');
      expect(report.built).toBeString();
      expect(report.went_wrong).toBeString();
      expect(report.where).toBeString();
    });
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

  test('T041: POST /api/chat/em streams the EM reply over /ws and stores it on the thread', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${crServer.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws failed to open')));
    });
    ws.addEventListener('message', (ev) => {
      frames.push(JSON.parse(ev.data as string) as Record<string, unknown>);
    });

    const res = await fetch(`http://127.0.0.1:${crServer.port}/api/chat/em`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'what is left on all tickets' }),
    });
    expect(res.status).toBe(200);
    const posted = (await res.json()) as { streaming: boolean; reply_id: string };
    expect(posted.streaming).toBe(true);

    const deadline = Date.now() + 5000;
    while (!frames.some((f) => f.type === 'chat_turn_end') && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    ws.close();

    const deltas = frames.filter((f) => f.type === 'chat_delta');
    expect(deltas.map((f) => f.text).join('')).toBe(
      'TKT-1001 is in review, TKT-1002 is unassigned.',
    );
    expect(deltas.every((f) => f.message_id === posted.reply_id && f.thread === 'em')).toBe(true);
    expect(frames.filter((f) => f.type === 'chat_turn_end')).toEqual([
      { type: 'chat_turn_end', thread: 'em', message_id: posted.reply_id },
    ]);

    // And the same thread reads back over HTTP — this is what survives a reload.
    const history = (await (
      await fetch(`http://127.0.0.1:${crServer.port}/api/chat/em`)
    ).json()) as Array<{ from: string; body: string }>;
    expect(history.map((e) => [e.from, e.body])).toEqual([
      ['human', 'what is left on all tickets'],
      ['em', 'TKT-1001 is in review, TKT-1002 is unassigned.'],
    ]);
  });

  test('T041: GET /control-room/chat serves the SPA shell (pop-out window route)', async () => {
    const res = await fetch(`http://127.0.0.1:${crServer.port}/control-room/chat`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root">');
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
      repoRoot: repo,
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
    // T111: the state home lives outside the repo.
    const init = runInit(join(repo, 'home'));
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
      repoRoot: repo,
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

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'agile-questions-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    // T111: the state home lives outside the repo.
    const init = runInit(join(repo, 'home'));
    store = StateStore.open(init.stateRoot);
    const streams = new StreamService(store);
    questions = new QuestionService(store, streams);
    STREAM = (await streams.create('human', { title: 'q', goal: 'g' })).id;
    qServer = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      repoRoot: repo,
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
      body: JSON.stringify({ stream: STREAM, text: 'which storage wins?', raised_by: 'architect' }),
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
    const q = await questions.raise({
      stream: STREAM,
      raised_by: 'eng-1',
      text: 'is the ticket right?',
    });
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

  // T121: `decision` and `ticket` resolutions are deleted with the oracle
  // and the ticket model — `reply` is the only one left.
  test('answering with any resolution other than "reply" is a 400', async () => {
    const q = await questions.raise({ stream: STREAM, raised_by: 'eng-1', text: 'sqlite?' });
    for (const resolved_as of ['decision', 'ticket']) {
      const res = await fetch(url(`/api/questions/${q.id}/answer`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'files for v0', resolved_as }),
      });
      expect(res.status).toBe(400);
    }
  });

  test('bad ids, empty answers, double answers and cross-origin posts are refused', async () => {
    const q = await questions.raise({ stream: STREAM, raised_by: 'eng-1', text: 'q' });
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

/**
 * T043 — the Settings screen's write path and the top bar's single action.
 * §17 journey step 4 ("This is `policy.yaml`'s gates block with a face") and
 * §17 v2 ("The `approve_plan` gate is raised at sprint start ... the button
 * is Start Sprint N, always in the top bar").
 */
describe('T043 chrome routes', () => {
  let repo: string;
  let stateRoot: string;
  let store: StateStore;
  let gates: GateService;
  let server2: HttpServerHandle;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-t043-http-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    // T111: the state home lives outside the repo.
    const init = runInit(join(repo, 'home'));
    stateRoot = init.stateRoot;
    store = StateStore.open(stateRoot);
    gates = new GateService(store);
    server2 = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      repoRoot: repo,
      startedAt: Date.now(),
      store,
      gates,
      // T042 merge: `POST /api/sprint/start` is served by the Plan route
      // family (`PlanService`), which proposes the frontier, raises
      // `approve_plan` and persists the sprint only once that gate is
      // approved — see the note where T043's own version of the route used
      // to live in `http.ts`.
      plan: { service: new PlanService({ store, gates }) },
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await server2.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  function base(): string {
    return `http://127.0.0.1:${server2.port}`;
  }

  test('GET /api/snapshot carries the top bar’s project and status blocks', async () => {
    const body = (await (await fetch(`${base()}/api/snapshot`)).json()) as {
      project?: { name: string; path: string };
      status: { sprint_state: string; next_sprint_number: number; needs_you: number };
    };
    // The project root is the state root's parent, taken from the daemon's
    // own config — never from anything the browser sends.
    expect(body.project?.path).toBe(repo);
    expect(body.project?.name).toBe(repo.split('/').pop());
    expect(body.status.sprint_state).toBe('none');
    expect(body.status.next_sprint_number).toBe(1);
    expect(body.status.needs_you).toBe(0);
  });

  test('PUT /api/policy round-trips through the store and changes the NEXT gate’s owner', async () => {
    // Before: the shipped default owns every gate to the human; this test
    // points `classifier_review` at the EM first so the PUT has something to
    // change (T121: `defaultPolicy()` is the three surviving kinds).
    await store.putPolicy({
      gates: { ...store.getPolicy().gates, classifier_review: 'em' },
      breaker_signals: [],
    });
    expect(store.getPolicy().gates.classifier_review).toBe('em');
    const before = await gates.request('classifier_review', {
      policy: store.getPolicy(),
      stream: STREAM,
    });
    expect(before.owner).toBe('em');

    const res = await fetch(`${base()}/api/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gates: { ...store.getPolicy().gates, classifier_review: 'human' },
        breaker_signals: [],
      }),
    });
    expect(res.status).toBe(200);

    // It landed on disk through the store (not just in the response)...
    expect(store.getPolicy().gates.classifier_review).toBe('human');
    // ...and in the event log, attributed to the human.
    const policyEvent = store
      .listEvents()
      .filter((e) => e.kind === 'policy_put')
      .at(-1);
    expect(policyEvent?.agent).toBe('human');

    // ...and the NEXT gate raised against it resolves to the new owner.
    const after = await gates.request('classifier_review', {
      policy: store.getPolicy(),
      stream: STREAM,
    });
    expect(after.owner).toBe('human');
  });

  test('PUT /api/policy rejects a gates block the shared schema refuses, writing nothing', async () => {
    const res = await fetch(`${base()}/api/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gates: { classifier_review: 'the-intern' }, breaker_signals: [] }),
    });
    expect(res.status).toBe(400);
    expect(store.getPolicy().gates.classifier_review).toBe('human');
  });

  test('PUT /api/policy rejects a cross-origin write with 403', async () => {
    const res = await fetch(`${base()}/api/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ gates: { classifier_review: 'human' }, breaker_signals: [] }),
    });
    expect(res.status).toBe(403);
    expect(store.getPolicy().gates.classifier_review).toBe('human');
  });

  test('POST /api/sprint/start proposes the frontier and starts it — the click is the approval', async () => {
    await store.putTicket({
      id: 'TKT-0501',
      title: 'Frontier ticket',
      status: 'ready',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    const res = await fetch(`${base()}/api/sprint/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      started: boolean;
      sprint?: { id: string; tickets: string[] };
      proposal: { id: string; tickets: string[] };
      gate: { id: string; owner: string; status: string; decision?: string };
    };

    // The proposal is what went to the gate; the sprint is what the approval
    // then wrote.
    expect(body.proposal.id).toBe('S-1');
    expect(body.proposal.tickets).toEqual(['TKT-0501']);
    expect(body.started).toBe(true);
    expect(body.sprint?.id).toBe('S-1');
    expect(store.getSprint('S-1').tickets).toEqual(['TKT-0501']);
    expect(store.getTicket('TKT-0501').sprint).toBe('S-1');

    // The gate the design says sprint start means — raised, and resolved by
    // the click itself because policy owns it to the human.
    expect(body.gate.owner).toBe('human');
    expect(body.gate.status).toBe('resolved');
    expect(body.gate.decision).toBe('approve');
    // T121: no gate is opened at all any more.
    expect(gates.list()).toHaveLength(0);

    // The top bar now reads "running", and offers Sprint 2 next.
    const snap = (await (await fetch(`${base()}/api/snapshot`)).json()) as {
      status: {
        sprint_state: string;
        sprint_id: string;
        next_sprint_number: number;
        approve_plan_pending: boolean;
      };
    };
    expect(snap.status.sprint_state).toBe('running');
    expect(snap.status.sprint_id).toBe('S-1');
    expect(snap.status.next_sprint_number).toBe(2);
    expect(snap.status.approve_plan_pending).toBe(false);
  });

  // T121: the `approve_plan` gate is deleted (cockpit design §3.1), so a
  // policy edit can no longer park a sprint start on the EM — the click is
  // the approval. T122 deletes the Sprints pane and this route with it.
  test('POST /api/sprint/start refuses an empty frontier with 400 and a reason', async () => {
    const res = await fetch(`${base()}/api/sprint/start`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing is ready to start/);
    expect(store.listSprints()).toHaveLength(0);
    expect(gates.list()).toHaveLength(0);
  });

  test('POST /api/sprint/start rejects a cross-origin call with 403', async () => {
    const res = await fetch(`${base()}/api/sprint/start`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(store.listSprints()).toHaveLength(0);
  });
});
