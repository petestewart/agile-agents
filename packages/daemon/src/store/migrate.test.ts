/**
 * T202 (projects-design §17.1): a home from before projects is migrated on
 * daemon start, once. Forward-compat on an old home: the streams and the
 * repos entry are written the way a pre-T200 daemon wrote them.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Event,
  type KnowledgeEnforcement,
  LEGACY_RULE_ENFORCEMENTS,
  LEGACY_RULE_STAGES,
  type LegacyRuleEnforcement,
  type LegacyRuleStage,
  ulid,
} from '@agile-agents/shared';
import { stringify } from 'yaml';
import { type DaemonHandle, startDaemon } from '../daemon';
import { runInit } from '../init';
import { ensureBuiltinKnowledge } from '../knowledge/builtins';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StreamService } from '../streams/service';
import { startFakeJira } from '../trackers/fake-jira';
import { createJira } from '../trackers/jira';
import { TrackerLinks } from '../trackers/link';
import { migrateHome, migrateRules } from './migrate';
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
    expect(open[0]?.text).toContain('- epic: branch stream/epic in shop');
    // T371: the node by its title, never its id.
    expect(open[0]?.text).not.toContain(epic.id);

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

/**
 * T260 (§17.1 step 2, P6): every legacy `rules/R-X.yaml` becomes knowledge.
 * The rules are written as a pre-T260 daemon wrote them, into a home that
 * is then copied, and the copy is migrated — the original is untouched.
 */
