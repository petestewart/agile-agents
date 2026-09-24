/**
 * T287 (projects-design §9.4, "Collisions go to the parent's agent first"):
 * with a fake (scripted) coordinator, an overlap between two children
 * reaches the parent with its options; at Organise the scripted
 * `add_waits_on` is applied and the thread says so; `note_child` sends a
 * targeted note; a child's merge reaches the parent before the same-repo
 * sync announces. Real temp git repo and state home; no vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type RoutedEvent, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import {
  type EmitRouted,
  RoutedEventService,
  emitTransitions,
  makeEmitter,
  summarize,
} from '../events';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { MainSync, OverlapTracker } from '../sync';
import { type ActOutcome, AutonomyService } from './autonomy';
import { ContractService } from './contracts';
import { PlanService } from './plans';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let events: RoutedEventService;
let emitted: RoutedEvent[];
let emit: EmitRouted;
let verbs: VerbService;

function sh(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-collide-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-collide-repo-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 't@example.com'], repo);
  sh(['config', 'user.name', 'T'], repo);
  writeFileSync(join(repo, 'prices.ts'), 'export const a = 1;\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);
  store = StateStore.open(runInit(home).stateRoot);
  await store.putRepos({ api: { path: repo } });
  emitted = [];
  events = new RoutedEventService(store);
  // Record changes produce child_delivered etc., as the daemon wires it.
  streams = new StreamService(store, {
    onUpdated: async (before, after) => emitTransitions(emit)(before, after),
  });
  const base = makeEmitter(events, streams);
  emit = async (input) => {
    const e = await base(input);
    if (e) emitted.push(e);
    return e;
  };
  const contracts = new ContractService({ store, streams });
  const plans = new PlanService({ store, streams, contracts });
  const autonomy = new AutonomyService({ store, streams, plans, contracts });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  verbs = new VerbService({
    store,
    streams,
    questions,
    plans,
    contracts,
    autonomy,
    events,
    emitRouted: emit,
  });
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function child(parent: string, title: string, branch: string): Promise<Stream> {
  const node = await streams.create('human', { title, goal: 'g', parent, repo: 'api' });
  const wt = join(repo, '.worktrees', branch);
  sh(['worktree', 'add', '-q', wt, '-b', branch, 'main'], repo);
  await store.updateStream('daemon', node.id, (s) => ({ ...s, worktree: wt }));
  return streams.get(node.id);
}

async function shop() {
  const projects = new ProjectService(store, streams);
  const project = await projects.create({ name: 'Shop' });
  await projects.update(project.id, { autonomy: { coordinator: 'organise' } });
  const parent = await streams.create('human', {
    title: 'Sale prices',
    goal: 'g',
    project: project.id,
  });
  const api = await child(parent.id, 'api', 'stream/api');
  const web = await child(parent.id, 'web', 'stream/web');
  const coordinator = ulid();
  await store.putAgent(coordinator as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    stream: parent.id,
    last_seen: new Date().toISOString(),
    role: 'coordinator',
  });
  return { parent, api, web, coordinator };
}

const title = (id: string) => streams.get(id).title;

describe('collisions go to the parent (T287)', () => {
  test('an overlap reaches the parent; at Organise the scripted add_waits_on applies and the thread tells you', async () => {
    const { parent, api, web, coordinator } = await shop();
    const tracker = new OverlapTracker({
      streams,
      repos: () => store.getRepos(),
      intervalMs: 0,
      emit,
    });
    writeFileSync(join(api.worktree as string, 'prices.ts'), 'export const a = 2;\n');
    writeFileSync(join(web.worktree as string, 'prices.ts'), 'export const a = 3;\n');
    await tracker.recomputeAll();

    // The parent's pending deliveries carry the overlap, with its options.
    const pending = events.pendingFor(parent.id).map((d) => d.event);
    const overlap = pending.find((e) => e.type === 'overlap');
    expect(overlap).toBeDefined();
    const told = summarize(overlap as RoutedEvent, parent.id, title);
    expect(told).toContain('both changed prices.ts');
    expect(told).toContain('`add_waits_on`');
    expect(told).toContain('`set_owner`');

    // The fake coordinator: web waits on api, then tells web why.
    const out = (await verbs.addWaitsOn({
      session: coordinator,
      child: web.id,
      on: api.id,
    })) as ActOutcome;
    expect(out.applied).toBe(true);
    expect(streams.get(web.id).waits_on?.map((w) => w.node)).toEqual([api.id]);
    const thread = streams.readThread(parent.id).entries;
    expect(thread.map((e) => e.body)).toContain('coordinator (organise) applied: web waits on api');

    const note = await verbs.noteChild({
      session: coordinator,
      child: web.id,
      body: 'api owns prices.ts; wait for it to merge.',
    });
    const sent = emitted.find((e) => e.id === note.event) as RoutedEvent;
    expect(sent.type).toBe('coordinator_note');
    expect(sent.routing).toEqual([{ node: web.id, because: 'self' }]);
    expect(summarize(sent, web.id, title)).toBe(
      'Your coordinator says: api owns prices.ts; wait for it to merge.',
    );
  });

  test('note_child is a coordinator verb, to its own children only', async () => {
    const { parent, web, coordinator } = await shop();
    const worker = ulid();
    await store.putAgent(worker as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: web.id,
      last_seen: new Date().toISOString(),
      role: 'worker',
    });
    await expect(verbs.noteChild({ session: worker, child: web.id, body: 'x' })).rejects.toThrow(
      'only a coordinator',
    );
    await expect(
      verbs.noteChild({ session: coordinator, child: parent.id, body: 'x' }),
    ).rejects.toThrow('not a child');
  });

  test("a child's merge reaches the parent before the same-repo sync announces", async () => {
    const { parent, api, web } = await shop();
    const sync = new MainSync({ streams, repos: () => store.getRepos(), intervalMs: 0, emit });
    // The delivery path: the record goes merged, then main moved.
    writeFileSync(join(api.worktree as string, 'prices.ts'), 'export const a = 2;\n');
    sh(['commit', '-qam', 'api'], api.worktree as string);
    sh(['merge', '-q', '--ff-only', 'stream/api'], repo);
    await streams.update('daemon', api.id, {
      human: { status: 'landed' },
      delivery_state: { mode: 'direct', status: 'merged', at: new Date().toISOString() },
    });
    await sync.mainMoved('api', api.id);

    const types = emitted.map((e) => e.type);
    const delivered = types.indexOf('child_delivered');
    expect(delivered).toBeGreaterThanOrEqual(0);
    expect(delivered).toBeLessThan(types.indexOf('main_changed'));
    const toParent = emitted[delivered] as RoutedEvent;
    expect(toParent.routing[0]).toEqual({ node: parent.id, because: 'ancestor' });
    expect(summarize(toParent, parent.id, title)).toContain('`note_child`');
    const mainChanged = emitted.find((e) => e.type === 'main_changed') as RoutedEvent;
    expect(mainChanged.routing.map((r) => r.node)).toContain(web.id);
  });
});
