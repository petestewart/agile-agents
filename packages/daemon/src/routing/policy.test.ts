import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ModelPolicyService, STAMP_LINE } from './policy';
import { buildModelPolicyRpcMethods } from './rpc';

let home: string;
let stateRoot: string;
let store: StateStore;
let streams: StreamService;
let routing: ModelPolicyService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-routing-'));
  stateRoot = runInit(home).stateRoot;
  store = StateStore.open(stateRoot);
  streams = new StreamService(store);
  routing = new ModelPolicyService({ store, streams });
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function rootLines(root: string): string[] {
  return streams.readThread(root, { limit: 100 }).entries.map((e) => e.body);
}

describe('T482: the one-time stamp (D54)', () => {
  test('a project with no model_policy is stamped Default once, with a line on its root; new ones are not', async () => {
    const projects = new ProjectService(store, streams);
    const old = await projects.create({ name: 'old' });
    // What a project written before T482 looks like: no field at all.
    await store.updateProject(old.id, (p) => {
      const { model_policy: _none, ...rest } = p;
      return rest;
    });
    const fresh = await projects.create({ name: 'fresh' });
    expect(store.getProject(fresh.id).model_policy).toEqual({});

    expect(await routing.stampExistingProjects()).toEqual([old.id]);
    expect(store.getProject(old.id).model_policy).toEqual({ mode: 'default', presets: [] });
    expect(store.getProject(fresh.id).model_policy).toEqual({});
    expect(rootLines(old.root).filter((b) => b === STAMP_LINE)).toHaveLength(1);
    expect(rootLines(fresh.root)).not.toContain(STAMP_LINE);
    // It went through the validating store (a project_updated event).
    expect(readFileSync(join(stateRoot, 'log', 'events.jsonl'), 'utf8')).toContain(
      'project_updated',
    );

    // Idempotent: a second daemon start stamps nothing and writes no second line.
    expect(await routing.stampExistingProjects()).toEqual([]);
    expect(rootLines(old.root).filter((b) => b === STAMP_LINE)).toHaveLength(1);

    // A stamped project resolves Default over the home's Choose; the new one inherits Choose.
    const oldNode = await streams.create('human', { title: 'a', goal: 'g', project: old.id });
    const freshNode = await streams.create('human', { title: 'b', goal: 'g', project: fresh.id });
    expect(routing.resolveFor(streams.get(oldNode.id)).policy.mode).toBe('default');
    expect(routing.resolveFor(streams.get(freshNode.id)).policy.mode).toBe('choose');

    // Nothing moves: with favourites set, the stamped project still starts on its default.
    await store.setFavouriteModel({ vendor: 'claude', model: 'claude-haiku-4-5' }, true);
    expect(routing.nextPick(streams.get(oldNode.id))).toMatchObject({
      vendor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'low',
      how: 'default',
    });
    // A new project picks inside the favourites (the presets that ship, D54).
    expect(routing.nextPick(streams.get(freshNode.id))).toMatchObject({
      model: 'claude-haiku-4-5',
      how: 'rule',
    });
  });
});

describe('T482: a node’s policy is the operator’s', () => {
  test('the store refuses an agent, coordinator or Director write of human.model_policy', async () => {
    const node = await streams.create('human', { title: 'a', goal: 'g' });
    for (const who of ['agent', 'coordinator', 'director'] as const) {
      await expect(
        store.updateStream(who, node.id, (s) => ({
          ...s,
          human: { ...s.human, model_policy: { mode: 'choose' } },
        })),
      ).rejects.toThrow(/may not change human/);
      await expect(
        store.updateStream(who, node.id, (s) => ({
          ...s,
          human: { ...s.human, choose_again: true },
        })),
      ).rejects.toThrow(/may not change human/);
    }
    expect(streams.get(node.id).human.model_policy).toBeUndefined();
    await routing.setNode(node.id, { mode: 'inherit' });
    expect(streams.get(node.id).human.model_policy).toEqual({ mode: 'inherit' });
    await routing.setNode(node.id, { mode: null });
    expect(streams.get(node.id).human.model_policy).toBeUndefined();
  });

  test('a policy on a coordinator governs its subtree, nearest first, over the project', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'shop' });
    await routing.setProject(project.id, { mode: 'default', quality: 10 });
    const coordinator = await streams.create('human', {
      title: 'Billing',
      goal: 'g',
      project: project.id,
    });
    const part = await streams.create('human', {
      title: 'Invoices',
      goal: 'g',
      project: project.id,
      parent: coordinator.id,
    });
    await routing.setNode(coordinator.id, { mode: 'inherit' });
    const view = routing.nodeView(part.id);
    expect(view.resolved.policy.mode).toBe('inherit');
    expect(view.resolved.sources.mode).toEqual({
      from: 'ancestor',
      id: coordinator.id,
      title: 'Billing',
    });
    expect(view.resolved.sources.quality).toMatchObject({ from: 'project', id: project.id });
    // The root's layer is the project's.
    expect(routing.nodeView(project.root).resolved.sources.mode.from).toBe('project');
  });
});

describe('T482: policy.* RPC (`agile policy`)', () => {
  test('show and set each layer; a bad field or value is a param error', async () => {
    const rpc = buildModelPolicyRpcMethods(routing);
    const call = async (m: string, p?: unknown) => rpc[m]?.(p as never);
    const shown = (await call('policy.show', {})) as { resolved: { policy: { mode: string } } };
    expect(shown.resolved.policy.mode).toBe('choose');
    await call('policy.set', { patch: { mode: 'default' } });
    expect(store.getHomeConfig().model_policy).toEqual({ mode: 'default' });
    const project = await new ProjectService(store, streams).create({ name: 'shop' });
    await call('policy.set', { project: project.id, patch: { escalation: 'strongest_first' } });
    expect(store.getProject(project.id).model_policy).toEqual({ escalation: 'strongest_first' });
    const node = await streams.create('human', { title: 'a', goal: 'g', project: project.id });
    await call('policy.set', { node: node.id, patch: { quality: 70 } });
    const nodeView = (await call('policy.show', { node: node.id })) as {
      resolved: { sources: Record<string, { from: string }> };
    };
    expect(nodeView.resolved.sources.quality?.from).toBe('node');
    expect(nodeView.resolved.sources.escalation?.from).toBe('project');
    expect(nodeView.resolved.sources.mode?.from).toBe('home');
    await call('policy.set', { profiles: { 'claude/sonnet': { tier: 'fast', cost: 0.5 } } });
    expect(store.getHomeConfig().model_profiles).toEqual({
      'claude/sonnet': { tier: 'fast', cost: 0.5 },
    });
    await expect(call('policy.set', { patch: { mode: 'always' } })).rejects.toThrow(/model policy/);
    await expect(
      call('policy.set', { project: project.id, node: node.id, patch: {} }),
    ).rejects.toThrow(/not both/);
    await expect(call('policy.show', { project: 'P-nope' })).rejects.toThrow(/P-<ulid>/);
  });
});
