import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Policy, ulid } from '@agile-agents/shared';
import { Bus } from './bus';
import type { CockpitFrame, StreamPagePayload } from './feed';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService } from './inbox';
import { runInit } from './init';
import { QuestionService } from './questions';
import { RulesService } from './rules';
import { StateStore } from './store';
import { StreamService } from './streams';

// T121: gates are raised on a stream; the HIL routes only need an id, the
// question routes need a real one (the questions suite creates it).
const STREAM = ulid();

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

// --- Tests against a real .agile/ state root (T020: snapshot, live tail, HIL actions) ---

// --- T025 control room reads/writes (verify-before-build inventory found
// none of these endpoints existed before this ticket — every one below is a
// GET backed by an existing StateStore getter, or a POST/DELETE through an
// existing daemon verb: createHalt/releaseHalt, Bus.send). ---

// --- T045: Jira two-way sync link/unlink actions (§17 v2 Tickets pane) ---

// --- T040 questions routes (§17 "Control room v2" -> "Questions vs Decisions") ---

/**
 * T043 — the Settings screen's write path and the top bar's single action.
 * §17 journey step 4 ("This is `policy.yaml`'s gates block with a face") and
 * §17 v2.
 */

// --- T160 cockpit routes: the stream tree + inbox frame, rule decisions,
// the policy read, and the pushed `{type:'cockpit'}` frame. ---

