/**
 * T205: "+ Repo" in place (projects-design §7) against real git repos, a
 * real state home and the fake agent (no vendor, no network).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import { type Stream, liveChildrenOf, nodeRole } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { ContractService } from '../coordination/contracts';
import { PlanService } from '../coordination/plans';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { StateStore } from '../store';
import { RepoInPlaceError, RepoInPlaceService } from './repo-in-place';
import { StreamService } from './service';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let scratch: string;
let api: string;
let web: string;
let store: StateStore;
let streams: StreamService;
let attach: AttachService;
let reshape: RepoInPlaceService;
let projectId: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function roleOf(id: string): string {
  const all = streams.list();
  return nodeRole(streams.get(id), liveChildrenOf(id, all), all);
}

function bodies(id: string): string[] {
  return streams.readThread(id, { limit: 500 }).entries.map((e) => e.body);
}

async function conversation(): Promise<Stream> {
  return streams.create('human', { title: 'Sale prices', goal: 'can we?', project: projectId });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-rip-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-rip-scratch-'));
  api = makeRepo('agile-rip-api-');
  web = makeRepo('agile-rip-web-');
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  const script = join(scratch, 'script.json');
  // Hangs inside its turn, so the session stays live until stopped.
  writeFileSync(
    script,
    JSON.stringify({
      steps: [
        { type: 'agent_text', text: 'thinking' },
        { type: 'tool_call', toolCallId: 't1', title: 'read' },
        { type: 'hang' },
      ],
    }),
  );
  attach = new AttachService({
    store,
    streams,
    home,
    provider: () => ({
      ...ACP_PROVIDERS.claude,
      command: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { AGILE_FAKE_AGENT_SCRIPT: script },
    }),
  });
  reshape = new RepoInPlaceService(store, streams, {
    attach: (id) => attach.attach(id),
    stop: (id, reason) => attach.stop(id, undefined, reason !== undefined ? { reason } : {}),
  });
  await store.putRepos({
    api: { path: api, protected_branches: ['main'] },
    web: { path: web, protected_branches: ['main'] },
  });
  projectId = (await new ProjectService(store, streams).create({ name: 'Shop' })).id;
});

afterEach(async () => {
  await attach.stopAll();
  await store.flush();
  store.close();
  for (const dir of [home, scratch, api, web]) rmSync(dir, { recursive: true, force: true });
});

describe('T205 + Repo in place', () => {
  test('conversation + api: becomes a work node with a branch and worktree, same thread', async () => {
    const node = await conversation();
    await streams.appendThread('human', node.id, {
      kind: 'line',
      body: 'can we show sale prices?',
    });
    expect(roleOf(node.id)).toBe('conversation');

    const { node: after, parts } = await reshape.addRepo(node.id, 'api');

    expect(parts).toEqual([]);
    expect(roleOf(node.id)).toBe('work');
    expect(after.repo).toBe('api');
    expect(after.branch?.startsWith('stream/')).toBe(true);
    expect(existsSync(after.worktree ?? '')).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], after.worktree ?? '')).toBe(
      after.branch ?? '',
    );
    expect(bodies(node.id)).toContain('can we show sale prices?');
  }, 30_000);

  test('a live conversation session is restarted in the new worktree', async () => {
    const node = await conversation();
    await attach.attach(node.id);
    expect(streams.get(node.id).sessions[0]?.worktree).toBeUndefined();

    const { node: after } = await reshape.addRepo(node.id, 'api');

    expect(after.sessions).toHaveLength(2);
    expect(after.sessions[0]?.status).toBe('stopped');
    expect(after.sessions[1]?.worktree).toBe(after.worktree);
    expect(attach.handleFor(node.id)).toBeDefined();
  }, 30_000);

  /** The plan service as the daemon wires it: approval starts the waiting parts. */
  function planService(): PlanService {
    return new PlanService({
      store,
      streams,
      contracts: new ContractService({ store, streams }),
      start: (id) => attach.startWithPending(id),
    });
  }

  test('T213/T336: conversation → + api → + web: the coordinator runs, the parts wait for the plan', async () => {
    const plans = planService();
    const node = await conversation();
    await attach.attach(node.id);
    await reshape.addRepo(node.id, 'api');
    const { parts } = await reshape.addRepo(node.id, 'web');

    expect(parts).toHaveLength(2);
    expect(roleOf(node.id)).toBe('coordinating');
    expect(attach.handleFor(node.id, 'coordinator')).toBeDefined();
    // §9.1: the plan comes before work. Nothing runs in a part yet.
    for (const part of parts) {
      expect(attach.handleFor(part.id)).toBeUndefined();
      expect(plans.waitingForPlan(streams.get(part.id))).toBe(true);
      expect(bodies(part.id)).toContain(
        `waiting for the plan: this part starts when "Sale prices"'s plan is approved`,
      );
      // T347 (D36 D12): the "read it by id" pointer is for the part's agent only.
      const pointer = streams
        .readThread(part.id, { limit: 50 })
        .entries.find((e) => e.body.endsWith('read it by id'));
      expect(pointer?.agent_only).toBe(true);
      expect(
        streams
          .readThread(part.id, { limit: 50 })
          .entries.filter((e) => e.body.startsWith('waiting for the plan'))
          .every((e) => e.agent_only === undefined),
      ).toBe(true);
    }
    expect(
      bodies(node.id).some((b) => b.includes('wait for the plan: write it with plan_write')),
    ).toBe(true);
    // The deliberate stops say why, not an exit code.
    const stops = bodies(node.id).filter((b) => b.startsWith('worker stopped: '));
    expect(stops).toEqual([
      'worker stopped: node reshaped into a work node',
      'worker stopped: node reshaped into parts',
    ]);
    expect(bodies(node.id).some((b) => b.includes('process exited'))).toBe(false);

    // A draft is not enough; the approval starts each part in its own worktree.
    const [apiPart, webPart] = parts as [Stream, Stream];
    await plans.write(node.id, [
      { child: apiPart.id, owns: ['src/prices.ts'] },
      { child: webPart.id, owns: ['shop.html'] },
    ]);
    expect(attach.handleFor(apiPart.id)).toBeUndefined();
    await plans.approve(node.id);
    for (const part of parts) {
      expect(attach.handleFor(part.id)).toBeDefined();
      const live = streams.get(part.id).sessions.find((s) => s.status === 'running');
      expect(live?.worktree).toBe(streams.get(part.id).worktree);
      expect(plans.waitingForPlan(streams.get(part.id))).toBe(false);
    }
  }, 60_000);

  test('T336: a node whose session ended still gets its coordinator; parts get their share', async () => {
    const plans = planService();
    const node = await conversation();
    await attach.attach(node.id);
    await reshape.addRepo(node.id, 'api');
    // Ended on its own (not a human's detach): `done`, nothing live.
    await attach.stop(node.id);
    expect(streams.get(node.id).agent.status).toBe('done');
    const { parts } = await reshape.addRepo(node.id, 'web');

    expect(attach.handleFor(node.id, 'coordinator')).toBeDefined();
    const coordinator = streams.get(node.id).sessions.at(-1);
    expect(coordinator?.role).toBe('coordinator');
    expect(coordinator?.status).toBe('running');
    expect(coordinator?.worktree).toBeUndefined();
    for (const part of parts) {
      expect(attach.handleFor(part.id)).toBeUndefined();
      expect(plans.waitingForPlan(streams.get(part.id))).toBe(true);
    }
    expect(parts.map((p) => p.goal)).toEqual(['api share of: can we?', 'web share of: can we?']);
  }, 60_000);

  test('T336: a detached node split into parts gets no coordinator', async () => {
    const node = await conversation();
    await attach.attach(node.id);
    await reshape.addRepo(node.id, 'api');
    await attach.stop(node.id, undefined, { detach: true });
    await reshape.addRepo(node.id, 'web');
    expect(attach.handleFor(node.id)).toBeUndefined();
    expect(streams.get(node.id).sessions).toEqual([]);
  }, 60_000);

  test('T213: a node never started keeps its parts unstarted', async () => {
    const node = await conversation();
    await reshape.addRepo(node.id, 'api');
    const { parts } = await reshape.addRepo(node.id, 'web');
    for (const part of parts) expect(attach.handleFor(part.id)).toBeUndefined();
  }, 60_000);

  test('work + web: coordinating; the api part keeps the branch, commits and sessions', async () => {
    const node = await conversation();
    await attach.attach(node.id);
    const work = (await reshape.addRepo(node.id, 'api')).node;
    const wt = work.worktree ?? '';
    writeFileSync(join(wt, 'price.ts'), 'export const sale = 1;\n');
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'sale price'], wt);
    const head = git(['rev-parse', 'HEAD'], wt);
    const sessionIds = streams.get(node.id).sessions.map((s) => s.id);

    const { node: after, parts } = await reshape.addRepo(node.id, 'web');

    expect(roleOf(node.id)).toBe('coordinating');
    expect(after.repo).toBeUndefined();
    expect(after.branch).toBeUndefined();
    expect(after.worktree).toBeUndefined();
    const [apiPart, webPart] = parts;
    expect(apiPart?.title).toBe('api part');
    expect(apiPart?.parent).toBe(node.id);
    expect(apiPart?.branch).toBe(work.branch);
    expect(apiPart?.worktree).toBe(wt);
    expect(git(['rev-parse', work.branch ?? ''], api)).toBe(head);
    // The moved history, then T213's restart in the part's worktree.
    expect(apiPart?.sessions.map((s) => s.id).slice(0, sessionIds.length)).toEqual(sessionIds);
    expect(apiPart?.sessions.at(-1)?.worktree).toBe(wt);
    expect(roleOf(apiPart?.id ?? '')).toBe('work');
    expect(webPart?.title).toBe('web part');
    expect(webPart?.repo).toBe('web');
    expect(roleOf(webPart?.id ?? '')).toBe('work');
    // The thread pointer, and the chat carries on at the node as the coordinator.
    expect(streams.readThread(webPart?.id ?? '').entries.some((e) => e.ref === node.id)).toBe(true);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]?.worktree).toBeUndefined();
    expect(attach.handleFor(node.id, 'coordinator')).toBeDefined();
  }, 30_000);

  test('switch with nothing committed: the empty part is closed, the node is on web', async () => {
    const node = await conversation();
    const work = (await reshape.addRepo(node.id, 'api')).node;

    const { parts } = await reshape.switchRepo(node.id, 'web');

    const [apiPart, webPart] = parts;
    expect(apiPart?.human.status).toBe('closed');
    expect(existsSync(work.worktree ?? '')).toBe(false);
    expect(webPart?.human.status).toBe('open');
    expect(roleOf(node.id)).toBe('coordinating');
    expect(liveChildrenOf(node.id, streams.list()).map((c) => c.repo)).toEqual(['web']);
  }, 30_000);

  test('switch refuses a branch with commits; add-repo refuses the same repo and a project', async () => {
    const node = await conversation();
    const work = (await reshape.addRepo(node.id, 'api')).node;
    const wt = work.worktree ?? '';
    writeFileSync(join(wt, 'x.ts'), 'x\n');
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'x'], wt);

    await expect(reshape.switchRepo(node.id, 'web')).rejects.toThrow(RepoInPlaceError);
    await expect(reshape.addRepo(node.id, 'api')).rejects.toThrow(/already works in api/);
    const root = streams.get(node.id).parent ?? '';
    await expect(reshape.addRepo(root, 'api')).rejects.toThrow(RepoInPlaceError);
    await expect(reshape.addRepo(node.id, 'nope')).rejects.toThrow(/unknown repo/);
    expect(roleOf(node.id)).toBe('work');
  }, 30_000);

  test('D33/T346: conversation with a tangent + api: the repo goes to a part that waits for the plan', async () => {
    const plans = planService();
    const node = await conversation();
    const tangent = await streams.create('human', {
      title: 'Why slow?',
      goal: 'why are prices slow?',
      parent: node.id,
    });
    await attach.attach(node.id);
    expect(roleOf(node.id)).toBe('conversation');

    const { node: after, parts } = await reshape.addRepo(node.id, 'api');

    expect(parts.map((p) => p.title)).toEqual(['api part']);
    expect(attach.handleFor(node.id, 'coordinator')).toBeDefined();
    expect(roleOf(node.id)).toBe('coordinating');
    expect(roleOf(tangent.id)).toBe('conversation');
    expect(after.repo).toBeUndefined();
    expect(after.worktree).toBeUndefined();
    expect(after.branch).toBeUndefined();
    const [part] = parts;
    expect(roleOf(part?.id ?? '')).toBe('work');
    expect(bodies(node.id)).toContain(
      'repo added: api; now coordinating api part beside its tangents',
    );
    expect(bodies(node.id).some((b) => b.includes('now a work node'))).toBe(false);
    // T346: one part waits for the plan like a split's parts (§9.1).
    const partId = part?.id ?? '';
    expect(attach.handleFor(partId)).toBeUndefined();
    expect(plans.waitingForPlan(streams.get(partId))).toBe(true);
    expect(bodies(partId)).toContain(
      `waiting for the plan: this part starts when "Sale prices"'s plan is approved`,
    );
    expect(bodies(node.id)).toContain(
      'api part waits for the plan: write it with plan_write (who owns which paths); each part starts once the plan is approved',
    );
    expect(attach.handleFor(tangent.id)).toBeUndefined();

    // The approval starts it in its worktree.
    await plans.write(node.id, [{ child: partId, owns: ['src/prices.ts'] }]);
    expect(attach.handleFor(partId)).toBeUndefined();
    await plans.approve(node.id);
    expect(attach.handleFor(partId)).toBeDefined();
    const live = streams.get(partId).sessions.find((s) => s.status === 'running');
    expect(existsSync(streams.get(partId).worktree ?? '')).toBe(true);
    expect(live?.worktree).toBe(streams.get(partId).worktree);
    expect(plans.waitingForPlan(streams.get(partId))).toBe(false);
  }, 60_000);

  test('T346: a conversation with tangents whose session ended gets its coordinator; the part waits', async () => {
    const plans = planService();
    const node = await conversation();
    await streams.create('human', { title: 'Why slow?', goal: 'why?', parent: node.id });
    await attach.attach(node.id);
    await attach.stop(node.id);
    expect(streams.get(node.id).agent.status).toBe('done');

    const { parts } = await reshape.addRepo(node.id, 'api');

    expect(attach.handleFor(node.id, 'coordinator')).toBeDefined();
    const [part] = parts as [Stream];
    expect(attach.handleFor(part.id)).toBeUndefined();
    expect(plans.waitingForPlan(streams.get(part.id))).toBe(true);
  }, 60_000);

  test('T346: a human-stopped conversation with tangents: no coordinator, the part starts as before', async () => {
    const plans = planService();
    const node = await conversation();
    await streams.create('human', { title: 'Why slow?', goal: 'why?', parent: node.id });
    await attach.attach(node.id);
    await attach.stop(node.id, undefined, { detach: true });

    const { parts } = await reshape.addRepo(node.id, 'api');

    expect(attach.handleFor(node.id)).toBeUndefined();
    const [part] = parts as [Stream];
    expect(attach.handleFor(part.id)).toBeDefined();
    expect(plans.waitingForPlan(streams.get(part.id))).toBe(false);
    expect(bodies(part.id).some((b) => b.startsWith('waiting for the plan: '))).toBe(false);
  }, 60_000);

  test('coordinating + another repo adds one more part', async () => {
    const node = await conversation();
    await reshape.addRepo(node.id, 'api');
    await reshape.addRepo(node.id, 'web');
    await store.addRepo('docs', { path: web, protected_branches: ['main'] });

    const { parts } = await reshape.addRepo(node.id, 'docs');

    expect(parts.map((p) => p.title)).toEqual(['docs part']);
    expect(liveChildrenOf(node.id, streams.list())).toHaveLength(3);
  }, 30_000);

  test('a split that fails midway puts the node back and archives the part it made', async () => {
    const node = await conversation();
    const work = (await reshape.addRepo(node.id, 'api')).node;
    const create = streams.create.bind(streams);
    let calls = 0;
    streams.create = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('injected failure');
      return create(...args);
    };

    await expect(reshape.addRepo(node.id, 'web')).rejects.toThrow('injected failure');
    streams.create = create;

    const after = streams.get(node.id);
    expect(after.repo).toBe('api');
    expect(after.branch).toBe(work.branch);
    expect(after.worktree).toBe(work.worktree);
    expect(roleOf(node.id)).toBe('work');
    const parts = streams.list({ include_archived: true }).filter((s) => s.parent === node.id);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.archived).toBe(true);
    expect(parts[0]?.branch).toBeUndefined();
  }, 30_000);
});
