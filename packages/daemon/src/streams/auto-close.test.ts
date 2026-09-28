/**
 * T478: a node set to auto-close closes itself when its goal is met, and a
 * coordinating one when every part is merged or closed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stream, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { AutoClose, type AutoClosePreflight, MET_NOTE, PARTS_NOTE } from './auto-close';
import { StreamService } from './service';

let repo: string;
let store: StateStore;
let streams: StreamService;
let auto: AutoClose | undefined;
let pre: Record<string, AutoClosePreflight>;
let dirty: Set<string>;
let root: Stream;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-auto-close-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial'], { cwd: repo });
  store = StateStore.open(runInit(repo).stateRoot);
  pre = {};
  dirty = new Set();
  // The hook runs as the daemon wires it: after every update, awaited here so tests read the end state.
  streams = new StreamService(store, {
    onUpdated: async (before, after) => {
      await auto?.onUpdated(before, after);
    },
  });
  auto = new AutoClose({
    streams,
    preflight: (id) => {
      const p = pre[id];
      if (p === undefined) throw new Error(`no branch for ${id}`);
      return p;
    },
    uncommitted: (node) => dirty.has(node.id),
  });
  root = await streams.create('human', { title: 'Shop', goal: 'the shop' });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A turn of `node`'s agent: a worker session that runs, maybe says `goal_met`, and ends `done`. */
async function turn(node: string, options: { met?: boolean } = {}): Promise<string> {
  const session = ulid();
  // As attach records a session (the store directly, as `pushSession` does).
  await store.updateStream('daemon', node, (before) => ({
    ...before,
    sessions: [
      ...before.sessions,
      { id: session, vendor: 'claude', model: 'm', role: 'worker', status: 'running' },
    ],
  }));
  await streams.update('daemon', node, { agent: { status: 'working' } });
  if (options.met === true) {
    await streams.update('agent', node, {
      agent: { goal_met: { session, at: new Date().toISOString(), summary: 'done it' } },
    });
  }
  await streams.update('daemon', node, { agent: { status: 'done' } });
  return session;
}

async function node(input: { goal?: string; auto_close?: boolean; parent?: string }) {
  return streams.create('human', {
    title: 'n',
    parent: input.parent ?? root.id,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.auto_close !== undefined ? { auto_close: input.auto_close } : {}),
  });
}

describe('AutoClose', () => {
  test('a node whose agent said goal_met, with nothing to merge, closes with its reason', async () => {
    const n = await node({ goal: 'count files', auto_close: true });
    await turn(n.id, { met: true });
    const after = streams.get(n.id);
    expect(after.human.status).toBe('closed');
    expect(after.human.note).toBe(MET_NOTE);
    expect(streams.readThread(n.id).entries.at(-1)?.body).toBe(`closed: ${MET_NOTE}`);
  });

  test('a finished turn without goal_met, or goal_met in an earlier turn, leaves it open', async () => {
    const n = await node({ goal: 'count files', auto_close: true });
    await turn(n.id);
    expect(streams.get(n.id).human.status).toBe('open');
    // A goal_met from an earlier session doesn't count for a later turn.
    await streams.update('agent', n.id, {
      agent: { goal_met: { session: ulid(), at: new Date().toISOString(), summary: 'old' } },
    });
    await turn(n.id);
    expect(streams.get(n.id).human.status).toBe('open');
  });

  test('off, or with no goal, it never closes itself', async () => {
    const off = await node({ goal: 'count files' });
    await turn(off.id, { met: true });
    expect(streams.get(off.id).human.status).toBe('open');
    const bare = await node({ auto_close: true });
    await turn(bare.id, { met: true });
    expect(streams.get(bare.id).human.status).toBe('open');
  });

  test('commits to merge, a conflict or uncommitted changes keep it open (Ready to merge)', async () => {
    const withBranch = async (p: AutoClosePreflight, isDirty = false) => {
      const n = await node({ goal: 'fix it', auto_close: true });
      await streams.update('daemon', n.id, { branch: `stream/${n.id}`, worktree: `/wt/${n.id}` });
      pre[n.id] = p;
      if (isDirty) dirty.add(n.id);
      await turn(n.id, { met: true });
      return streams.get(n.id).human.status;
    };
    expect(await withBranch({ ahead: 2 })).toBe('open');
    // A preflight that couldn't count the branch (a live agent, no target) is no "nothing".
    expect(await withBranch({})).toBe('open');
    expect(await withBranch({ ahead: 0, conflicts: ['a.ts'] })).toBe('open');
    expect(await withBranch({ ahead: 0 }, true)).toBe('open');
    expect(await withBranch({ ahead: 0 })).toBe('closed');
    // Already merged by hand: nothing left to merge.
    expect(await withBranch({ ahead: 0, merged: true })).toBe('closed');
  });

  test('a part inherits auto-close; the coordinating node closes when every part is merged or closed', async () => {
    const lead = await node({ goal: 'ship search', auto_close: true });
    const a = await streams.create('coordinator', { title: 'a', goal: 'index', parent: lead.id });
    const b = await streams.create('coordinator', { title: 'b', goal: 'query', parent: lead.id });
    expect(a.auto_close).toBe(true);
    // Its own goal_met doesn't close it while parts are open.
    await turn(lead.id, { met: true });
    expect(streams.get(lead.id).human.status).toBe('open');
    await streams.update('daemon', a.id, { human: { status: 'landed' } });
    expect(streams.get(lead.id).human.status).toBe('open');
    await streams.close('human', b.id);
    const after = streams.get(lead.id);
    expect(after.human.status).toBe('closed');
    expect(after.human.note).toBe(PARTS_NOTE);
  });

  test("a project's root never closes itself", async () => {
    await streams.setAutoClose(root.id, true);
    const part = await node({ goal: 'x' });
    await streams.close('human', part.id);
    expect(streams.get(root.id).human.status).toBe('open');
  });

  test('setAutoClose is the operator’s and says so on the thread; an agent cannot change it', async () => {
    const n = await node({ goal: 'x' });
    await streams.setAutoClose(n.id, true);
    expect(streams.get(n.id).auto_close).toBe(true);
    expect(streams.readThread(n.id).entries.at(-1)?.body).toStartWith('auto-close on');
    await expect(streams.update('agent', n.id, { auto_close: null })).rejects.toThrow(
      'only a human',
    );
    await streams.setAutoClose(n.id, false);
    expect(streams.get(n.id).auto_close).toBeUndefined();
    expect(streams.readThread(n.id).entries.at(-1)?.body).toStartWith('auto-close off');
  });
});