describe('T160 cockpit routes', () => {
  let home: string;
  let cockpit: HttpServerHandle;
  let store: StateStore;
  let streams: StreamService;
  let questions: QuestionService;
  let rules: RulesService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-http-cockpit-'));
    const init = runInit(home);
    store = StateStore.open(init.stateRoot);
    streams = new StreamService(store);
    questions = new QuestionService(store, streams);
    const gates = new GateService(store);
    rules = new RulesService({ store, streams });
    cockpit = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      streams,
      questions,
      rules,
      inbox: new InboxService({ streams, questions, gates, rules }),
      feedPollIntervalMs: 20,
    });
  });

  afterEach(async () => {
    await cockpit.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const url = (path: string) => `http://127.0.0.1:${cockpit.port}${path}`;

  test('GET /api/cockpit carries the tree rows with their status pair and the inbox', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const leaf = await streams.create('human', { title: 'leaf', goal: 'g', parent: root.id });
    await questions.raise({ stream: leaf.id, raised_by: 'eng-1', text: 'which one?' });
    const frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.type).toBe('cockpit');
    const row = frame.streams.find((s) => s.id === leaf.id);
    expect(row).toEqual({
      id: leaf.id,
      title: 'leaf',
      parent: root.id,
      agent_status: 'question',
      human_status: 'waiting_on_you',
    });
    expect(frame.inbox.map((i) => i.stream_path)).toEqual([['root', 'leaf']]);
  });

  test('POST /api/rules/:id/accept decides as human; a second accept is 409; cross-origin is 403', async () => {
    const rule = await rules.create('agent', { text: 'use the repo scripts' });
    const foreign = await fetch(url(`/api/rules/${rule.id}/accept`), {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const ok = await fetch(url(`/api/rules/${rule.id}/accept`), { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(store.getRule(rule.id).status).toBe('accepted');
    expect(store.getRule(rule.id).decided_by).toBe('human');
    const again = await fetch(url(`/api/rules/${rule.id}/accept`), { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await fetch(url('/api/rules/nope/retire'), { method: 'POST' })).status).toBe(400);
  });

  test('POST /api/streams/:id/land without a landing service is 503', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    expect((await fetch(url(`/api/streams/${stream.id}/land`), { method: 'POST' })).status).toBe(
      503,
    );
  });

  test('T161: GET /api/streams/:id is the stream page read — record, path, thread, rules in scope', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const leaf = await streams.create('human', { title: 'leaf', goal: 'g', parent: root.id });
    await streams.appendThread('daemon', leaf.id, { kind: 'event', body: 'created' });
    const rule = await rules.create('human', {
      text: 'never push to main',
      scope: { kind: 'stream', ref: root.id },
    });
    await rules.accept(rule.id, 'human');
    const res = await fetch(url(`/api/streams/${leaf.id}`));
    expect(res.status).toBe(200);
    const page = (await res.json()) as StreamPagePayload;
    expect(page.stream.id).toBe(leaf.id);
    expect(page.path).toEqual(['root', 'leaf']);
    expect(page.thread.at(-1)?.body).toBe('created');
    expect(page.thread_total).toBe(page.thread.length);
    // Inherited from the ancestor: exactly `rulesInScope(stream)`.
    expect(page.rules.map((r) => r.id)).toEqual([rule.id]);
    expect(page.docs).toEqual([]);
    expect((await fetch(url(`/api/streams/${ulid()}`))).status).toBe(404);
    expect((await fetch(url('/api/streams/nope'))).status).toBe(400);
  });

  test('T161: POST /api/streams/:id/say writes a human line; the actor is never read from the body; cross-origin is 403', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const foreign = await fetch(url(`/api/streams/${stream.id}/say`), {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(foreign.status).toBe(403);
    const forged = await fetch(url(`/api/streams/${stream.id}/say`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello', by: 'daemon' }),
    });
    expect(forged.status).toBe(400);
    const ok = await fetch(url(`/api/streams/${stream.id}/say`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'use semicolons' }),
    });
    expect(ok.status).toBe(201);
    const entries = streams.readThread(stream.id).entries;
    expect(entries.filter((e) => e.kind === 'line').map((e) => [e.by, e.body])).toEqual([
      ['human', 'use semicolons'],
    ]);
    const long = await fetch(url(`/api/streams/${stream.id}/say`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(801) }),
    });
    expect(long.status).toBe(400);
  });

  test('T162: POST /api/streams creates a stream stamped human; strict body; unknown parent 400; cross-origin 403', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/streams'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post({ title: 't', goal: 'g' }, { origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect((await post({ title: 't', goal: 'g', by: 'daemon' })).status).toBe(400);
    expect((await post({ title: 't', goal: 'g', parent: ulid() })).status).toBe(400);
    expect((await post({ title: 't', goal: 'g', repo: 'nope' })).status).toBe(400);
    const parent = await streams.create('human', { title: 'p', goal: 'g' });
    const res = await post({ title: 'child', goal: 'g', parent: parent.id });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; parent?: string; repo?: string };
    expect(created.parent).toBe(parent.id);
    expect(created.repo).toBeUndefined();
    const entries = streams.readThread(created.id).entries;
    expect(entries.map((e) => [e.by, e.kind])).toEqual([['human', 'event']]);
  });

  test('T161: attach/stop without an attach service are 503, and are same-origin only', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    for (const action of ['attach', 'stop']) {
      const foreign = await fetch(url(`/api/streams/${stream.id}/${action}`), {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(foreign.status).toBe(403);
      expect(
        (await fetch(url(`/api/streams/${stream.id}/${action}`), { method: 'POST' })).status,
      ).toBe(503);
    }
    expect((await fetch(url(`/api/streams/${stream.id}/diff`))).status).toBe(503);
  });

  test('GET /api/policy returns the gates block', async () => {
    const policy = (await (await fetch(url('/api/policy'))).json()) as Policy;
    expect(Object.keys(policy.gates).sort()).toEqual(['classifier_review', 'land', 'rule_accept']);
  });

  test('/ws sends a cockpit frame on connect and pushes a fresh one when a question is raised', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const frames: CockpitFrame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${cockpit.port}/ws`);
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as { type: string };
      if (frame.type === 'cockpit') frames.push(frame as CockpitFrame);
    };
    try {
      const deadline = Date.now() + 5000;
      while (frames.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(frames[0]?.inbox).toEqual([]);
      const question = await questions.raise({ stream: stream.id, raised_by: 'eng-1', text: 'q?' });
      while (
        !frames.some((f) => f.inbox.some((i) => i.id === question.id)) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      const pushed = frames.find((f) => f.inbox.some((i) => i.id === question.id));
      expect(pushed?.streams.find((s) => s.id === stream.id)?.human_status).toBe('waiting_on_you');
    } finally {
      ws.close();
    }
  });
});
