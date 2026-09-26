/**
 * T202 (projects-design §17.1): a home from before projects is migrated on
 * daemon start, once. Forward-compat on an old home: the streams and the
 * repos entry are written the way a pre-T200 daemon wrote them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@agile-agents/shared';
import { type DaemonHandle, startDaemon } from '../daemon';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StreamService } from '../streams/service';
import { migrateHome } from './migrate';
import { StateStore } from './store';

let home: string;
let store: StateStore;
let streams: StreamService;
let deps: Parameters<typeof migrateHome>[0];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-migrate-'));
  runInit(home);
  store = StateStore.open(home);
  streams = new StreamService(store);
  deps = {
    store,
    streams,
    projects: new ProjectService(store, streams),
    questions: new QuestionService(store, streams),
  };
  // The pre-migration repos.yaml: no delivery, no visibility.
  writeFileSync(
    join(home, 'repos.yaml'),
    'shop:\n  path: /tmp/shop\n  target_branch: develop\nweb:\n  path: /tmp/web\n',
  );
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const events = (): Event[] =>
  readFileSync(join(home, 'log', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Event);

async function seedOldHome() {
  const epic = await streams.create('human', { title: 'epic', goal: 'g', repo: 'shop' });
  // The old parent-integration model: the parent had its own branch.
  await store.updateStream('daemon', epic.id, (s) => ({ ...s, branch: 'stream/epic' }));
  const child = await streams.create('human', { title: 'child', goal: 'g', parent: epic.id });
  const loose = await streams.create('human', { title: 'loose', goal: 'g' });
  return { epic, child, loose };
}

describe('migrateHome (§17.1)', () => {
  test('files every stream under Unfiled, fills repos, lists parent branches, once', async () => {
    const { epic, child, loose } = await seedOldHome();

    const first = await migrateHome(deps);
    expect(first.migrated).toBe(true);
    const [unfiled] = deps.projects.list();
    expect(unfiled?.name).toBe('Unfiled');
    for (const s of store.listStreams()) expect(s.project).toBe(unfiled?.id);
    expect(store.getStream(epic.id).parent).toBe(unfiled?.root);
    expect(store.getStream(loose.id).parent).toBe(unfiled?.root);
    expect(store.getStream(child.id).parent).toBe(epic.id);
    expect(store.getStream(epic.id).branch).toBe('stream/epic');

    const repos = store.getRepos();
    expect(repos.shop).toMatchObject({
      delivery: 'direct',
      visibility: { mode: 'public' },
      main_branch: 'develop',
    });
    expect(repos.web?.main_branch).toBeUndefined();
    expect(store.readThread(unfiled?.root ?? '').some((e) => e.body.includes('develop'))).toBe(
      true,
    );

    const open = deps.questions.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.text).toContain('stream/epic');

    // A second start changes nothing.
    const before = readFileSync(join(home, 'log', 'events.jsonl'), 'utf8');
    const second = await migrateHome(deps);
    expect(second.migrated).toBe(false);
    expect(readFileSync(join(home, 'log', 'events.jsonl'), 'utf8')).toBe(before);
    expect(deps.projects.list()).toHaveLength(1);
    expect(events().filter((e) => e.kind === 'home_migrated')).toHaveLength(1);
  });

  test('a fresh home makes no project and no event', async () => {
    rmSync(join(home, 'repos.yaml'));
    expect((await migrateHome(deps)).migrated).toBe(false);
    expect(deps.projects.list()).toEqual([]);
  });

  test('a repo added after the migration is already migrated', async () => {
    await migrateHome(deps);
    await store.addRepo('api', { path: '/tmp/api' });
    expect(store.getRepos().api).toMatchObject({
      delivery: 'direct',
      visibility: { mode: 'public' },
    });
    expect((await migrateHome(deps)).migrated).toBe(false);
  });
});

describe('daemon start migrates an old home', () => {
  let handle: DaemonHandle | undefined;
  let previousHome: string | undefined;
  afterEach(async () => {
    await handle?.stop();
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
    else process.env.AGILE_HOME = previousHome;
  });

  test('two starts, one home_migrated', async () => {
    await seedOldHome();
    previousHome = process.env.AGILE_HOME;
    process.env.AGILE_HOME = home;
    const sock = join(home, 'd.sock');
    handle = await startDaemon({ port: 0, socketPath: sock });
    await handle.stop();
    handle = await startDaemon({ port: 0, socketPath: sock });
    const reopened = StateStore.open(home);
    expect(reopened.listStreams().every((s) => s.project !== undefined)).toBe(true);
    expect(events().filter((e) => e.kind === 'home_migrated')).toHaveLength(1);
  });
});
