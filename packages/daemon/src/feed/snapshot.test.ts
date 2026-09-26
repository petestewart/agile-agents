/**
 * `buildSnapshot` after T122: the event tail, the open gates, the open
 * questions and the project block. Everything else the snapshot used to
 * carry went with the subsystem behind it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type SessionRef, ulid } from '@agile-agents/shared';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { StreamService } from '../streams';
import { COCKPIT_ARCHIVED_MAX, buildCockpitFrame, buildSnapshot } from './snapshot';

let repo: string;
let store: StateStore;
let gates: GateService;
let streams: StreamService;
let questions: QuestionService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-feed-snapshot-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  gates = new GateService(store);
  streams = new StreamService(store);
  questions = new QuestionService(store, streams);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test('an empty state home snapshots to empty lists and a zero Needs-you count', () => {
  const snapshot = buildSnapshot(store, gates);
  expect(snapshot.type).toBe('snapshot');
  expect(snapshot.events).toEqual([]);
  expect(snapshot.hil).toEqual([]);
  expect(snapshot.questions).toEqual([]);
  expect(snapshot.status.needs_you).toBe(0);
});

async function newStream() {
  return streams.create('human', { title: 'A stream', goal: 'do the thing' });
}

test('a pending gate is an attention-queue item and a resolved one is not', async () => {
  const stream = await newStream();
  const raised = await gates.request('land', {
    policy: store.getPolicy(),
    stream: stream.id,
    summary: 'land the branch',
  });
  expect(buildSnapshot(store, gates).hil.map((r) => r.id)).toEqual([raised.id]);
  expect(buildSnapshot(store, gates).status.needs_you).toBe(1);

  await gates.respond(raised.id, 'approve', 'human');
  expect(buildSnapshot(store, gates).hil).toEqual([]);
  expect(buildSnapshot(store, gates).status.needs_you).toBe(0);
});

test('open questions ride on the snapshot and count towards Needs-you', async () => {
  const stream = await newStream();
  await questions.raise({ stream: stream.id, raised_by: 'human', text: 'which branch?' });
  const snapshot = buildSnapshot(store, gates, undefined, questions);
  expect(snapshot.questions).toHaveLength(1);
  expect(snapshot.status.needs_you).toBe(1);
});

test('the project block names the repo root the daemon was given', () => {
  const snapshot = buildSnapshot(store, gates, undefined, undefined, repo);
  expect(snapshot.project).toEqual({ name: basename(repo), path: repo });
});

test('without a project root there is no project block', () => {
  expect(buildSnapshot(store, gates).project).toBeUndefined();
});

describe('T361: the rail flags and the archived list', () => {
  const session = (status: SessionRef['status'], extra: Partial<SessionRef> = {}): SessionRef => ({
    id: ulid(),
    vendor: 'claude',
    model: 'claude-opus-5-5',
    role: 'worker',
    status,
    ...extra,
  });
  async function withSessions(id: string, sessions: SessionRef[], agent: 'idle' | 'done' = 'idle') {
    await store.updateStream('daemon', id, (s) => ({
      ...s,
      sessions,
      agent: { ...s.agent, status: agent },
    }));
  }
  const rows = () => new Map(buildCockpitFrame(streams).streams.map((r) => [r.id, r]));
  const flags = (id: string) => {
    const row = rows().get(id);
    return { never_started: row?.never_started, stopped: row?.stopped };
  };

  test('never_started: a work node or conversation whose agent never ran, still open', async () => {
    await store.addRepo('demo', { path: repo });
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const talk = await streams.create('human', { title: 'talk', goal: 'g', parent: root.id });
    const work = await streams.create('human', {
      title: 'work',
      goal: 'g',
      parent: root.id,
      repo: 'demo',
    });
    const split = await streams.create('human', { title: 'split', goal: 'g', parent: root.id });
    await streams.create('human', { title: 'part', goal: 'g', parent: split.id, repo: 'demo' });
    const reviewed = await streams.create('human', {
      title: 'reviewed',
      goal: 'g',
      parent: root.id,
    });
    await withSessions(reviewed.id, [session('stopped', { role: 'reviewer' })]);
    const closed = await streams.create('human', { title: 'closed', goal: 'g', parent: root.id });
    await streams.close('human', closed.id);

    expect(flags(talk.id)).toEqual({ never_started: true, stopped: undefined });
    expect(flags(work.id)).toEqual({ never_started: true, stopped: undefined });
    // A reviewer is not the node's agent.
    expect(flags(reviewed.id).never_started).toBe(true);
    // A project root and a coordinating node have no "not started" of their own.
    expect(flags(root.id)).toEqual({ never_started: undefined, stopped: undefined });
    expect(flags(split.id)).toEqual({ never_started: undefined, stopped: undefined });
    expect(flags(closed.id)).toEqual({ never_started: undefined, stopped: undefined });
  });

  test('stopped: the human stopped its agent, nothing is live, and it is still open', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const node = async (title: string) =>
      (await streams.create('human', { title, goal: 'g', parent: root.id })).id;
    const detached = await node('detached');
    await withSessions(detached, [session('stopped')]);
    const reshaped = await node('reshaped');
    await withSessions(reshaped, [session('stopped', { ended_reason: 'stopped: node reshaped' })]);
    const finished = await node('finished');
    await withSessions(finished, [session('stopped')], 'done');
    const live = await node('live');
    await withSessions(live, [session('stopped'), session('running')]);
    const closed = await node('closed');
    await withSessions(closed, [session('stopped')]);
    await streams.close('human', closed);

    expect(flags(detached)).toEqual({ never_started: undefined, stopped: true });
    // The daemon's own stop (a reshape, a role change) is not the human's.
    expect(flags(reshaped).stopped).toBeUndefined();
    expect(flags(finished).stopped).toBeUndefined();
    expect(flags(live).stopped).toBeUndefined();
    expect(flags(closed).stopped).toBeUndefined();
  });

  test('archived: what Restore can bring back, the latest delete first, capped', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    expect(buildCockpitFrame(streams).archived).toBeUndefined();
    const a = await streams.create('human', { title: 'a', goal: 'g', parent: root.id });
    await streams.create('human', { title: 'a1', goal: 'g', parent: a.id });
    const b = await streams.create('human', { title: 'b', goal: 'g', parent: root.id });
    await streams.archiveTree('human', b.id);
    await streams.archiveTree('human', a.id);
    // `a1` went with `a`, so only `a` is listed; `a` was deleted last.
    expect(buildCockpitFrame(streams).archived).toEqual([
      { id: a.id, title: 'a', parent: root.id },
      { id: b.id, title: 'b', parent: root.id },
    ]);
    expect(buildCockpitFrame(streams).streams.map((r) => r.id)).toEqual([root.id]);
    for (let i = 0; i < COCKPIT_ARCHIVED_MAX; i++) {
      const extra = await streams.create('human', { title: `x${i}`, goal: 'g', parent: root.id });
      await streams.archiveTree('human', extra.id);
    }
    const listed = buildCockpitFrame(streams).archived ?? [];
    expect(listed).toHaveLength(COCKPIT_ARCHIVED_MAX);
    expect(listed[0]?.title).toBe(`x${COCKPIT_ARCHIVED_MAX - 1}`);
  }, 30_000);
});

describe('T382: the live agent a row names', () => {
  const session = (
    role: SessionRef['role'],
    status: SessionRef['status'],
    extra: Partial<SessionRef> = {},
  ): SessionRef => ({
    id: ulid(),
    vendor: 'claude',
    model: 'claude-opus-5-5',
    effort: 'low',
    role,
    status,
    ...extra,
  });
  async function nodeWith(title: string, sessions: SessionRef[]): Promise<string> {
    const { id } = await streams.create('human', { title, goal: 'g' });
    await store.updateStream('daemon', id, (s) => ({ ...s, sessions }));
    return id;
  }
  const liveAgentOf = (id: string) =>
    buildCockpitFrame(streams).streams.find((r) => r.id === id)?.live_agent;

  test("the node's own agent, with its vendor, model and effort", async () => {
    const worker = await nodeWith('worker', [
      session('worker', 'stopped', { model: 'claude-haiku-4-5' }),
      session('worker', 'running', { model: 'claude-sonnet-4-6', effort: 'high' }),
    ]);
    expect(liveAgentOf(worker)).toEqual({
      role: 'worker',
      vendor: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
    const coordinator = await nodeWith('coordinator', [session('coordinator', 'idle')]);
    expect(liveAgentOf(coordinator)).toEqual({
      role: 'coordinator',
      vendor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'low',
    });
  });

  test('a reviewer only when it is all that runs; no effort when the session has none', async () => {
    const both = await nodeWith('both', [
      session('worker', 'idle', { vendor: 'gemini', model: 'default' }),
      session('reviewer', 'running', { model: 'claude-haiku-4-5' }),
    ]);
    expect(liveAgentOf(both)).toEqual({
      role: 'worker',
      vendor: 'gemini',
      model: 'default',
      effort: 'low',
    });
    const reviewing = await nodeWith('reviewing', [
      session('worker', 'stopped'),
      session('reviewer', 'starting', { vendor: 'codex', model: 'gpt-9', effort: undefined }),
    ]);
    expect(liveAgentOf(reviewing)).toEqual({ role: 'reviewer', vendor: 'codex', model: 'gpt-9' });
    const lessons = await nodeWith('lessons', [session('lessons', 'running')]);
    expect(liveAgentOf(lessons)?.role).toBe('lessons');
  });

  test('absent when nothing is live', async () => {
    const never = await nodeWith('never', []);
    const ended = await nodeWith('ended', [
      session('worker', 'stopped'),
      session('reviewer', 'error'),
    ]);
    expect(liveAgentOf(never)).toBeUndefined();
    expect(liveAgentOf(ended)).toBeUndefined();
    const rows = buildCockpitFrame(streams).streams;
    expect(rows.find((r) => r.id === ended)).not.toHaveProperty('live_agent');
    expect(rows.find((r) => r.id === ended)?.live).toBeUndefined();
  });
});
