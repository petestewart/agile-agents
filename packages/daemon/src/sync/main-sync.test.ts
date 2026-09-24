/** T226: sync after merge against a real temp git repo and state home; no vendor, no network. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryService } from '../delivery/service';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { MainSync } from './main-sync';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let sync: MainSync;

function sh(args: string[], cwd: string): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-sync-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-sync-repo-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 't@example.com'], repo);
  sh(['config', 'user.name', 'T'], repo);
  writeFileSync(join(repo, 'a.ts'), 'a1\n');
  writeFileSync(join(repo, 'b.ts'), 'b1\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  await store.putRepos({ api: { path: repo, main_branch: 'main' } });
  sync = new MainSync({ streams, repos: () => store.getRepos(), intervalMs: 0 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function workNode(name: string): Promise<{ id: string; wt: string }> {
  const project = await new ProjectService(store, streams).create({ name });
  const node = await streams.create('human', {
    title: name,
    goal: 'g',
    project: project.id,
    repo: 'api',
  });
  const wt = join(repo, '.worktrees', name);
  sh(['worktree', 'add', '-q', wt, '-b', `stream/${name}`, 'main'], repo);
  await store.updateStream('daemon', node.id, (s) => ({
    ...s,
    worktree: wt,
    branch: `stream/${name}`,
  }));
  return { id: node.id, wt };
}

function commit(wt: string, file: string, body: string): void {
  writeFileSync(join(wt, file), body);
  sh(['commit', '-qam', `edit ${file}`], wt);
}

function mainIsIn(wt: string): boolean {
  return (
    Bun.spawnSync(['git', 'merge-base', '--is-ancestor', 'main', 'HEAD'], { cwd: wt }).exitCode ===
    0
  );
}

describe('sync after merge (T226)', () => {
  test('two nodes on one repo: landing one merges main into the other', async () => {
    const one = await workNode('one');
    const two = await workNode('two');
    commit(one.wt, 'a.ts', 'a2\n');
    commit(two.wt, 'b.ts', 'b2\n');
    let moved: Promise<unknown> | undefined;
    const delivery = new DeliveryService({
      store,
      streams,
      onMainMoved: (r, id) => {
        moved = sync.mainMoved(r, id);
        return moved;
      },
    });
    const landed = await delivery.land(one.id);
    expect(landed.status).toBe('landed');
    await moved;
    expect(mainIsIn(two.wt)).toBe(true);
    expect(readFileSync(join(two.wt, 'a.ts'), 'utf8')).toBe('a2\n');
  });

  test('a conflicting pair is flagged with its files, merge aborted', async () => {
    const two = await workNode('two');
    commit(two.wt, 'a.ts', 'two\n');
    commit(repo, 'a.ts', 'main\n');
    const out = await sync.mainMoved('api');
    expect(out.get(two.id)).toEqual({ status: 'conflict', files: ['a.ts'] });
    const s = streams.get(two.id);
    expect(s.delivery_state?.status).toBe('conflict');
    expect(s.land_conflict?.files).toEqual(['a.ts']);
    expect(s.land_conflict?.target).toBe('main');
    expect(sh(['status', '--porcelain'], two.wt)).toBe('');
    expect(mainIsIn(two.wt)).toBe(false);
    const prompt = new DeliveryService({ store, streams }).resolvePrompt(two.id);
    expect(prompt).toContain('Merging main into stream/two conflicted in: a.ts.');
  });

  test('a node behind main at daemon start is synced by the first sweep', async () => {
    const two = await workNode('two');
    commit(repo, 'a.ts', 'while down\n');
    await sync.sweep();
    expect(mainIsIn(two.wt)).toBe(true);
  });

  test('a mid-turn node syncs at the end of the turn; a dirty one waits', async () => {
    const two = await workNode('two');
    await store.updateStream('daemon', two.id, (s) => ({
      ...s,
      sessions: [
        {
          id: '01J00000000000000000000000',
          vendor: 'fake',
          model: 'm',
          role: 'worker',
          status: 'running',
        },
      ],
    }));
    commit(repo, 'a.ts', 'a2\n');
    const out = await sync.mainMoved('api');
    expect(out.get(two.id)).toEqual({ status: 'deferred', reason: 'mid_turn' });
    expect(mainIsIn(two.wt)).toBe(false);
    expect(await sync.turnEnded(two.id)).toEqual({ status: 'synced', pushed: false });
    expect(mainIsIn(two.wt)).toBe(true);

    commit(repo, 'a.ts', 'a3\n');
    writeFileSync(join(two.wt, 'b.ts'), 'dirty\n');
    expect(await sync.turnEnded(two.id)).toEqual({ status: 'skipped' });
    await store.updateStream('daemon', two.id, (s) => ({ ...s, sessions: [] }));
    expect((await sync.mainMoved('api')).get(two.id)).toEqual({
      status: 'deferred',
      reason: 'dirty',
    });
    sh(['checkout', '--', 'b.ts'], two.wt);
    await sync.sweep();
    expect(mainIsIn(two.wt)).toBe(true);
  });

  test('main moving outside the app is noticed by the sweep; a pushed branch is pushed again', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'agile-sync-remote-'));
    try {
      sh(['init', '-q', '--bare'], remote);
      sh(['remote', 'add', 'origin', remote], repo);
      const two = await workNode('two');
      commit(two.wt, 'b.ts', 'b2\n');
      sh(['push', '-q', 'origin', 'stream/two'], two.wt);
      const at = new Date().toISOString();
      await streams.update('daemon', two.id, {
        delivery_state: {
          mode: 'pr',
          status: 'pr_open',
          at,
          pr: {
            number: 1,
            url: 'u',
            head: 'stream/two',
            base: 'main',
            state: 'open',
            draft: false,
            review: 'none',
            checks: 'none',
            mergeable: 'behind',
            auto_merge: 'off',
            last_seen: {},
            polled_at: at,
          },
        },
      });
      await sync.sweep(); // first sweep reconciles; nothing behind yet
      commit(repo, 'a.ts', 'outside\n');
      await sync.sweep();
      expect(mainIsIn(two.wt)).toBe(true);
      expect(sh(['rev-parse', 'refs/heads/stream/two'], remote)).toBe(
        sh(['rev-parse', 'HEAD'], two.wt),
      );
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
