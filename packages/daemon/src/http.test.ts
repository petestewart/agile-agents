import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type KnowledgeItem,
  type Policy,
  type SessionDefaultsStatus,
  classifierQuestion,
  examplesOf,
  patternOf,
  ulid,
  validateClassifierConfig,
} from '@agile-agents/shared';
import { type AttachService, resolveSessionSettings } from './attach';
import { Bus } from './bus';
import { ClassifierKeyService, FakeClassifier } from './classifier';
import { readHomeConfigFile } from './config';
import type { CockpitFrame, StreamPagePayload } from './feed';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService } from './inbox';
import { runInit } from './init';
import { KnowledgeService } from './knowledge';
import { ProjectService } from './projects';
import { QuestionService } from './questions';
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
  let rules: KnowledgeService;
  let stateRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-http-cockpit-'));
    const init = runInit(home);
    stateRoot = init.stateRoot;
    store = StateStore.open(init.stateRoot);
    streams = new StreamService(store);
    questions = new QuestionService(store, streams);
    const gates = new GateService(store);
    rules = new KnowledgeService({ store, streams });
    cockpit = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      streams,
      projects: new ProjectService(store, streams),
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
    await questions.raise({
      stream: leaf.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'which one?',
    });
    const frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.type).toBe('cockpit');
    const row = frame.streams.find((s) => s.id === leaf.id);
    expect(row).toEqual({
      id: leaf.id,
      title: 'leaf',
      parent: root.id,
      role: 'conversation',
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
    expect(store.getKnowledge(rule.id).status).toBe('accepted');
    expect(store.getKnowledge(rule.id).decided_by).toBe('human');
    const again = await fetch(url(`/api/rules/${rule.id}/accept`), { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await fetch(url('/api/rules/nope/retire'), { method: 'POST' })).status).toBe(400);
  });

  test('T163: GET /api/rules lists every rule with the pruning report; evals unavailable without a classifier', async () => {
    const rule = await rules.create('human', { text: 'use the repo scripts' });
    const res = await fetch(url('/api/rules'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rules: KnowledgeItem[];
      report: { rows: Array<{ id: string; flag: string }> };
      evals: { available: boolean };
    };
    expect(body.rules.map((r) => r.id)).toEqual([rule.id]);
    expect(body.report.rows.map((r) => r.id)).toEqual([rule.id]);
    expect(body.evals).toEqual({ available: false });
    const test = await fetch(url('/api/rules/test'), {
      method: 'POST',
      body: JSON.stringify({ id: rule.id }),
    });
    expect(test.status).toBe(503);
  });

  test('T163: POST /api/rules/:id/update edits as human through the strict patch schema; cross-origin is 403', async () => {
    const rule = await rules.create('agent', { text: 'no new deps', enforcement: 'action' });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/rules/${rule.id}/update`), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    expect((await post({ text: 'x' }, { origin: 'http://evil.example' })).status).toBe(403);
    // Not in the patch schema: a decision, the source, an unknown key.
    expect((await post({ status: 'accepted' })).status).toBe(400);
    expect((await post({ provenance: { by: 'human' } })).status).toBe(400);
    expect((await post({ source: { by: 'human' } })).status).toBe(400);
    expect((await post({ confidence: 0.5 })).status).toBe(400);
    expect(
      (await post({ check: { by: 'classifier', criteria: { true: 'adds one' } } })).status,
    ).toBe(400);
    const ok = await post({
      enforcement: 'ship',
      check: {
        by: 'classifier',
        question: 'Does this action add a dependency?',
        criteria: { true: 'a package is added', false: 'no package is added' },
        examples: [
          { action: 'bun add lodash', violates: true },
          { action: 'edit src/a.ts', violates: false },
        ],
      },
    });
    expect(ok.status).toBe(200);
    const saved = store.getKnowledge(rule.id);
    expect(classifierQuestion(saved)).toBe('Does this action add a dependency?');
    expect(saved.check).toMatchObject({
      criteria: { true: 'a package is added', false: 'no package is added' },
    });
    expect(saved.enforcement).toBe('ship');
    expect(examplesOf(saved)).toHaveLength(2);
    expect(saved.status).toBe('proposed');
    expect(
      (await fetch(url(`/api/rules/K-${ulid()}/update`), { method: 'POST', body: '{}' })).status,
    ).toBe(404);
  });

  test("T163: POST /api/rules/test runs one rule's examples through the classifier", async () => {
    const withEvals = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      rules,
      ruleEvals: {
        classifier: new FakeClassifier((state, questions) =>
          questions.map((q) => ({
            id: q.id,
            probability: state.startsWith('bun add') ? 0.95 : 0.05,
          })),
        ),
        bands: { deny_at: DEFAULT_CLASSIFIER_DENY_AT, allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW },
        timeout_ms: 1234,
      },
    });
    try {
      const at = (path: string) => `http://127.0.0.1:${withEvals.port}${path}`;
      const rule = await rules.create('human', {
        text: 'no new deps',
        enforcement: 'action',
        check: {
          by: 'classifier',
          examples: [
            { action: 'bun add lodash', violates: true },
            { action: 'edit src/a.ts', violates: false },
          ],
        },
      });
      const listed = (await (await fetch(at('/api/rules'))).json()) as { evals: unknown };
      expect(listed.evals).toEqual({ available: true, timeout_ms: 1234 });
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(at('/api/rules/test'), { method: 'POST', headers, body: JSON.stringify(body) });
      // A proposal is not a gate: only accepted rules are evaluated.
      expect((await post({ id: rule.id })).status).toBe(400);
      await rules.accept(rule.id, 'human');
      expect((await post({ id: rule.id }, { origin: 'http://evil.example' })).status).toBe(403);
      expect((await post({ id: rule.id, extra: true })).status).toBe(400);
      const res = await post({ id: rule.id });
      expect(res.status).toBe(200);
      const report = (await res.json()) as {
        agreed: number;
        rules: Array<{ examples: Array<{ band: string; agree: boolean }> }>;
      };
      expect(report.agreed).toBe(2);
      expect(report.rules[0]?.examples.map((e) => e.band)).toEqual(['deny', 'allow']);
      // An eval is not a firing.
      expect(store.getKnowledge(rule.id).stats.fired).toBe(0);
    } finally {
      await withEvals.stop();
    }
  });

  test('T167: POST /api/rules creates a proposal as human through the strict create schema', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/rules'), { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ text: 'x' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ text: 'x', status: 'accepted' })).status).toBe(400);
    expect((await post({ text: 'x', provenance: { by: 'agent' } })).status).toBe(400);
    const shipPattern = await post({
      text: 'x',
      enforcement: 'ship',
      check: { by: 'pattern', pattern: { kind: 'no_push' } },
    });
    expect(shipPattern.status).toBe(400);
    expect(((await shipPattern.json()) as { error: string }).error).toContain(
      'a pattern check is an action check only',
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ action: `a${i}`, violates: false }));
    expect(
      (
        await post({
          text: 'x',
          enforcement: 'ship',
          check: { by: 'classifier', examples: tooMany },
        })
      ).status,
    ).toBe(400);
    const ok = await post({
      text: 'never wipe build output',
      enforcement: 'action',
      check: { by: 'pattern', pattern: { kind: 'command_deny', args: { patterns: ['rm -rf'] } } },
      scope: { kind: 'global' },
    });
    expect(ok.status).toBe(200);
    const rule = (await ok.json()) as KnowledgeItem;
    expect(rule.status).toBe('proposed');
    expect(store.getKnowledge(rule.id).source.by).toBe('human');
    expect(patternOf(store.getKnowledge(rule.id))).toEqual({
      kind: 'command_deny',
      args: { patterns: ['rm -rf'] },
    });
  });

  test('T167: the classifier key is write-only — saved live, never in a response or an event', async () => {
    const fakeKey = 'fake-t167-http-key-zz99';
    const config = validateClassifierConfig({});
    const classifierKey = new ClassifierKeyService({ config, store, env: {} });
    const server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      rules,
      classifierKey,
      ruleEvals: {
        classifier: new FakeClassifier(),
        bands: { deny_at: DEFAULT_CLASSIFIER_DENY_AT, allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW },
      },
    });
    try {
      const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
      const bodies: string[] = [];
      const read = async (res: Response) => {
        const text = await res.text();
        bodies.push(text);
        return text;
      };
      const evals = async () =>
        (JSON.parse(await read(await fetch(at('/api/rules')))) as { evals: { available: boolean } })
          .evals.available;
      expect(JSON.parse(await read(await fetch(at('/api/settings/classifier'))))).toMatchObject({
        source: 'none',
        loaded: false,
      });
      expect(await evals()).toBe(false);
      const save = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(at('/api/settings/classifier/key'), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      expect((await save({ api_key: fakeKey }, { origin: 'http://evil.example' })).status).toBe(
        403,
      );
      const bad = await save({ api_key: fakeKey, extra: 1 });
      expect(bad.status).toBe(400);
      await read(bad);
      const saved = await save({ api_key: fakeKey });
      expect(saved.status).toBe(200);
      expect(JSON.parse(await read(saved))).toMatchObject({ source: 'config', loaded: true });
      expect(config.api_key).toBe(fakeKey);
      expect(await evals()).toBe(true);
      expect(readFileSync(join(stateRoot, 'config.yaml'), 'utf8')).toContain(fakeKey);
      const removed = await fetch(at('/api/settings/classifier/key/remove'), { method: 'POST' });
      expect(JSON.parse(await read(removed))).toMatchObject({ source: 'none', loaded: false });
      expect(config.api_key).toBeUndefined();
      expect(await evals()).toBe(false);
      expect(readFileSync(join(stateRoot, 'config.yaml'), 'utf8')).not.toContain(fakeKey);
      for (const body of bodies) expect(body).not.toContain(fakeKey);
      expect(readFileSync(join(stateRoot, 'log', 'events.jsonl'), 'utf8')).not.toContain(fakeKey);
      expect(store.listEvents().some((e) => e.kind === 'home_config_put')).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('T326: tracker settings — same-origin writes stamped human; no route ever returns a token', async () => {
    const jiraToken = 'jira-token-T326-never-echoed';
    const linearToken = 'lin_api_T326_never_echoed';
    const bodies: string[] = [];
    const post = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(url('/api/settings/trackers'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      bodies.push(await res.clone().text());
      return res;
    };
    const read = async () => {
      const text = await (await fetch(url('/api/settings/trackers'))).text();
      bodies.push(text);
      return JSON.parse(text);
    };

    expect(await read()).toEqual({ jira: { token_set: false }, linear: { token_set: false } });
    // Cross-origin is refused before anything is written.
    const cross = await post(
      { system: 'linear', token: linearToken },
      { origin: 'http://evil.example' },
    );
    expect(cross.status).toBe(403);
    expect((await read()).linear.token_set).toBe(false);
    // Strict body; linear takes no base URL; jira's first token needs one.
    expect((await post({ system: 'linear', token: linearToken, extra: 1 })).status).toBe(400);
    expect(
      (await post({ system: 'linear', token: linearToken, base_url: 'https://x.example' })).status,
    ).toBe(400);
    expect((await post({ system: 'github', token: linearToken })).status).toBe(400);
    const noBase = await post({ system: 'jira', token: jiraToken });
    expect(noBase.status).toBe(400);
    expect(((await noBase.json()) as { error: string }).error).toContain('base URL');

    const jira = await post({
      system: 'jira',
      base_url: 'https://shop.atlassian.net',
      email: 'pete@example.com',
      token: jiraToken,
    });
    expect(jira.status).toBe(200);
    expect(await jira.json()).toEqual({
      jira: { token_set: true, base_url: 'https://shop.atlassian.net', email: 'pete@example.com' },
      linear: { token_set: false },
    });
    expect((await post({ system: 'linear', token: linearToken })).status).toBe(200);
    expect((await read()).linear.token_set).toBe(true);
    const onDisk = readFileSync(join(stateRoot, 'config.yaml'), 'utf8');
    expect(onDisk).toContain(jiraToken);
    expect(onDisk).toContain(linearToken);
    expect(readHomeConfigFile(stateRoot).trackers?.jira?.email).toBe('pete@example.com');

    // Email removed with null; clearing a token leaves the base URL.
    expect((await post({ system: 'jira', email: null })).status).toBe(200);
    const cleared = await post({ system: 'jira', token: null });
    expect(await cleared.json()).toEqual({
      jira: { token_set: false, base_url: 'https://shop.atlassian.net' },
      linear: { token_set: true },
    });
    expect(readFileSync(join(stateRoot, 'config.yaml'), 'utf8')).not.toContain(jiraToken);

    for (const body of bodies) {
      expect(body).not.toContain(jiraToken);
      expect(body).not.toContain(linearToken);
    }
    const events = readFileSync(join(stateRoot, 'log', 'events.jsonl'), 'utf8');
    expect(events).not.toContain(jiraToken);
    expect(events).not.toContain(linearToken);
    const puts = store.listEvents().filter((e) => e.kind === 'home_config_put');
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((e) => e.agent === 'human')).toBe(true);
  });

  test('T170: session defaults — read every step, write home and repo through the store, stamped human', async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(path), { method: 'POST', headers, body: JSON.stringify(body) });
    const read = async () =>
      (await (await fetch(url('/api/settings/session'))).json()) as SessionDefaultsStatus;

    const before = await read();
    expect(before.builtin).toEqual({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' });
    expect(before.resolved).toEqual(before.builtin);
    expect(before.known_models.claude).toContain('claude-opus-5-5');

    // Same-origin only, strict body, known vendors, the effort enum.
    expect(
      (await post('/api/settings/session', { effort: 'high' }, { origin: 'http://evil.example' }))
        .status,
    ).toBe(403);
    expect((await post('/api/settings/session', { effort: 'extreme' })).status).toBe(400);
    expect((await post('/api/settings/session', { vendor: 'hal9000' })).status).toBe(400);
    expect((await post('/api/settings/session', { effort: 'high', extra: 1 })).status).toBe(400);

    const saved = await post('/api/settings/session', { model: 'sonnet', effort: 'high' });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SessionDefaultsStatus).resolved).toEqual({
      vendor: 'claude',
      model: 'sonnet',
      effort: 'high',
    });
    // The next attach reads the file: no restart.
    expect(resolveSessionSettings({ home: readHomeConfigFile(stateRoot) })).toMatchObject({
      model: 'sonnet',
      effort: 'high',
    });
    const homeEvent = store
      .listEvents()
      .filter((e) => e.kind === 'home_config_put')
      .at(-1);
    expect(homeEvent?.agent).toBe('human');

    // A repo's own model/effort; null clears a field back to the next step.
    await store.addRepo('demo', { path: '/tmp/demo-t170' });
    expect((await post('/api/settings/session/repos/nope', { model: 'opus' })).status).toBe(404);
    expect(
      (
        await post(
          '/api/settings/session/repos/demo',
          { model: 'opus' },
          { origin: 'http://evil.example' },
        )
      ).status,
    ).toBe(403);
    const repoSaved = await post('/api/settings/session/repos/demo', {
      model: 'opus',
      effort: 'max',
    });
    expect(repoSaved.status).toBe(200);
    const status = (await repoSaved.json()) as SessionDefaultsStatus;
    expect(status.repos.demo).toMatchObject({
      model: 'opus',
      effort: 'max',
      resolved: { vendor: 'claude', model: 'opus', effort: 'max' },
    });
    expect(store.getRepos().demo?.path).toBe('/tmp/demo-t170');
    const repoEvent = store
      .listEvents()
      .filter((e) => e.kind === 'repos_put')
      .at(-1);
    expect(repoEvent?.agent).toBe('human');

    const cleared = await post('/api/settings/session', { model: null, effort: null });
    expect(((await cleared.json()) as SessionDefaultsStatus).resolved).toEqual(before.builtin);
    expect(store.getHomeConfig().default_model).toBeUndefined();
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
      scope: { kind: 'subtree', node: root.id },
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

  test('T169: a say prompted into the asking session answers its open question as human', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const session = ulid();
    const q = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session,
      text: 'comma or semicolon?',
    });
    // A stand-in for `AttachService.say`: the line, prompted into `session`.
    const attach = {
      say: async (id: string, body: string) => ({
        entry: await streams.appendThread('human', id, { kind: 'line', body }),
        prompted: session,
      }),
    } as unknown as AttachService;
    const server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      questions,
      attach,
      feedPollIntervalMs: 20,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/streams/${stream.id}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'semicolons' }),
      });
      expect(res.status).toBe(201);
      const after = questions.get(q.id);
      expect(after.status).toBe('answered');
      expect(after.answered_by).toBe('human');
      expect(after.answer).toContain('semicolons');
    } finally {
      await server.stop();
    }
  });

  test('T162/T208: POST /api/streams creates a stream stamped human, in a project; strict body; unknown parent 400; cross-origin 403', async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const shopRes = await post('/api/projects', { name: 'shop' });
    expect(shopRes.status).toBe(201);
    const shop = (await shopRes.json()) as { id: string; root: string };
    expect((await post('/api/projects', { name: 'shop' })).status).toBe(400);
    expect(
      (await post('/api/projects', { name: 'x' }, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    const listed = (await (await fetch(url('/api/projects'))).json()) as Array<{ id: string }>;
    expect(listed.map((p) => p.id)).toEqual([shop.id]);

    const s = (body: Record<string, unknown>, headers?: Record<string, string>) =>
      post('/api/streams', body, headers);
    expect(
      (await s({ title: 't', goal: 'g', project: shop.id }, { origin: 'http://evil.example' }))
        .status,
    ).toBe(403);
    expect((await s({ title: 't', goal: 'g', project: shop.id, by: 'daemon' })).status).toBe(400);
    expect((await s({ title: 't', goal: 'g', parent: ulid() })).status).toBe(400);
    expect((await s({ title: 't', goal: 'g', project: shop.id, repo: 'nope' })).status).toBe(400);
    // No project, and no parent that carries one: refused.
    const noProject = await s({ title: 't', goal: 'g' });
    expect(noProject.status).toBe(400);
    expect(((await noProject.json()) as { error: string }).error).toContain('project');

    const top = await s({ title: 'top', goal: 'g', project: shop.id });
    expect(top.status).toBe(201);
    const parent = (await top.json()) as { id: string; parent?: string; project?: string };
    expect(parent.parent).toBe(shop.root);
    expect(parent.project).toBe(shop.id);
    // A parent in the project is enough: the project is inherited.
    const res = await s({ title: 'child', goal: 'g', parent: parent.id });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      parent?: string;
      repo?: string;
      project?: string;
    };
    expect(created.parent).toBe(parent.id);
    expect(created.project).toBe(shop.id);
    expect(created.repo).toBeUndefined();
    const entries = streams.readThread(created.id).entries;
    expect(entries.map((e) => [e.by, e.kind])).toEqual([['human', 'event']]);

    const frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.projects).toEqual([
      {
        id: shop.id,
        name: 'shop',
        root: shop.root,
        autonomy: { coordinator: 'advise', director: 'advise' },
        repos: [],
      },
    ]);
    const roles = Object.fromEntries(frame.streams.map((r) => [r.id, [r.role, r.project]]));
    expect(roles[shop.root]).toEqual(['project', shop.id]);
    expect(roles[parent.id]).toEqual(['coordinating', shop.id]);
    expect(roles[created.id]).toEqual(['conversation', shop.id]);
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
      const question = await questions.raise({
        stream: stream.id,
        raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
        text: 'q?',
      });
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
