/**
 * T225: the PR poller against the fake GitHub with a fake clock and real
 * git. Never the real `gh` or the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { DeliveryService } from '../delivery/service';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { MainSync } from '../sync/main-sync';
import { type FakeGitHub, startFakeGitHub } from './fake-server';
import { PR_POLL_FLAGGED_MS, PR_POLL_MS, PrPoller } from './poller';
import { createGitHubRest } from './rest';

const TOKEN = 'ghs_T225sentinelTOKENvalue0123456789';

let home: string;
let repo: string;
let gh: FakeGitHub;
let store: StateStore;
let streams: StreamService;
let clock: number;
let asked: Array<{ stream: string; text: string }>;
let moved: Array<{ repo: string; except?: string }>;

const now = () => new Date(clock);

function mustGit(args: string[], cwd = repo): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.toString().trim();
}
function commitIn(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  mustGit(['add', '-A'], cwd);
  mustGit(['commit', '-q', '-m', `edit ${file}`], cwd);
}

const port = () =>
  createGitHubRest({
    apiUrl: gh.apiUrl,
    repo: { owner: 'acme', repo: 'shop' },
    staticToken: TOKEN,
  });

function poller(): PrPoller {
  return new PrPoller({
    streams,
    repos: () => store.getRepos(),
    github: () => port(),
    ask: async (q) => {
      asked.push({ stream: q.stream, text: q.text });
    },
    onMainMoved: (r, except) => {
      moved.push({ repo: r, ...(except ? { except } : {}) });
    },
    now,
  });
}

async function openPr(): Promise<Stream> {
  const worktree = join(repo, '.worktrees', 's-pr');
  mustGit(['worktree', 'add', '-q', '-b', 'stream/s-pr', worktree, 'main']);
  commitIn(worktree, 'a.txt', 'a\n');
  const created = await streams.create('human', { title: 'CSV', goal: 'parse CSV', repo: 'demo' });
  await streams.update('daemon', created.id, { branch: 'stream/s-pr', worktree });
  const out = await new DeliveryService({ store, streams, github: () => port() }).land(created.id);
  expect(out.status).toBe('pr_open');
  return streams.get(created.id);
}

function lines(id: string): string[] {
  return store.readThread(id).map((e) => e.body);
}

beforeEach(async () => {
  clock = Date.now();
  asked = [];
  moved = [];
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop', token: TOKEN });
  home = mkdtempSync(join(tmpdir(), 'agile-poll-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-poll-repo-'));
  mustGit(['init', '-q', '-b', 'main']);
  mustGit(['config', 'user.email', 'test@example.com']);
  mustGit(['config', 'user.name', 'Test']);
  commitIn(repo, 'README.md', '# shop\n');
  mustGit(['remote', 'add', 'origin', gh.remoteUrl]);
  mustGit(['push', '-q', 'origin', 'main']);
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  await store.putRepos({
    demo: {
      path: repo,
      protected_branches: ['main'],
      delivery: 'pr',
      github: { owner: 'acme', repo: 'shop' },
    },
  });
});

afterEach(async () => {
  await store.flush();
  store.close();
  await gh.stop();
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('PR poller (T225)', () => {
  test('each transition shows on the node, through merge to landed and main moved', async () => {
    const s = await openPr();
    const p = poller();
    await p.tick();
    expect(streams.get(s.id).delivery_state?.pr?.review).toBe('review_requested');

    gh.addReview(1, { state: 'CHANGES_REQUESTED', user: 'ann', body: 'rename it' });
    clock += PR_POLL_MS;
    await p.tick();
    expect(streams.get(s.id).delivery_state?.pr?.review).toBe('changes_requested');
    expect(lines(s.id)).toContain('PR #1 review from ann: changes_requested: rename it');

    const head = mustGit(['rev-parse', 'stream/s-pr']);
    gh.setCheck(head, 'ci', 'failure');
    clock += PR_POLL_MS;
    await p.tick();
    expect(streams.get(s.id).delivery_state?.pr?.checks).toBe('failing');
    expect(lines(s.id)).toContain('PR #1: CI failing');

    gh.setCheck(head, 'ci', 'success');
    gh.addReview(1, { state: 'APPROVED', user: 'ann' });
    gh.addIssueComment(1, { body: 'lgtm', user: 'bob' });
    clock += PR_POLL_MS;
    await p.tick();
    const approved = streams.get(s.id).delivery_state?.pr;
    expect(approved?.review).toBe('approved');
    expect(approved?.checks).toBe('passing');
    expect(lines(s.id)).toContain('PR #1 comment from bob: lgtm');

    // Not due yet: nothing is read.
    const before = gh.requests.length;
    clock += 1_000;
    await p.tick();
    expect(gh.requests.length).toBe(before);

    // First ls-remote sight records main; the merge then moves it.
    const sha = gh.merge(1);
    clock += PR_POLL_MS;
    await p.tick();
    const after = streams.get(s.id);
    expect(after.delivery_state?.status).toBe('merged');
    expect(after.delivery_state?.merged_sha).toBe(sha);
    expect(after.human.status).toBe('landed');
    expect(lines(s.id)).toContain('PR #1 merged');
    expect(moved).toEqual([{ repo: 'demo', except: s.id }]);
    expect(mustGit(['rev-parse', 'main'])).toBe(sha);

    // Landed: no longer polled; a second deliver is refused.
    await expect(
      new DeliveryService({ store, streams, github: () => port() }).land(s.id),
    ).rejects.toThrow();
    const n = gh.requests.length;
    clock += PR_POLL_MS;
    await p.tick();
    expect(gh.requests.filter((r) => r.path.includes('/pulls/')).length).toBe(
      gh.requests.slice(0, n).filter((r) => r.path.includes('/pulls/')).length,
    );
  });

  test('304s do not rewrite the record', async () => {
    const s = await openPr();
    const p = poller();
    await p.tick();
    const first = streams.get(s.id);
    clock += PR_POLL_MS;
    await p.tick();
    expect(gh.requests.slice(-6).every((r) => r.status === 304)).toBe(true);
    const second = streams.get(s.id);
    expect(second.delivery_state).toEqual(first.delivery_state);
    expect(second).toEqual(first);
  });

  test('a 403 rate limit pauses polling with a thread note', async () => {
    const s = await openPr();
    const p = poller();
    gh.rateLimit(1);
    await p.tick();
    expect(p.paused).toBe(true);
    expect(lines(s.id).some((l) => l.includes('rate limit'))).toBe(true);
    const n = gh.requests.length;
    clock += 1_000;
    await p.tick();
    expect(gh.requests.length).toBe(n);
    clock += 2 * 60 * 60_000;
    await p.tick();
    expect(gh.requests.length).toBeGreaterThan(n);
    expect(streams.get(s.id).delivery_state?.pr?.review).toBe('review_requested');
  });

  test('closed unmerged raises a question', async () => {
    const s = await openPr();
    const p = poller();
    await p.tick();
    gh.close(1);
    clock += PR_POLL_MS;
    await p.tick();
    expect(streams.get(s.id).delivery_state?.status).toBe('closed_unmerged');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('closed without merging');
  });

  test('a flagged node polls every 15 s', async () => {
    await openPr();
    const s = streams.list()[0] as Stream;
    const p = poller();
    p.flag(s.id);
    await p.tick();
    const n = gh.requests.length;
    clock += PR_POLL_FLAGGED_MS;
    await p.tick();
    expect(gh.requests.length).toBeGreaterThan(n);
  });

  test('ls-remote sees main move outside the app', async () => {
    await openPr();
    const p = poller();
    await p.tick();
    expect(moved).toEqual([]);
    const other = mkdtempSync(join(tmpdir(), 'agile-poll-other-'));
    mustGit(['clone', '-q', gh.remoteUrl, other], tmpdir());
    mustGit(['config', 'user.email', 't@e.com'], other);
    mustGit(['config', 'user.name', 'T'], other);
    commitIn(other, 'x.txt', 'x\n');
    mustGit(['push', '-q', 'origin', 'main'], other);
    clock += PR_POLL_MS;
    await p.tick();
    expect(moved).toEqual([{ repo: 'demo' }]);
    expect(mustGit(['rev-parse', 'main'])).toBe(mustGit(['rev-parse', 'HEAD'], other));
    rmSync(other, { recursive: true, force: true });
  });

  test('a PR merge syncs another live node on the repo (T226 MainSync)', async () => {
    const s = await openPr();
    const wt2 = join(repo, '.worktrees', 's-two');
    mustGit(['worktree', 'add', '-q', '-b', 'stream/s-two', wt2, 'main']);
    commitIn(wt2, 'b.txt', 'b\n');
    const project = await new ProjectService(store, streams).create({ name: 'two' });
    const two = await streams.create('human', {
      title: 'Two',
      goal: 'other',
      project: project.id,
      repo: 'demo',
    });
    await streams.update('daemon', two.id, { branch: 'stream/s-two', worktree: wt2 });
    const sync = new MainSync({ streams, repos: () => store.getRepos(), intervalMs: 0 });
    const p = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      onMainMoved: (r, except) => sync.mainMoved(r, except),
      now,
    });
    await p.tick();
    const sha = gh.merge(1);
    clock += PR_POLL_MS;
    await p.tick();
    expect(streams.get(s.id).human.status).toBe('landed');
    expect(mustGit(['merge-base', '--is-ancestor', sha, 'stream/s-two'], wt2)).toBe('');
    expect(readFileSync(join(wt2, 'a.txt'), 'utf8')).toBe('a\n');
  });

  test('main checked out and dirty: the fast-forward skips with a note and touches nothing', async () => {
    const s = await openPr();
    const p = poller();
    await p.tick();
    const oldMain = mustGit(['rev-parse', 'main']);
    writeFileSync(join(repo, 'README.md'), '# local edit\n');
    gh.merge(1);
    clock += PR_POLL_MS;
    await p.tick();
    expect(mustGit(['rev-parse', 'main'])).toBe(oldMain);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# local edit\n');
    expect(moved).toEqual([]);
    expect(lines(s.id).some((l) => l.includes('uncommitted changes'))).toBe(true);
    // Once clean, the next check catches up.
    mustGit(['checkout', '--', 'README.md']);
    clock += PR_POLL_MS;
    await p.tick();
    expect(moved).toEqual([{ repo: 'demo' }]);
  });
});
