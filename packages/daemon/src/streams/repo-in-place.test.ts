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
  return nodeRole(streams.get(id), liveChildrenOf(id, streams.list()));
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

  test('T213: conversation → + api → + web leaves both parts and the coordinator running', async () => {
    const node = await conversation();
    await attach.attach(node.id);
    await reshape.addRepo(node.id, 'api');
    const { parts } = await reshape.addRepo(node.id, 'web');

    expect(parts).toHaveLength(2);
    expect(roleOf(node.id)).toBe('coordinating');
    expect(attach.handleFor(node.id)).toBeDefined();
    for (const part of parts) {
      expect(attach.handleFor(part.id)).toBeDefined();
      const live = streams.get(part.id).sessions.find((s) => s.status === 'running');
      expect(live?.worktree).toBe(part.worktree);
    }
    // The deliberate stops say why, not an exit code.
    const stops = bodies(node.id).filter((b) => b.startsWith('worker stopped: '));
    expect(stops).toEqual([
      'worker stopped: node reshaped into a work node',
      'worker stopped: node reshaped into parts',
    ]);
    expect(bodies(node.id).some((b) => b.includes('process exited'))).toBe(false);
  }, 60_000);

  test('T336: a node whose session ended still gets its coordinator; parts get their share', async () => {
    const node = await conversation();
    await attach.attach(node.id);
    await reshape.addRepo(node.id, 'api');
    // Ended on its own (not a human's detach): `done`, nothing live.
    await attach.stop(node.id);
    expect(streams.get(node.id).agent.status).toBe('done');
    const { parts } = await reshape.addRepo(node.id, 'web');

    expect(attach.handleFor(node.id)).toBeDefined();
    const coordinator = streams.get(node.id).sessions.at(-1);
    expect(coordinator?.status).toBe('running');
    expect(coordinator?.worktree).toBeUndefined();
    for (const part of parts) expect(attach.handleFor(part.id)).toBeDefined();
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
    expect(attach.handleFor(node.id)).toBeDefined();
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
