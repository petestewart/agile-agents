/**
 * `buildSnapshot` after T122: the event tail, the open gates, the open
 * questions and the project block. Everything else the snapshot used to
 * carry went with the subsystem behind it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { StreamService } from '../streams';
import { buildSnapshot } from './snapshot';

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
