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
  type SessionVendor,
  type Stream,
  type VendorFailureSettings,
  type VendorModels,
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
import { DirectorService } from './director';
import { RoutedEventService } from './events';
import type { CockpitFrame, StepPage, StreamPagePayload } from './feed';
import { GateService } from './gates';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService } from './inbox';
import { runInit } from './init';
import { KnowledgeService } from './knowledge';
import { ProjectService } from './projects';
import { QuestionService } from './questions';
import { type DirListing, RepoRemoteCache, StateStore } from './store';
import { buildEvent } from './store/events';
import { StreamService, TitleNamer } from './streams';

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
      // T395: its last change: here the question's status change and thread line.
      updated_at: expect.any(String),
    });
    expect((row?.updated_at ?? '') >= leaf.created_at).toBe(true);
    expect(row?.updated_at).toBe(
      [streams.get(leaf.id).agent.updated_at, streams.readThread(leaf.id).entries.at(-1)?.ts ?? '']
        .sort()
        .at(-1),
    );
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

  test('T437: the session defaults say which vendors are not installed', async () => {
    const withCheck = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      vendorMissing: (vendor) =>
        vendor === 'gemini'
          ? "Gemini CLI can't start: `gemini` is not on the daemon's PATH."
          : undefined,
    });
    try {
      const status = (await (
        await fetch(`http://127.0.0.1:${withCheck.port}/api/settings/session`)
      ).json()) as SessionDefaultsStatus;
      expect(status.not_installed).toEqual({
        gemini: "Gemini CLI can't start: `gemini` is not on the daemon's PATH.",
      });
    } finally {
      await withCheck.stop();
    }
    // Without the check (an older daemon, or tests), nothing is said.
    const plain = (await (
      await fetch(url('/api/settings/session'))
    ).json()) as SessionDefaultsStatus;
    expect(plain.not_installed).toBeUndefined();
  });

  test("T467: the session defaults carry each vendor's own models; Refresh asks a vendor, same-origin only", async () => {
    const lists: Partial<Record<SessionVendor, VendorModels>> = {};
    const refreshed: string[] = [];
    const withModels = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      vendorMissing: (vendor) => (vendor === 'pi' ? 'Pi is not installed' : undefined),
      models: {
        all: () => lists,
        refresh: async (vendor) => {
          refreshed.push(vendor);
          if (vendor === 'grok') throw new Error('Grok CLI did not open a session: login needed');
          lists[vendor] = {
            options: [{ value: 'grok-4.7[fast=true]', name: 'grok-4.7' }],
            current: 'default[]',
            at: '2026-09-29T10:50:46.021Z',
          };
          return lists[vendor];
        },
      },
    });
    const at = (path: string) => `http://127.0.0.1:${withModels.port}${path}`;
    const refresh = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(at('/api/settings/models/refresh'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    try {
      const before = (await (
        await fetch(at('/api/settings/session'))
      ).json()) as SessionDefaultsStatus;
      expect(before.vendor_models).toEqual({});
      // Built in still: the fallback list for a vendor that never reported one.
      expect(before.known_models.claude).toContain('claude-opus-5-5');

      expect((await refresh({ vendor: 'cursor' }, { origin: 'http://evil.example' })).status).toBe(
        403,
      );
      expect((await refresh({ vendor: 'hal9000' })).status).toBe(400);
      expect((await refresh({ vendor: 'cursor', extra: 1 })).status).toBe(400);
      // Not installed: said, and nothing spawned.
      const missing = await refresh({ vendor: 'pi' });
      expect(missing.status).toBe(409);
      expect(((await missing.json()) as { error: string }).error).toBe('Pi is not installed');
      const failed = await refresh({ vendor: 'grok' });
      expect(failed.status).toBe(502);
      expect(((await failed.json()) as { error: string }).error).toContain('login needed');
      expect(refreshed).toEqual(['grok']);

      const ok = await refresh({ vendor: 'cursor' });
      expect(ok.status).toBe(200);
      const after = (await ok.json()) as SessionDefaultsStatus & {
        refreshed: { vendor: string; listed: boolean };
      };
      expect(after.refreshed).toEqual({ vendor: 'cursor', listed: true });
      expect(after.vendor_models?.cursor?.options[0]).toEqual({
        value: 'grok-4.7[fast=true]',
        name: 'grok-4.7',
      });
    } finally {
      await withModels.stop();
    }
    // A daemon with no catalog says nothing about vendor models, and refuses a Refresh.
    const plain = (await (
      await fetch(url('/api/settings/session'))
    ).json()) as SessionDefaultsStatus;
    expect(plain.vendor_models).toBeUndefined();
    expect(
      (
        await fetch(url('/api/settings/models/refresh'), {
          method: 'POST',
          body: JSON.stringify({ vendor: 'cursor' }),
        })
      ).status,
    ).toBe(503);
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

  test('T456: the crash settings are written whole, home and repo, and read back', async () => {
    const post = (path: string, body: unknown) =>
      fetch(url(path), { method: 'POST', body: JSON.stringify(body) });
    const block: VendorFailureSettings = {
      retry: false,
      fallback: ['gemini', 'cursor'],
      allow_hookless: true,
    };
    expect(
      (await post('/api/settings/session', { vendor_failure: { fallback: ['hal'] } })).status,
    ).toBe(400);
    const saved = (await (
      await post('/api/settings/session', { vendor_failure: block })
    ).json()) as SessionDefaultsStatus;
    expect(saved.home.vendor_failure).toEqual(block);
    expect(store.getHomeConfig().vendor_failure).toEqual(block);
    // A partial block replaces the whole one.
    await post('/api/settings/session', { vendor_failure: { retry: true } });
    expect(store.getHomeConfig().vendor_failure).toEqual({ retry: true });

    await store.addRepo('demo', { path: '/tmp/demo-t456' });
    const repo = (await (
      await post('/api/settings/session/repos/demo', { vendor_failure: { fallback: [] } })
    ).json()) as SessionDefaultsStatus;
    expect(repo.repos.demo?.vendor_failure).toEqual({ fallback: [] });
    // `null` (or an empty block) removes it: back to the next step.
    await post('/api/settings/session', { vendor_failure: null });
    await post('/api/settings/session/repos/demo', { vendor_failure: {} });
    expect(store.getHomeConfig().vendor_failure).toBeUndefined();
    expect(store.getRepos().demo?.vendor_failure).toBeUndefined();
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

  test("T392: GET /api/streams/:id/steps is the node's tool calls, one per call, newest first", async () => {
    const node = await streams.create('human', { title: 'n', goal: 'g' });
    const other = await streams.create('human', { title: 'o', goal: 'g' });
    const toolCall = (stream: string, data: Record<string, unknown>, session = 'S-1') =>
      store.appendEvent(buildEvent('tool_call', { agent: session, data: { stream, ...data } }));
    const read = async (id: string) => {
      const res = await fetch(url(`/api/streams/${id}/steps`));
      expect(res.status).toBe(200);
      return (await res.json()) as StepPage;
    };
    expect(await read(node.id)).toEqual({ steps: [], total: 0 });

    await toolCall(node.id, {
      toolCallId: 't1',
      kind: 'read',
      title: 'Read a.ts',
      status: 'pending',
    });
    await toolCall(node.id, { toolCallId: 't1', status: 'completed' });
    await toolCall(node.id, {
      toolCallId: 't2',
      kind: 'execute',
      title: '`bun test`',
      status: 'in_progress',
    });
    await toolCall(other.id, {
      toolCallId: 't3',
      kind: 'edit',
      title: 'Edit b.ts',
      status: 'pending',
    });
    const first = await read(node.id);
    expect(first.total).toBe(2);
    expect(first.steps.map((s) => [s.id, s.kind, s.title, s.status, s.session])).toEqual([
      ['t2', 'execute', '`bun test`', 'in_progress', 'S-1'],
      ['t1', 'read', 'Read a.ts', 'completed', 'S-1'],
    ]);
    expect(typeof first.steps[0]?.ts).toBe('string');

    // Appended after the first read: the next read has it (the index follows the log).
    await toolCall(node.id, { toolCallId: 't2', status: 'failed' });
    expect((await read(node.id)).steps[0]?.status).toBe('failed');
    expect((await read(other.id)).steps.map((s) => s.id)).toEqual(['t3']);

    expect((await fetch(url(`/api/streams/${ulid()}/steps`))).status).toBe(404);
    expect((await fetch(url('/api/streams/nope/steps'))).status).toBe(400);
    expect((await fetch(url(`/api/streams/${node.id}/steps`), { method: 'POST' })).status).toBe(
      404,
    );
  });

  test("T399: GET /api/director/steps is the Director's tool calls; the page says how long its thread is", async () => {
    const withDirector = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      director: new DirectorService({
        store,
        streams,
        events: new RoutedEventService(store),
        home,
      }),
    });
    try {
      const at = (path: string) => `http://127.0.0.1:${withDirector.port}${path}`;
      expect(await (await fetch(at('/api/director/steps'))).json()).toEqual({
        steps: [],
        total: 0,
      });
      await store.appendEvent(
        buildEvent('tool_call', {
          agent: 'S-D',
          data: {
            stream: 'director',
            toolCallId: 'd1',
            kind: 'read',
            title: 'List',
            status: 'completed',
          },
        }),
      );
      // A node's tool call is not the Director's.
      const node = await streams.create('human', { title: 'n', goal: 'g' });
      await store.appendEvent(
        buildEvent('tool_call', { agent: 'S-N', data: { stream: node.id, toolCallId: 'n1' } }),
      );
      const page = (await (await fetch(at('/api/director/steps'))).json()) as StepPage;
      expect(page.total).toBe(1);
      expect(page.steps.map((s) => [s.id, s.kind, s.status])).toEqual([
        ['d1', 'read', 'completed'],
      ]);
      await store.appendDirectorThread({
        ts: new Date().toISOString(),
        by: 'director',
        kind: 'line',
        body: 'hi',
      });
      const director = (await (await fetch(at('/api/director'))).json()) as {
        thread: unknown[];
        thread_total: number;
      };
      expect([director.thread.length, director.thread_total]).toEqual([1, 1]);
      expect((await fetch(at('/api/director/steps'), { method: 'POST' })).status).toBe(404);
      // Without a Director, the route says so.
      expect((await fetch(url('/api/director/steps'))).status).toBe(503);
    } finally {
      await withDirector.stop();
    }
  });

  test('T414: POST /api/streams with auto_title asks for a title; without it, none is asked', async () => {
    const asked: string[] = [];
    const titleNamer = new TitleNamer({
      streams,
      run: async (prompt) => {
        asked.push(prompt);
        return 'Refunds in the ledger';
      },
    });
    const named = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      titleNamer,
    });
    try {
      const shop = await new ProjectService(store, streams).create({ name: 'shop' });
      const create = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${named.port}/api/streams`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: shop.id, start: false, ...body }),
        }).then(async (res) => ({ status: res.status, stream: (await res.json()) as Stream }));
      const auto = await create({
        title: 'how do refunds work',
        goal: 'how do refunds work in the ledger?',
        auto_title: true,
      });
      expect(auto.status).toBe(201);
      // Created with the placeholder; the better title follows.
      expect(auto.stream.title).toBe('how do refunds work');
      await titleNamer.settled();
      expect(streams.get(auto.stream.id).title).toBe('Refunds in the ledger');
      const own = await create({ title: 'My own title', goal: 'something else' });
      await titleNamer.settled();
      expect(streams.get(own.stream.id).title).toBe('My own title');
      expect(asked).toHaveLength(1);
    } finally {
      await named.stop();
    }
  });

  test('T421: POST /api/streams/:id/send-up puts the conclusion on the parent as your line', async () => {
    const parent = await streams.create('human', { title: 'Add CSV import', goal: 'g' });
    const side = await streams.create('human', {
      title: 'Why buffer?',
      goal: 'why buffer the file?',
      parent: parent.id,
    });
    const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/send-up`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const sent = await post(side.id, { body: 'Stream it: files reach 2 GB.' });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toEqual({ parent: parent.id });
    const upThere = streams.readThread(parent.id).entries.at(-1);
    expect(upThere?.by).toBe('human');
    expect(upThere?.kind).toBe('line');
    expect(upThere?.body).toBe(
      'From the conversation “Why buffer?”:\n\nStream it: files reach 2 GB.',
    );
    const here = streams.readThread(side.id).entries.at(-1);
    expect(here?.body).toBe('sent to Add CSV import: Stream it: files reach 2 GB.');
    // A root has nothing above it; an empty body and another origin are refused.
    expect((await post(parent.id, { body: 'x' })).status).toBe(400);
    expect((await post(side.id, { body: '  ' })).status).toBe(400);
    expect((await post(side.id, { body: 'x' }, { origin: 'http://evil.example' })).status).toBe(
      403,
    );
  });

  test('T422: POST /api/streams/:id/draft-goal drafts the work a conversation concluded', async () => {
    const convo = await streams.create('human', { title: 'Why buffer?', goal: 'why buffer?' });
    const draft = (at: string, id: string, headers: Record<string, string> = {}) =>
      fetch(`${at}/api/streams/${id}/draft-goal`, { method: 'POST', headers });
    const base = url('').replace(/\/$/, '');
    // Nothing said yet, and no model: the question itself.
    expect(await (await draft(base, convo.id)).json()).toEqual({
      goal: 'why buffer?',
      from: 'question',
    });
    await streams.appendThread('human', convo.id, { kind: 'line', body: 'should we stream it?' });
    await streams.appendThread(
      'agent',
      convo.id,
      { kind: 'line', body: 'Yes: stream the upload in 1 MB chunks.' },
      '01J0000000000000000000000A',
    );
    // No model: its last reply.
    expect(await (await draft(base, convo.id)).json()).toEqual({
      goal: 'Yes: stream the upload in 1 MB chunks.',
      from: 'reply',
    });
    expect((await draft(base, convo.id, { origin: 'http://evil.example' })).status).toBe(403);
    // With the cheap model: its draft, from the question and the talk.
    const asked: string[] = [];
    let reply: string | undefined =
      'Goal: Stream uploads in 1 MB chunks; done when 2 GB files import.';
    const withModel = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      cheapModel: async (prompt) => {
        asked.push(prompt);
        return reply;
      },
    });
    try {
      const at = `http://127.0.0.1:${withModel.port}`;
      expect(await (await draft(at, convo.id)).json()).toEqual({
        goal: 'Stream uploads in 1 MB chunks; done when 2 GB files import.',
        from: 'model',
      });
      expect(asked[0]).toContain('The question: why buffer?');
      expect(asked[0]).toContain('Human: should we stream it?');
      // A failed call falls back to the last reply.
      reply = undefined;
      expect(await (await draft(at, convo.id)).json()).toEqual({
        goal: 'Yes: stream the upload in 1 MB chunks.',
        from: 'reply',
      });
      // T435: so does a draft that is the model talking to you, or its NONE.
      expect(asked[0]).toContain('reply NONE');
      for (const chatty of [
        "I don't have the context of the conversation. Could you share it?",
        'NONE',
      ]) {
        reply = chatty;
        expect(await (await draft(at, convo.id)).json()).toEqual({
          goal: 'Yes: stream the upload in 1 MB chunks.',
          from: 'reply',
        });
      }
    } finally {
      await withModel.stop();
    }
  });

  test('T434: GET/POST /api/settings/quick-drafts switches the cheap model call off and on', async () => {
    const drafted = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      quickDraftsAvailable: true,
    });
    try {
      const at = (path: string) => `http://127.0.0.1:${drafted.port}${path}`;
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(at('/api/settings/quick-drafts'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
      expect(await (await fetch(at('/api/settings/quick-drafts'))).json()).toEqual({
        on: true,
        available: true,
      });
      expect(await (await post({ on: false })).json()).toEqual({ on: false, available: true });
      expect(store.getHomeConfig().quick_drafts).toBe(false);
      expect(await (await post({ on: true })).json()).toEqual({ on: true, available: true });
      // On is the default: the key goes.
      expect(store.getHomeConfig().quick_drafts).toBeUndefined();
      expect((await post({ on: 'yes' })).status).toBe(400);
      expect((await post({ on: false }, { origin: 'http://evil.example' })).status).toBe(403);
    } finally {
      await drafted.stop();
    }
    // Without a `claude` command, it says so.
    expect(await (await fetch(url('/api/settings/quick-drafts'))).json()).toEqual({
      on: true,
      available: false,
    });
  });

  test('T480: GET/POST /api/settings/installed-cli switches a bridge to its bundled copy and back', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/settings/installed-cli'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    type Rows = { vendors: Array<{ vendor: string; on: boolean }> };
    const ons = (r: Rows) => r.vendors.map((v) => [v.vendor, v.on]);
    expect(ons((await (await fetch(url('/api/settings/installed-cli'))).json()) as Rows)).toEqual([
      ['claude', true],
      ['codex', true],
    ]);
    expect(ons((await (await post({ vendor: 'codex', on: false })).json()) as Rows)).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
    expect(store.getHomeConfig().installed_cli).toEqual({ codex: false });
    await post({ vendor: 'codex', on: true });
    // On is the default: the key goes.
    expect(store.getHomeConfig().installed_cli).toBeUndefined();
    expect((await post({ vendor: 'gemini', on: false })).status).toBe(400);
    expect(
      (await post({ vendor: 'claude', on: false }, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    expect(store.getHomeConfig().installed_cli).toBeUndefined();
  });

  test('T454: GET/POST /api/settings/knowledge-wake lets Jev decide, or not', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/settings/knowledge-wake'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(await (await fetch(url('/api/settings/knowledge-wake'))).json()).toEqual({ on: false });
    expect((await post({ on: true }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(store.getHomeConfig().knowledge_wake).toBeUndefined();
    expect(await (await post({ on: true })).json()).toEqual({ on: true });
    expect(store.getHomeConfig().knowledge_wake).toBe('jev');
    expect(await (await fetch(url('/api/settings/knowledge-wake'))).json()).toEqual({ on: true });
    expect((await post({ on: 'yes' })).status).toBe(400);
    expect(await (await post({ on: false })).json()).toEqual({ on: false });
    // Off is the default: the key goes.
    expect(store.getHomeConfig().knowledge_wake).toBeUndefined();
    const put = store
      .listEvents()
      .filter((e) => e.kind === 'home_config_put')
      .at(-1);
    expect(put?.agent).toBe('human');
  });

  test("T478: GET/POST /api/settings/auto-close is New node's default; off removes the key", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/settings/auto-close'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(await (await fetch(url('/api/settings/auto-close'))).json()).toEqual({ on: false });
    expect((await post({ on: true }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(await (await post({ on: true })).json()).toEqual({ on: true });
    expect(store.getHomeConfig().auto_close).toBe(true);
    expect((await post({ on: 1 })).status).toBe(400);
    expect(await (await post({ on: false })).json()).toEqual({ on: false });
    expect(store.getHomeConfig().auto_close).toBeUndefined();
  });

  test('T465: GET/POST /api/settings/session-idle is the idle session timeout; 30 removes the key', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url('/api/settings/session-idle'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(await (await fetch(url('/api/settings/session-idle'))).json()).toEqual({ minutes: 30 });
    expect((await post({ minutes: 60 }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(await (await post({ minutes: 60 })).json()).toEqual({ minutes: 60 });
    expect(store.getHomeConfig().session_idle_minutes).toBe(60);
    expect((await post({ minutes: 0 })).status).toBe(400);
    expect((await post({ minutes: 1441 })).status).toBe(400);
    expect((await post({ minutes: 'soon' })).status).toBe(400);
    expect(await (await post({ minutes: 30 })).json()).toEqual({ minutes: 30 });
    expect(store.getHomeConfig().session_idle_minutes).toBeUndefined();
  });

  test('T457: permissions — the home posture, a project override, and a held read answered Always', async () => {
    const at = (path: string) => url(path);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(at(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(await (await fetch(at('/api/settings/permissions'))).json()).toEqual({ posture: 'ask' });
    expect(await (await post('/api/settings/permissions', { posture: 'trusted' })).json()).toEqual({
      posture: 'trusted',
    });
    expect(store.getHomeConfig().permissions).toBe('trusted');
    expect((await post('/api/settings/permissions', { posture: 'yolo' })).status).toBe(400);
    const foreign = { origin: 'http://evil.example' };
    expect((await post('/api/settings/permissions', { posture: 'ask' }, foreign)).status).toBe(403);
    expect(store.getHomeConfig().permissions).toBe('trusted');

    const project = await new ProjectService(store, streams).create({ name: 'Cents' });
    const node = await streams.create('human', {
      title: 'Cents check',
      goal: 'g',
      project: project.id,
    });
    const updated = await post(`/api/projects/${project.id}`, { permissions: 'ask' });
    expect(updated.status).toBe(200);
    expect(store.getProject(project.id).permissions).toBe('ask');
    expect((await post(`/api/projects/${project.id}`, { read_roots: ['/'] })).status).toBe(400);

    const root = join(home, 'other');
    const gate = await new GateService(store).request('classifier_review', {
      policy: {
        gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
        breaker_signals: [],
      },
      stream: node.id,
      summary: `${root}/a.ts is outside every repo this node can read`,
      call: { tool: 'Read', path: `${root}/a.ts`, fingerprint: '0123456789abcdef' },
      readRoot: root,
    });
    const inbox = (await (await fetch(at('/api/inbox'))).json()) as {
      items: Array<{ id: string; read_root?: string }>;
    };
    expect(inbox.items.find((item) => item.id === gate.id)?.read_root).toBe(root);
    expect((await post(`/api/hil/${gate.id}/always`, {}, foreign)).status).toBe(403);
    const always = await post(`/api/hil/${gate.id}/always`, {});
    expect(always.status).toBe(200);
    expect(((await always.json()) as { decision: string }).decision).toBe('approve');
    expect(store.getProject(project.id).read_roots).toEqual([root]);
    expect((await post(`/api/hil/${gate.id}/always`, {})).status).toBe(409);
    // The project's list is the Settings control's: a removal writes the rest.
    await post(`/api/projects/${project.id}`, { read_roots: null });
    expect(store.getProject(project.id).read_roots).toBeUndefined();
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
      body: JSON.stringify({ body: 'x'.repeat(4001) }),
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

  test('T463: POST /api/streams/:id/rule and /permissions, as the operator; strict; cross-origin 403', async () => {
    const post = (id: string, what: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/${what}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const node = await streams.create('human', { title: 'n', goal: 'g' });
    const rule = await rules.create('human', {
      text: 'never write outside the worktree',
      scope: { kind: 'global' },
    });
    await rules.accept(rule.id, 'human');
    expect(
      (await post(node.id, 'rule', { rule: rule.id, on: false }, { origin: 'http://evil.example' }))
        .status,
    ).toBe(403);
    expect((await post(node.id, 'rule', { rule: rule.id })).status).toBe(400);
    expect(
      (await post(node.id, 'rule', { rule: 'K-01ARZ3NDEKTSV4RRFFQ69G5FAV', on: false })).status,
    ).toBe(400);
    const off = await post(node.id, 'rule', { rule: rule.id, on: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { rules_off: string[] }).rules_off).toEqual([rule.id]);
    expect(rules.inScope(node.id).map((r) => r.id)).not.toContain(rule.id);
    expect(streams.readThread(node.id).entries.at(-1)?.body).toContain(
      'no longer applies to this node',
    );
    // The node page still lists it, so it can be switched back on.
    const page = (await (await fetch(url(`/api/streams/${node.id}`))).json()) as {
      rules: Array<{ id: string }>;
      stream: { rules_off?: string[] };
    };
    expect(page.rules.map((r) => r.id)).toContain(rule.id);
    expect(page.stream.rules_off).toEqual([rule.id]);
    expect((await post(node.id, 'rule', { rule: rule.id, on: true })).status).toBe(200);
    expect(streams.get(node.id).rules_off).toBeUndefined();

    expect((await post(node.id, 'permissions', { posture: 'yolo' })).status).toBe(400);
    expect((await post(node.id, 'permissions', { posture: 'trusted' })).status).toBe(200);
    expect(streams.get(node.id).permissions).toBe('trusted');
    expect((await post(node.id, 'permissions', { posture: null })).status).toBe(200);
    expect(streams.get(node.id).permissions).toBeUndefined();
  });

  test('T477: POST /api/streams/:id/dismiss stamps human.dismissed_at; a first goal reads "goal set"', async () => {
    const post = (id: string, what: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/${what}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const node = await streams.create('human', { title: 'talk first' });
    expect(node.goal).toBeUndefined();
    expect((await post(node.id, 'dismiss', {}, { origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect(streams.get(node.id).human.dismissed_at).toBeUndefined();
    const dismissed = await post(node.id, 'dismiss', {});
    expect(dismissed.status).toBe(200);
    expect(streams.get(node.id).human.dismissed_at).toBeString();
    expect(streams.get(node.id).human.status).toBe('open');

    expect((await post(node.id, 'update', { goal: 'fix the parser' })).status).toBe(200);
    expect(streams.readThread(node.id).entries.at(-1)?.body).toBe('goal set: fix the parser');
    expect((await post(node.id, 'update', { goal: 'fix the lexer' })).status).toBe(200);
    expect(streams.readThread(node.id).entries.at(-1)?.body).toBe('goal changed: fix the lexer');
  });

  test('T478: POST /api/streams/:id/auto-close, as the operator; a node made with it keeps it', async () => {
    const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/streams/${id}/auto-close`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const node = await streams.create('human', { title: 'n', goal: 'g' });
    expect((await post(node.id, { on: true }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(node.id, {})).status).toBe(400);
    expect((await post(node.id, { on: true })).status).toBe(200);
    expect(streams.get(node.id).auto_close).toBe(true);
    expect((await post(node.id, { on: false })).status).toBe(200);
    expect(streams.get(node.id).auto_close).toBeUndefined();
  });

  test('T471: reopen, the trash preview, Delete forever and Empty trash; same-origin; refusals are 409', async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const top = await streams.create('human', { title: 'top', goal: 'g' });
    const node = await streams.create('human', { title: 'n', goal: 'g', parent: top.id });
    await streams.close('human', node.id);
    expect(
      (await post(`/api/streams/${node.id}/reopen`, {}, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    expect((await post(`/api/streams/${node.id}/reopen`, {})).status).toBe(200);
    expect(streams.get(node.id).human.status).toBe('open');

    // Not in the trash: refused.
    expect((await post(`/api/streams/${node.id}/purge`, {})).status).toBe(409);
    await streams.archiveTree('human', node.id);
    const preview = (await (await fetch(url(`/api/streams/${node.id}/trash-preview`))).json()) as {
      nodes: Array<{ id: string }>;
    };
    expect(preview.nodes.map((n) => n.id)).toEqual([node.id]);
    const all = (await (await fetch(url('/api/trash'))).json()) as { nodes: Array<{ id: string }> };
    expect(all.nodes.map((n) => n.id)).toEqual([node.id]);
    expect((await post(`/api/streams/${node.id}/purge`, { delete_branches: 'yes' })).status).toBe(
      400,
    );
    expect(
      (await post(`/api/streams/${node.id}/purge`, {}, { origin: 'http://evil.example' })).status,
    ).toBe(403);
    expect((await post(`/api/streams/${node.id}/purge`, {})).status).toBe(200);
    expect(store.hasStream(node.id)).toBe(false);

    const other = await streams.create('human', { title: 'o', goal: 'g', parent: top.id });
    await streams.archiveTree('human', other.id);
    expect((await post('/api/trash/empty', {}, { origin: 'http://evil.example' })).status).toBe(
      403,
    );
    const emptied = (await (await post('/api/trash/empty', {})).json()) as { deleted: string[] };
    expect(emptied.deleted).toEqual([other.id]);
    expect(store.hasStream(other.id)).toBe(false);
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

  test('T435: POST /api/streams/:id/update with auto_title has the cheap model name it better', async () => {
    const asked: string[] = [];
    const titleNamer = new TitleNamer({
      streams,
      run: async (prompt) => {
        asked.push(prompt);
        return 'Excel import support';
      },
    });
    const named = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
      titleNamer,
    });
    try {
      const update = (id: string, body: unknown) =>
        fetch(`http://127.0.0.1:${named.port}/api/streams/${id}/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const node = await streams.create('human', {
        title: 'Does import handle Excel files?',
        goal: 'Does import handle Excel files?',
      });
      const res = await update(node.id, {
        goal: 'Strip the BOM and split on CRLF in importCsv().',
        title: 'Strip the BOM and split on CRLF',
        auto_title: true,
      });
      expect(res.status).toBe(200);
      // The placeholder at once, the model's title after; the model reads the new goal.
      expect(((await res.json()) as Stream).title).toBe('Strip the BOM and split on CRLF');
      await titleNamer.settled();
      expect(streams.get(node.id).title).toBe('Excel import support');
      expect(asked[0]).toContain('Strip the BOM and split on CRLF in importCsv().');
      // Without it (or with no title), nothing is asked.
      await update(node.id, { title: 'My name' });
      await update(node.id, { goal: 'another goal', auto_title: true });
      await titleNamer.settled();
      expect(asked).toHaveLength(1);
      expect(streams.get(node.id).title).toBe('My name');
      // Still strict.
      expect((await update(node.id, { auto_title: true })).status).toBe(400);
      expect((await update(node.id, { title: 'x', auto_title: 'yes' })).status).toBe(400);
    } finally {
      await named.stop();
    }
  });

  test("T441: a conversation's first new goal keeps its question on the record; a root's doesn't", async () => {
    const server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      streams,
    });
    try {
      const update = (id: string, body: unknown) =>
        fetch(`http://127.0.0.1:${server.port}/api/streams/${id}/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const root = await streams.create('human', { title: 'Shop', goal: 'Shop' });
      const convo = await streams.create('human', {
        title: 'Does import handle Excel files?',
        goal: 'Does import handle Excel files?',
        parent: root.id,
      });
      expect((await update(convo.id, { goal: 'Add .xlsx import.' })).status).toBe(200);
      expect(streams.get(convo.id).question).toBe('Does import handle Excel files?');
      // A later change keeps the first question; a title-only edit sets nothing.
      await update(convo.id, { goal: 'Add .xlsx and .ods import.' });
      expect(streams.get(convo.id).question).toBe('Does import handle Excel files?');
      const other = await streams.create('human', {
        title: 'Why?',
        goal: 'Why?',
        parent: root.id,
      });
      await update(other.id, { title: 'Why indeed' });
      expect(streams.get(other.id).question).toBeUndefined();
      // A root's (or a work node's) goal is a brief, not a question.
      await update(root.id, { goal: 'Everything the shop sells.' });
      expect(streams.get(root.id).question).toBeUndefined();
    } finally {
      await server.stop();
    }
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
      // T423: the model chip's choice rides with a starting line, never without one.
      const session = { vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'high' };
      expect((await say({ body: 'with a model', start: true, session })).status).toBe(201);
      const refused = await say({ body: 'no start', session });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain('only for a line that starts the agent');
      expect((await say({ body: 'x', start: true, session: { role: 'worker' } })).status).toBe(400);
      expect(seen).toEqual([{ start: true }, {}, { start: true, session }]);
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

  test('T404: a /ws connect sends the recent events without reading the log again', async () => {
    const agentId = '01ARZ3NDEKTSV4RRFFQ69GE903';
    const put = () =>
      store.putAgent(agentId, {
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        last_seen: new Date().toISOString(),
      });
    await put();
    let reads = 0;
    const listEvents = store.listEvents.bind(store);
    store.listEvents = (endOffset?: number) => {
      reads += 1;
      return listEvents(endOffset);
    };
    const quick = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      feedPollIntervalMs: 20,
    });
    const snapshotOf = () =>
      new Promise<Event[]>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${quick.port}/ws`);
        ws.onmessage = (event) => {
          const frame = JSON.parse(event.data as string) as { type: string; events?: Event[] };
          if (frame.type !== 'snapshot') return;
          ws.close();
          resolve(frame.events ?? []);
        };
        ws.onerror = (event) => reject(event);
      });
    try {
      // Read once, when the server started.
      expect(reads).toBe(1);
      const first = await snapshotOf();
      expect(first.filter((e) => e.agent === agentId).map((e) => e.kind)).toEqual(['agent_put']);
      // Written after the start: the tailer adds it, and the next connect has it.
      await put();
      const deadline = Date.now() + 5000;
      let second = await snapshotOf();
      while (second.filter((e) => e.agent === agentId).length < 2 && Date.now() < deadline) {
        await Bun.sleep(20);
        second = await snapshotOf();
      }
      expect(second.filter((e) => e.agent === agentId)).toHaveLength(2);
      expect(reads).toBe(1);
    } finally {
      store.listEvents = listEvents;
      await quick.stop();
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

  test("T407: /api/repos/:name/events is the repo's page, paged the same", async () => {
    const first = await emit('one', 'api');
    await emit('elsewhere', 'web');
    const second = await emit('two', 'api');
    const at = (query = '') =>
      fetch(`http://127.0.0.1:${cockpit.port}/api/repos/api/events${query}`).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as Page,
      }));
    const page = await at('?limit=1');
    expect(page.status).toBe(200);
    expect(page.body.events.map((e) => e.id)).toEqual([second.id]);
    expect(page.body).toMatchObject({ more: true, total: 2 });
    const next = await at(`?limit=1&before=${second.id}`);
    expect(next.body.events.map((e) => e.id)).toEqual([first.id]);
    expect(next.body.more).toBe(false);
    expect((await at('?limit=0')).status).toBe(400);
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
