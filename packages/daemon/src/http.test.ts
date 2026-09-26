import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type Event,
  type KnowledgeItem,
  type Policy,
  type RepoRemote,
  type RoutedEvent,
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
import { RoutedEventService } from './events';
import type { CockpitFrame, StreamPagePayload } from './feed';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService } from './inbox';
import { runInit } from './init';
import { KnowledgeService } from './knowledge';
import { ProjectService } from './projects';
import { QuestionService } from './questions';
import { type DirListing, RepoRemoteCache, StateStore } from './store';
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
      // T361: its agent never ran.
      never_started: true,
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

  test('T333: POST /api/streams/:id/move moves as human; strict body; a refusal is 400; cross-origin 403', async () => {
    const move = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/move`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const a = await streams.create('human', { title: 'a', goal: 'g' });
    const b = await streams.create('human', { title: 'b', goal: 'g', parent: a.id });
    const c = await streams.create('human', { title: 'c', goal: 'g', parent: a.id });
    expect((await move(c.id, { parent: b.id }, { origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect((await move(c.id, { parent: b.id, by: 'daemon' })).status).toBe(400);
    expect((await move(a.id, { parent: c.id })).status).toBe(400);
    const ok = await move(c.id, { parent: b.id });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { parent: string }).parent).toBe(b.id);
    expect(streams.readThread(b.id).entries.at(-1)).toMatchObject({
      by: 'human',
      body: `moved here: c (${c.id}) from a`,
    });
  });

  test('T365: POST /api/streams/:id/update renames as human; strict body; cross-origin 403', async () => {
    const update = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/update`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const node = await streams.create('human', { title: 'old name', goal: 'the goal' });
    expect(
      (await update(node.id, { title: 'new' }, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    // Only title and goal: no agent fields, no parent, no principal, and not nothing.
    expect((await update(node.id, { title: 'x', agent: { status: 'done' } })).status).toBe(400);
    expect((await update(node.id, { parent: node.id })).status).toBe(400);
    expect((await update(node.id, {})).status).toBe(400);
    expect((await update(node.id, { title: '   ' })).status).toBe(400);
    expect((await update('01ARZ3NDEKTSV4RRFFQ69G5FAV', { title: 'x' })).status).toBe(404);

    const res = await update(node.id, { title: '  Checkout flow  ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe('Checkout flow');
    expect(streams.get(node.id)).toMatchObject({ title: 'Checkout flow', goal: 'the goal' });
    expect(
      store
        .listEvents()
        .filter((e) => e.kind === 'stream_updated')
        .at(-1)?.data,
    ).toMatchObject({ principal: 'human' });
    await update(node.id, { goal: 'a sharper goal' });
    expect(streams.get(node.id)).toMatchObject({ title: 'Checkout flow', goal: 'a sharper goal' });
    const frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.streams.find((s) => s.id === node.id)?.title).toBe('Checkout flow');
  });

  test('T361: POST /api/streams/:id/archive and /unarchive delete and restore a subtree as human', async () => {
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(url(path), { method: 'POST', headers });
    const shop = await new ProjectService(store, streams).create({ name: 'Shop' });
    const a = await streams.create('human', { title: 'a', goal: 'g', project: shop.id });
    const b = await streams.create('human', { title: 'b', goal: 'g', parent: a.id });
    expect(
      (await post(`/api/streams/${a.id}/archive`, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    const root = await post(`/api/streams/${shop.root}/archive`);
    expect(root.status).toBe(400);
    expect(((await root.json()) as { error: string }).error).toContain(
      "a project root can't be deleted; archive the project instead",
    );

    const res = await post(`/api/streams/${a.id}/archive`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      node: { id: string };
      archived: string[];
      stopped: string[];
    };
    expect(body.node.id).toBe(a.id);
    expect(body.archived).toEqual([a.id, b.id]);
    expect(body.stopped).toEqual([]);
    expect(
      store
        .listEvents()
        .filter((e) => e.kind === 'stream_archived')
        .at(-1)?.data,
    ).toMatchObject({ principal: 'human', archived: true });
    let frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.streams.map((s) => s.id)).toEqual([shop.root]);
    // Only what Restore can bring back: `b` comes back with `a`.
    expect(frame.archived).toEqual([{ id: a.id, title: 'a', project: shop.id, parent: shop.root }]);
    expect((await post(`/api/streams/${b.id}/unarchive`)).status).toBe(400);

    const back = await post(`/api/streams/${a.id}/unarchive`);
    expect(back.status).toBe(200);
    expect(((await back.json()) as { restored: string[] }).restored).toEqual([a.id, b.id]);
    frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.streams.map((s) => s.id).sort()).toEqual([shop.root, a.id, b.id].sort());
    expect(frame.archived).toBeUndefined();
    expect((await post(`/api/streams/${a.id}/unarchive`)).status).toBe(400);
  });

  test('T361: Delete stops every live session in the subtree as a human detach', async () => {
    const a = await streams.create('human', { title: 'a', goal: 'g' });
    const b = await streams.create('human', { title: 'b', goal: 'g', parent: a.id });
    const c = await streams.create('human', { title: 'c', goal: 'g', parent: b.id });
    const calls: Array<[string, unknown, unknown]> = [];
    // A stand-in for `AttachService.stop`: `c` has a live session.
    const attach = {
      stop: async (id: string, role: unknown, opts: unknown) => {
        calls.push([id, role, opts]);
        return id === c.id ? ['S1'] : [];
      },
    } as unknown as AttachService;
    const server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      attach,
      feedPollIntervalMs: 20,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/streams/${b.id}/archive`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { stopped: string[] }).stopped).toEqual(['S1']);
      const expected: Array<[string, unknown, unknown]> = [
        [b.id, undefined, { detach: true }],
        [c.id, undefined, { detach: true }],
      ];
      expect(calls.sort()).toEqual(expected.sort());
      expect(streams.get(c.id).archived).toBe(true);
      expect(streams.get(a.id).archived).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test('T361: POST /api/streams/:id/say passes start through and replies started', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const seen: unknown[] = [];
    const attach = {
      say: async (id: string, body: string, opts: { start?: boolean }) => {
        seen.push(opts);
        return {
          entry: await streams.appendThread('human', id, { kind: 'line', body }),
          ...(opts.start ? { prompted: 'S1', started: true } : {}),
        };
      },
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
      const say = (body: unknown) =>
        fetch(`http://127.0.0.1:${server.port}/api/streams/${stream.id}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const started = await say({ body: 'go', start: true });
      expect(started.status).toBe(201);
      expect(await started.json()).toMatchObject({ prompted: 'S1', started: true });
      const plain = await say({ body: 'and again' });
      expect(((await plain.json()) as { started?: true }).started).toBeUndefined();
      expect((await say({ body: 'x', start: 'yes' })).status).toBe(400);
      expect(seen).toEqual([{ start: true }, {}]);
    } finally {
      await server.stop();
    }
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
    // T372: rename a project and change its repos; an unknown repo is refused.
    const renamed = await post(`/api/projects/${shop.id}`, { name: 'Shop', repos: [] });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { name: string }).name).toBe('Shop');
    expect((await post(`/api/projects/${shop.id}`, { name: 'shop' })).status).toBe(200);
    expect((await post(`/api/projects/${shop.id}`, { repos: ['nope'] })).status).toBe(400);
    // T379: the project's session defaults; the frame carries them; `null` clears them.
    const session = await post(`/api/projects/${shop.id}`, {
      session: { model: 'claude-haiku-4-5', effort: 'high' },
    });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { session?: unknown }).session).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
    });
    const withSession = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(withSession.projects[0]?.session).toEqual({ model: 'claude-haiku-4-5', effort: 'high' });
    expect(
      (await post(`/api/projects/${shop.id}`, { session: { effort: 'extreme' } })).status,
    ).toBe(400);
    expect((await post(`/api/projects/${shop.id}`, { session: null })).status).toBe(200);
    const cleared = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(cleared.projects[0]?.session).toBeUndefined();
    expect(
      (await post(`/api/projects/${shop.id}`, { name: 'x' }, { origin: 'http://evil.example' }))
        .status,
    ).toBe(403);

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
    // D33: a repo-less child (a tangent) leaves its parent a conversation.
    expect(roles[parent.id]).toEqual(['conversation', shop.id]);
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

  test('/ws delivers an event exactly once when it lands between tailer polls and the connect snapshot', async () => {
    // A slow poll so the event is on disk (and in a naive snapshot) before the
    // tailer's next poll publishes it to the now-subscribed socket.
    const slow = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      feedPollIntervalMs: 400,
    });
    const agentId = '01ARZ3NDEKTSV4RRFFQ69GE902';
    const seen: string[] = [];
    let snapshots = 0;
    await store.putAgent(agentId, {
      vendor: 'claude',
      model: 'claude-sonnet-4-5',
      last_seen: new Date().toISOString(),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${slow.port}/ws`);
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as {
        type: string;
        events?: Event[];
        event?: Event;
      };
      if (frame.type === 'snapshot') {
        snapshots++;
        for (const e of frame.events ?? []) if (e.agent === agentId) seen.push(e.kind);
      } else if (frame.type === 'event' && frame.event?.agent === agentId) {
        seen.push(frame.event.kind);
      }
    };
    try {
      const deadline = Date.now() + 5000;
      while (snapshots === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(snapshots).toBe(1);
      // Past two poll intervals: any duplicate publish has arrived by now.
      await Bun.sleep(1000);
      expect(seen).toEqual(['agent_put']);

      // And an event written after the connect still arrives, once.
      await store.putAgent(agentId, {
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        last_seen: new Date().toISOString(),
      });
      while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      await Bun.sleep(500);
      expect(seen).toEqual(['agent_put', 'agent_put']);
    } finally {
      ws.close();
      await slow.stop();
    }
  });
});

describe('T362 folder picker, clone by URL, repo remotes', () => {
  let scratch: string;
  let userHome: string;
  let store: StateStore;
  let stateRoot: string;
  let picker: HttpServerHandle;

  function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  }

  function repoAt(path: string): string {
    mkdirSync(path, { recursive: true });
    git(['init', '-q', '-b', 'main'], path);
    return path;
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'agile-http-picker-'));
    userHome = join(scratch, 'home');
    mkdirSync(join(userHome, 'Projects'), { recursive: true });
    stateRoot = runInit(join(scratch, 'agile-home')).stateRoot;
    store = StateStore.open(stateRoot);
    const streams = new StreamService(store);
    picker = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      feedPollIntervalMs: 20,
      userHome,
    });
  });

  afterEach(async () => {
    await picker.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  const url = (path: string) => `http://127.0.0.1:${picker.port}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test('GET /api/fs/dirs lists folders from home by default; same-origin and loopback Host only', async () => {
    repoAt(join(userHome, 'Projects', 'shop'));
    mkdirSync(join(userHome, 'Projects', 'notes'));
    const res = await fetch(url('/api/fs/dirs?path=~/Projects'));
    expect(res.status).toBe(200);
    const listing = (await res.json()) as DirListing;
    expect(listing).toEqual({
      path: join(userHome, 'Projects'),
      parent: userHome,
      home: userHome,
      is_git: false,
      entries: [
        { name: 'notes', path: join(userHome, 'Projects', 'notes'), git: false },
        { name: 'shop', path: join(userHome, 'Projects', 'shop'), git: true },
      ],
    });
    const byDefault = (await (await fetch(url('/api/fs/dirs'))).json()) as DirListing;
    expect(byDefault.path).toBe(userHome);
    const typed = (await (
      await fetch(
        url(`/api/fs/dirs?path=${encodeURIComponent(join(userHome, 'Projects'))}&prefix=SH`),
      )
    ).json()) as DirListing;
    expect(typed.entries.map((e) => e.name)).toEqual(['shop']);

    expect((await fetch(url('/api/fs/dirs?path=~/nope'))).status).toBe(404);
    const relative = await fetch(url('/api/fs/dirs?path=Projects'));
    expect(relative.status).toBe(400);
    expect(((await relative.json()) as { error: string }).error).toContain('must be absolute');
    const foreign = await fetch(url('/api/fs/dirs'), {
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.status).toBe(403);
    // A DNS-rebound page: same-origin to the browser, but its own name as Host.
    const rebound = await fetch(url('/api/fs/dirs'), {
      headers: { host: `evil.example:${picker.port}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(rebound.status).toBe(403);
    const localhost = await fetch(url('/api/fs/dirs'), {
      headers: { host: `localhost:${picker.port}` },
    });
    expect(localhost.status).toBe(200);
  });

  test('T378: POST /api/repos refuses a name taken by another folder; the same folder re-registers keeping its settings', async () => {
    const shop = repoAt(join(scratch, 'work', 'shop'));
    const other = repoAt(join(scratch, 'work', 'other'));
    expect((await post('/api/repos', { name: 'shop', path: shop })).status).toBe(200);
    await store.putRepos({
      ...store.getRepos(),
      shop: {
        ...(store.getRepos().shop as object),
        visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
      } as never,
    });
    const clash = await post('/api/repos', { name: 'shop', path: other });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toContain('already registered');
    expect(store.getRepos().shop?.path).toBe(realpathSync(shop));
    // The same folder (another spelling) re-registers and keeps what was set on it.
    const again = await post('/api/repos', {
      name: 'shop',
      path: `${shop}/`,
      protected_branches: ['main', 'release'],
    });
    expect(again.status).toBe(200);
    expect(store.getRepos().shop).toMatchObject({
      protected_branches: ['main', 'release'],
      visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
    });
  });

  test('POST /api/repos/clone clones a local bare repo, registers it, and its row says where it came from', async () => {
    const work = repoAt(join(scratch, 'work', 'shop'));
    writeFileSync(join(work, 'README.md'), 'hi\n');
    git(['add', '.'], work);
    git(
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'init',
      ],
      work,
    );
    const bare = join(scratch, 'remotes', 'shop.git');
    mkdirSync(join(scratch, 'remotes'));
    git(['clone', '-q', '--bare', work, bare], scratch);

    const foreign = await post(
      '/api/repos/clone',
      { url: bare },
      { origin: 'http://evil.example' },
    );
    expect(foreign.status).toBe(403);

    const res = await post('/api/repos/clone', { url: bare });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ name: string; path: string; remote?: RepoRemote }>;
      repo: string;
      path: string;
    };
    const dest = realpathSync(join(userHome, 'Projects', 'shop'));
    expect(body.repo).toBe('shop');
    expect(body.path).toBe(dest);
    expect(body.repos).toEqual([
      expect.objectContaining({
        name: 'shop',
        path: dest,
        remote: { kind: 'other', protocol: 'file', url: bare, name: 'shop' },
      }),
    ]);
    expect(store.listEvents().at(-1)).toMatchObject({ kind: 'repos_put', agent: 'human' });

    const again = await post('/api/repos/clone', { url: bare });
    expect(again.status).toBe(409);
    const bad = await post('/api/repos/clone', { url: 'ext::sh -c x' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('not a git URL');
  });

  test('GET /api/repos and the cockpit frame carry each repo remote; a local-only repo has none', async () => {
    const shop = repoAt(join(scratch, 'shop'));
    git(
      ['remote', 'add', 'origin', 'https://x-access-token:s3cr3t@github.com/acme/shop.git'],
      shop,
    );
    const scratchpad = repoAt(join(scratch, 'scratchpad'));
    expect((await post('/api/repos', { name: 'shop', path: shop })).status).toBe(200);
    expect((await post('/api/repos', { name: 'scratchpad', path: scratchpad })).status).toBe(200);

    const listed = (await (await fetch(url('/api/repos'))).json()) as {
      repos: Array<{ name: string; remote?: RepoRemote }>;
    };
    const github: RepoRemote = {
      kind: 'github',
      protocol: 'https',
      url: 'https://github.com/acme/shop.git',
      owner: 'acme',
      name: 'shop',
    };
    expect(listed.repos.find((r) => r.name === 'shop')?.remote).toEqual(github);
    expect(listed.repos.find((r) => r.name === 'scratchpad')?.remote).toBeUndefined();

    // The frame answers from the cache (warmed by the list above).
    const frame = (await (await fetch(url('/api/cockpit'))).json()) as CockpitFrame;
    expect(frame.repos).toEqual([
      { name: 'shop', delivery: 'direct', remote: github },
      { name: 'scratchpad', delivery: 'direct' },
    ]);
    expect(JSON.stringify(frame)).not.toContain('s3cr3t');
  });

  test('the frame never waits on git: a cold cache is read in the background and the frame re-pushed', async () => {
    const shop = repoAt(join(scratch, 'shop'));
    git(['remote', 'add', 'origin', 'git@gitlab.com:acme/shop.git'], shop);
    await store.addRepo('shop', { path: shop });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const remotes = new RepoRemoteCache({
      read: async () => {
        await gate;
        return 'git@gitlab.com:acme/shop.git';
      },
    });
    const cold = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams: new StreamService(store),
      feedPollIntervalMs: 20,
      repoRemotes: remotes,
    });
    const frames: CockpitFrame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${cold.port}/ws`);
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as { type: string };
      if (frame.type === 'cockpit') frames.push(frame as CockpitFrame);
    };
    try {
      const deadline = Date.now() + 5000;
      while (frames.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(frames[0]?.repos).toEqual([{ name: 'shop', delivery: 'direct' }]);
      release();
      while (frames.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(frames.at(-1)?.repos[0]?.remote).toMatchObject({ kind: 'gitlab', protocol: 'ssh' });
    } finally {
      ws.close();
      await cold.stop();
    }
  });

  test('/api/repos/clone is the settings of a registered repo named clone when the body has no url', async () => {
    const clone = repoAt(join(scratch, 'clone'));
    expect((await post('/api/repos', { name: 'clone', path: clone })).status).toBe(200);
    const res = await post('/api/repos/clone', { auto_merge: true });
    expect(res.status).toBe(200);
    expect(store.getRepos().clone?.auto_merge).toBe(true);
  });
});

// --- T383: the event log a page at a time ---

describe('T383 GET /api/events pages', () => {
  let home: string;
  let cockpit: HttpServerHandle;
  let events: RoutedEventService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-http-events-'));
    const init = runInit(home);
    const store = StateStore.open(init.stateRoot);
    events = new RoutedEventService(store);
    cockpit = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      events,
    });
  });

  afterEach(async () => {
    await cockpit.stop();
    rmSync(home, { recursive: true, force: true });
  });

  type Page = { events: RoutedEvent[]; more: boolean; total: number };
  const read = async (query = ''): Promise<{ status: number; body: Page & { error?: string } }> => {
    const res = await fetch(`http://127.0.0.1:${cockpit.port}/api/events${query}`);
    return { status: res.status, body: (await res.json()) as Page & { error?: string } };
  };
  const emit = (body: string, repo?: string) =>
    events.emit({
      type: 'human_line',
      subject: STREAM,
      payload: { body },
      by: 'human',
      routing: [{ node: STREAM, because: 'self' }],
      ...(repo !== undefined ? { repo } : {}),
    });

  test('pages newest first with before and limit until more is false', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await emit(`n${i}`)).id);
    const newest = [...ids].reverse();
    // No query: every event (up to 200), as before, with more and total.
    const all = await read();
    expect(all.status).toBe(200);
    expect(all.body.events.map((e) => e.id)).toEqual(newest);
    expect(all.body).toMatchObject({ more: false, total: 5 });

    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const { status, body } = await read(`?limit=2${before ? `&before=${before}` : ''}`);
      expect(status).toBe(200);
      expect(body.total).toBe(5);
      seen.push(...body.events.map((e) => e.id));
      pages += 1;
      if (!body.more) break;
      before = body.events.at(-1)?.id;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(newest);
    // Past the end of the log: an empty page, nothing more.
    expect((await read(`?before=${ids[0]}`)).body).toEqual({ events: [], more: false, total: 5 });
  });

  test("repo= reads one repo's events", async () => {
    const api = await emit('on api', 'api');
    await emit('on web', 'web');
    const { status, body } = await read('?repo=api&limit=5');
    expect(status).toBe(200);
    expect(body.events.map((e) => e.id)).toEqual([api.id]);
    expect(body).toMatchObject({ more: false, total: 1 });
    expect((await read('?repo=nope')).body).toEqual({ events: [], more: false, total: 0 });
  });

  test('a bad limit, an empty repo and an unknown cursor are 400s in words', async () => {
    await emit('hi');
    for (const limit of ['0', '-1', '2.5', 'ten', '501', '']) {
      const { status, body } = await read(`?limit=${limit}`);
      expect(status).toBe(400);
      expect(body.error).toContain('limit must be a whole number from 1 to 500');
    }
    expect((await read('?limit=500')).status).toBe(200);
    const unknown = await read('?before=E-nope');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe(
      'no event "E-nope" in the log: before must be the id of an event a page listed',
    );
    expect((await read('?before=')).body.error).toContain('before must be the id of an event');
    expect((await read('?repo=')).body.error).toContain('repo must be a repo name');
  });

  test('is 503 without the event service', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    expect(res.status).toBe(503);
  });
});