describe('rules → knowledge (§17.1 step 2)', () => {
  const EXPECTED: Record<string, KnowledgeEnforcement[]> = {
    'pattern/action': ['action'],
    'pattern/diff': ['action'],
    'pattern/both': ['action'],
    'classifier/action': ['action'],
    'classifier/diff': ['ship'],
    'classifier/both': ['action', 'ship'],
    'guidance/action': ['tell'],
    'guidance/diff': ['tell'],
    'guidance/both': ['tell'],
  };

  function writeLegacyRule(
    root: string,
    enforcement: LegacyRuleEnforcement,
    stage: LegacyRuleStage,
    over: Record<string, unknown> = {},
  ): string {
    const id = `R-${ulid()}`;
    mkdirSync(join(root, 'rules'), { recursive: true });
    const record = {
      id,
      text: `${enforcement} at ${stage}`,
      scope: { kind: 'global' },
      status: 'accepted',
      enforcement,
      stage,
      ...(enforcement === 'pattern'
        ? { pattern: { kind: 'command_deny', args: { patterns: ['rm -rf'] } } }
        : {}),
      critical: false,
      examples:
        enforcement === 'classifier'
          ? [
              { action: 'bun add lodash', violates: true },
              { action: 'bun test', violates: false },
            ]
          : [],
      provenance: { by: 'human' },
      stats: { fired: 2, violated: 1, routed: 0 },
      created_at: '2026-09-01T00:00:00.000Z',
      decided_at: '2026-09-01T01:00:00.000Z',
      decided_by: 'pete',
      ...over,
    };
    writeFileSync(join(root, 'rules', `${id}.yaml`), stringify(record));
    return id;
  }

  test('every enforcement × stage on a copied home, ulids kept, both split, idempotent', async () => {
    const ids = new Map<string, string>();
    for (const enforcement of LEGACY_RULE_ENFORCEMENTS) {
      for (const stage of LEGACY_RULE_STAGES) {
        ids.set(`${enforcement}/${stage}`, writeLegacyRule(home, enforcement, stage));
      }
    }
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const scoped = writeLegacyRule(home, 'guidance', 'action', {
      text: 'a proposal on one stream',
      scope: { kind: 'stream', ref: stream.id },
      status: 'proposed',
      decided_at: undefined,
      decided_by: undefined,
      provenance: { by: `agent:${ulid()}`, stream: stream.id },
    });

    const copy = mkdtempSync(join(tmpdir(), 'agile-migrate-copy-'));
    try {
      cpSync(home, copy, { recursive: true });
      const copied = StateStore.open(copy);
      const copiedStreams = new StreamService(copied);
      const result = await migrateHome({
        store: copied,
        streams: copiedStreams,
        projects: new ProjectService(copied, copiedStreams),
        questions: new QuestionService(copied, copiedStreams),
      });
      // Nine rules plus the scoped one, plus one ship twin for classifier/both.
      expect(result.knowledge).toBe(11);

      const items = copied.listKnowledge();
      for (const [key, id] of ids) {
        const same = copied.getKnowledge(`K-${id.slice(2)}`);
        expect(same.kind).toBe('standard');
        expect(same.status).toBe('accepted');
        expect(same.decided_by).toBe('pete');
        expect(same.stats).toMatchObject({ fired: 2, violated: 1 });
        const family = items.filter((i) => i.text === key.replace('/', ' at '));
        expect(family.map((i) => i.enforcement).sort()).toEqual([...(EXPECTED[key] ?? [])].sort());
      }
      const split = items.filter((i) => i.text === 'classifier at both');
      expect(split.find((i) => i.enforcement === 'ship')?.source.finding).toContain(
        ids.get('classifier/both'),
      );
      const moved = copied.getKnowledge(`K-${scoped.slice(2)}`);
      expect(moved.scope).toEqual({ kind: 'subtree', node: stream.id });
      expect(moved.source).toMatchObject({ by: 'agent', node: stream.id });
      expect(moved.status).toBe('proposed');

      // `rules/` stays on disk; a second start writes nothing.
      expect(copied.listLegacyRules()).toHaveLength(10);
      const again = await migrateHome({
        store: copied,
        streams: copiedStreams,
        projects: new ProjectService(copied, copiedStreams),
        questions: new QuestionService(copied, copiedStreams),
      });
      expect(again.knowledge).toBe(0);
      expect(copied.listKnowledge()).toHaveLength(11);
      // The original home was not touched.
      expect(store.listKnowledge()).toEqual([]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  test('a crash between a P6 pair is completed on the next start', async () => {
    const id = writeLegacyRule(home, 'classifier', 'both');
    await migrateRules(store);
    const twin = store.listKnowledge().find((i) => i.enforcement === 'ship');
    if (twin === undefined) throw new Error('no ship twin');
    // Model a crash after the base write: the twin's file never landed.
    rmSync(join(home, 'knowledge', `${twin.id}.yaml`));
    expect(await migrateRules(store)).toBe(1);
    const items = store.listKnowledge();
    expect(items.map((i) => i.enforcement).sort()).toEqual(['action', 'ship']);
    expect(items.find((i) => i.enforcement === 'ship')?.source.finding).toContain(id);
    expect(await migrateRules(store)).toBe(0);
  });

  test('a guidance rule keeps its examples visible in source.finding', async () => {
    const id = writeLegacyRule(home, 'guidance', 'action', {
      examples: [
        { action: 'a', violates: true },
        { action: 'b', violates: false },
      ],
    });
    await migrateRules(store);
    expect(store.getKnowledge(`K-${id.slice(2)}`).source.finding).toBe(
      'proposed examples: violates: a | allowed: b',
    );
  });

  test('a home already on projects migrates only its rules, with no second parent-branch card', async () => {
    await seedOldHome();
    await migrateHome(deps);
    expect(deps.questions.listOpen()).toHaveLength(1);
    writeLegacyRule(home, 'guidance', 'action');
    const result = await migrateHome(deps);
    expect(result).toMatchObject({ migrated: true, knowledge: 1, streams: 0 });
    expect(deps.questions.listOpen()).toHaveLength(1);
    expect(events().filter((e) => e.kind === 'home_migrated')).toHaveLength(2);
  });

  test('a migrated built-in is found by ensureBuiltinKnowledge, not created twice', async () => {
    const id = writeLegacyRule(home, 'pattern', 'action', {
      name: 'no_push_protected',
      pattern: { kind: 'no_push_protected', args: {} },
      provenance: { by: 'builtin' },
      critical: true,
    });
    await migrateHome(deps);
    const builtins = await ensureBuiltinKnowledge(store);
    expect(builtins[0]?.id).toBe(`K-${id.slice(2)}`);
    expect(store.listKnowledge()).toHaveLength(3);
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

  // T337: the migration updates streams during startup, so every service the
  // stream update hook names must exist by then (T324's push was in its TDZ).
  test('startup migration runs the update hook cleanly; the status push still runs after', async () => {
    const { loose } = await seedOldHome();
    const jira = await startFakeJira();
    try {
      await store.setTrackerSettings('jira', {
        base_url: jira.baseUrl,
        email: jira.email,
        token: jira.token,
      });
      jira.addIssue({ key: 'SHOP-11', title: 'Sale prices' });
      previousHome = process.env.AGILE_HOME;
      process.env.AGILE_HOME = home;
      const errors = spyOn(console, 'error');
      try {
        handle = await startDaemon({
          port: 0,
          socketPath: join(home, 'd.sock'),
          githubAuth: async () => false,
        });
        const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        expect(logged).not.toContain('update hook failed');
        expect(logged).not.toContain('before initialization');
      } finally {
        errors.mockRestore();
      }
      expect(events().filter((e) => e.kind === 'home_migrated')).toHaveLength(1);

      const daemonStore = handle.store as StateStore;
      const daemonStreams = handle.streamService as StreamService;
      const migrated = daemonStore.getStream(loose.id);
      expect(migrated.project).toBeDefined();
      await new ProjectService(daemonStore, daemonStreams).update(migrated.project as string, {
        tracker: { system: 'jira', push_status: true, status_map: { in_progress: 'In Progress' } },
      });
      const port = createJira({ base_url: jira.baseUrl, email: jira.email, token: jira.token });
      await new TrackerLinks({
        streams: daemonStreams,
        project: (id) => daemonStore.getProject(id),
        configured: () => ['jira'],
        tracker: () => port,
      }).link(loose.id, 'SHOP-11', { system: 'jira' });
      await daemonStreams.update('agent', loose.id, { agent: { status: 'working' } });
      const deadline = Date.now() + 5000;
      const status = () => jira.issues.find((i) => i.key === 'SHOP-11')?.status;
      while (status() !== 'In Progress' && Date.now() < deadline) await Bun.sleep(20);
      expect(status()).toBe('In Progress');
    } finally {
      await jira.stop();
    }
  });
});
