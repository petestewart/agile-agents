/**
 * T228: waits-on (P8), merge-together (P7) and auto-merge (P19) against the
 * fake GitHub, with real git and a fake clock. Never the real `gh`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { type FakeGitHub, startFakeGitHub } from '../github/fake-server';
import { PR_CHECK_COOLDOWN_MS, PR_POLL_MS, PrPoller } from '../github/poller';
import { createGitHubRest } from '../github/rest';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { DeliveryService, type DiffRules, LandRefusedError } from './service';

const TOKEN = 'ghs_T228sentinelTOKENvalue0123456789';

let home: string;
let repo: string;
let gh: FakeGitHub;
let store: StateStore;
let streams: StreamService;
let clock: number;

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

function service(diffRules?: DiffRules): DeliveryService {
  return new DeliveryService({
    store,
    streams,
    ...(diffRules ? { diffRules } : {}),
    github: () => port(),
  });
}

async function node(name: string, file: string, patch: Partial<Stream> = {}): Promise<Stream> {
  const worktree = join(repo, '.worktrees', name);
  mustGit(['worktree', 'add', '-q', '-b', `stream/${name}`, worktree, 'main']);
  commitIn(worktree, file, `${name}\n`);
  const created = await streams.create('human', { title: name, goal: `do ${name}`, repo: 'demo' });
  return streams.update('daemon', created.id, { branch: `stream/${name}`, worktree, ...patch });
}

function lines(id: string): string[] {
  return store.readThread(id).map((e) => e.body);
}

async function setUp(delivery: 'pr' | 'direct', allowAutoMerge = true) {
  clock = Date.now();
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop', token: TOKEN, allowAutoMerge });
  await store.putRepos({
    demo: {
      path: repo,
      protected_branches: ['main'],
      delivery,
      ...(delivery === 'pr' ? { auto_merge: true } : {}),
      github: { owner: 'acme', repo: 'shop' },
    },
  });
  mustGit(['remote', 'add', 'origin', gh.remoteUrl]);
  mustGit(['push', '-q', 'origin', 'main']);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-holds-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-holds-repo-'));
  mustGit(['init', '-q', '-b', 'main']);
  mustGit(['config', 'user.email', 'test@example.com']);
  mustGit(['config', 'user.name', 'Test']);
  commitIn(repo, 'README.md', '# shop\n');
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
});

afterEach(async () => {
  await store.flush();
  store.close();
  await gh?.stop();
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('waits on + auto-merge (T228, P8, P19)', () => {
  test('a waiting node is held until its target merges, then auto-merge merges it', async () => {
    await setUp('pr');
    const landing = service();
    const a = await node('a', 'a.txt');
    const b = await node('b', 'b.txt');
    await streams.wait('human', b.id, a.id);

    expect((await landing.land(b.id)).status).toBe('pr_open');
    let bNow = streams.get(b.id);
    expect(bNow.delivery_state?.pr?.auto_merge).toBe('off');
    expect(bNow.delivery_state?.held_by).toEqual([
      { reason: 'waits_on', detail: `waits on ${a.id}` },
    ]);

    expect((await landing.land(a.id)).status).toBe('pr_open');
    expect(streams.get(a.id).delivery_state?.pr?.auto_merge).toBe('enabled');
    const aPr = streams.get(a.id).delivery_state?.pr?.number as number;
    const bPr = bNow.delivery_state?.pr?.number as number;
    expect(gh.pulls.find((p) => p.number === bPr)?.auto_merge).toBe(false);

    // A teammate approves A: the fake's auto-merge merges it.
    gh.addReview(aPr, { state: 'APPROVED' });
    expect(gh.pulls.find((p) => p.number === aPr)?.merged).toBe(true);

    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      afterTick: () => landing.settle(),
      now: () => new Date(clock),
    });
    await poll.tick();
    expect(streams.get(a.id).delivery_state?.status).toBe('merged');
    bNow = streams.get(b.id);
    expect(bNow.waits_on?.[0]?.satisfied_at).toBeDefined();
    expect(bNow.delivery_state?.pr?.auto_merge).toBe('enabled');
    expect(bNow.delivery_state?.held_by).toBeUndefined();
    expect(lines(b.id)).toContain(`waits on ${a.id} satisfied`);

    gh.addReview(bPr, { state: 'APPROVED' });
    expect(gh.pulls.find((p) => p.number === bPr)?.merged).toBe(true);
    clock += PR_POLL_MS + 1;
    await poll.tick();
    expect(streams.get(b.id).delivery_state?.status).toBe('merged');
    expect(streams.get(b.id).human.status).toBe('landed');
  });

  test('"unavailable" is shown when GitHub refuses, and a poll keeps it', async () => {
    await setUp('pr', false);
    const landing = service();
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    expect(streams.get(a.id).delivery_state?.pr?.auto_merge).toBe('unavailable');
    expect(lines(a.id).some((l) => l.startsWith('GitHub refused auto-merge on PR #1'))).toBe(true);
    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      now: () => new Date(clock),
    });
    gh.addReview(1, { state: 'APPROVED' });
    await poll.tick();
    expect(streams.get(a.id).delivery_state?.pr?.auto_merge).toBe('unavailable');
    expect(gh.pulls[0]?.merged).toBe(false);
  });

  test('a PR merge-together pair enables auto-merge only when both are approved', async () => {
    await setUp('pr');
    const landing = service();
    const a = await node('a', 'a.txt', { merge_together: 'MT-1' });
    const b = await node('b', 'b.txt', { merge_together: 'MT-1' });
    await landing.land(a.id);
    await landing.land(b.id);
    expect(streams.get(a.id).delivery_state?.held_by?.[0]?.reason).toBe('merge_together');
    gh.addReview(1, { state: 'APPROVED' });
    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      afterTick: () => landing.settle(),
      now: () => new Date(clock),
    });
    await poll.tick();
    expect(gh.pulls.some((p) => p.auto_merge)).toBe(false);
    gh.addReview(2, { state: 'APPROVED' });
    clock += PR_POLL_MS + 1;
    await poll.tick();
    expect(gh.pulls.map((p) => p.merged)).toEqual([true, true]);
  });

  test('T340: an auto-merge between polls: Merge refuses without re-delivering and Check now records it', async () => {
    await setUp('pr');
    const poll: PrPoller = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      afterTick: () => landing.settle(),
      now: () => new Date(clock),
    });
    const landing: DeliveryService = new DeliveryService({
      store,
      streams,
      github: () => port(),
      refreshPr: (id) => poll.pollNow(id),
    });
    const a = await node('a', 'a.txt');
    const b = await node('b', 'b.txt');
    await streams.wait('human', b.id, a.id);
    expect((await landing.land(a.id)).status).toBe('pr_open');
    await poll.tick(); // polled once: the next poll is a minute away
    expect(streams.get(a.id).delivery_state?.status).toBe('pr_open');

    // GitHub auto-merges on approval; the daemon has not polled since.
    gh.addReview(1, { state: 'APPROVED' });
    expect(gh.pulls[0]?.merged).toBe(true);
    await poll.tick();
    expect(streams.get(a.id).delivery_state?.status).toBe('pr_open');

    // A Merge click: no push, no "opened/updated PR", the merge recorded at once.
    const before = lines(a.id).length;
    await expect(landing.land(a.id)).rejects.toThrow(/already merged on GitHub/);
    const aNow = streams.get(a.id);
    expect(aNow.delivery_state?.status).toBe('merged');
    expect(aNow.delivery_state?.pr?.state).toBe('merged');
    expect(aNow.human.status).toBe('landed');
    expect(lines(a.id).slice(before)).toContain('PR #1 merged');
    expect(
      lines(a.id)
        .slice(before)
        .some((l) => l.startsWith('pushed ')),
    ).toBe(false);
    expect(streams.get(b.id).waits_on?.[0]?.satisfied_at).toBeDefined();
    expect(gh.pulls).toHaveLength(1);
  });

  test('T340: Check now polls a PR before its cadence is due', async () => {
    await setUp('pr');
    const landing = service();
    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      afterTick: () => landing.settle(),
      now: () => new Date(clock),
    });
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    await poll.tick();
    gh.addReview(1, { state: 'APPROVED' });
    expect(gh.pulls[0]?.merged).toBe(true);
    const checked = await poll.pollNow(a.id);
    expect(checked.delivery_state?.status).toBe('merged');
    expect(checked.human.status).toBe('landed');
  });

  test('T340: a push (no mayOpen, D8) on a PR closed on GitHub refuses, pushes nothing, opens nothing', async () => {
    await setUp('pr');
    const poll: PrPoller = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      now: () => new Date(clock),
    });
    const landing = new DeliveryService({
      store,
      streams,
      github: () => port(),
      refreshPr: (id) => poll.pollNow(id),
    });
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    const remoteSha = () => mustGit(['ls-remote', 'origin', 'refs/heads/stream/a']).split(/\s+/)[0];
    const pushedSha = remoteSha();
    commitIn(a.worktree as string, 'a2.txt', 'more\n');
    (gh.pulls[0] as { state: string }).state = 'closed'; // a human declined it on GitHub
    // `push()` (phase 9+, T246) calls deliverPr exactly like this: no mayOpen.
    const deliverPr = (
      landing as unknown as {
        deliverPr: (...args: unknown[]) => Promise<unknown>;
      }
    ).deliverPr.bind(landing);
    const s = streams.get(a.id);
    await expect(deliverPr(s, store.getRepos().demo, port(), 'stream/a', 'main')).rejects.toThrow(
      /closed on GitHub; a push never opens a PR/,
    );
    expect(remoteSha()).toBe(pushedSha);
    expect(gh.pulls).toHaveLength(1);
    expect(streams.get(a.id).delivery_state?.status).toBe('closed_unmerged');
  });

  test("T340: the human's deliver on a PR closed on GitHub opens a new one", async () => {
    await setUp('pr');
    const landing = service();
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    (gh.pulls[0] as { state: string }).state = 'closed';
    const again = await landing.land(a.id);
    expect(again.status).toBe('pr_open');
    expect(gh.pulls).toHaveLength(2);
    const pr = streams.get(a.id).delivery_state?.pr;
    expect(pr?.number).toBe(2);
    expect(pr?.state).toBe('open');
    expect(lines(a.id).some((l) => l.includes('opened PR #2'))).toBe(true);
  });

  test('T340: Check now within the cooldown does not poll GitHub again', async () => {
    await setUp('pr');
    const landing = service();
    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      now: () => new Date(clock),
    });
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    await poll.pollNow(a.id);
    const reads = () => gh.requests.filter((r) => r.path.endsWith('/pulls/1')).length;
    const before = reads();
    gh.addReview(1, { state: 'APPROVED' });
    expect((await poll.pollNow(a.id)).delivery_state?.status).toBe('pr_open');
    expect(reads()).toBe(before);
    clock += PR_CHECK_COOLDOWN_MS;
    expect((await poll.pollNow(a.id)).delivery_state?.status).toBe('merged');
  });

  test('T340: a re-deliver held by its ship check keeps the PR polled to merged', async () => {
    await setUp('pr');
    let deny = false;
    const landing = service({
      check: async () =>
        deny ? { decision: 'deny', reason: 'no secrets', rule: 'R1' } : { decision: 'allow' },
    });
    const poll = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      now: () => new Date(clock),
    });
    const a = await node('a', 'a.txt');
    expect((await landing.land(a.id)).status).toBe('pr_open');
    deny = true;
    expect((await landing.land(a.id)).status).toBe('refused');
    const held = streams.get(a.id).delivery_state;
    expect(held?.status).toBe('held');
    expect(held?.pr?.number).toBe(1);
    gh.merge(1);
    await poll.tick();
    expect(streams.get(a.id).delivery_state?.status).toBe('merged');
    expect(streams.get(a.id).human.status).toBe('landed');
  });

  test('a direct node waits for its target; a cycle is refused', async () => {
    await setUp('direct');
    const landing = service();
    const a = await node('a', 'a.txt');
    const b = await node('b', 'b.txt');
    await streams.wait('human', b.id, a.id);
    await expect(streams.wait('human', a.id, b.id)).rejects.toThrow(/cycle/);
    const held = await landing.land(b.id);
    expect(held.status).toBe('refused');
    expect(streams.get(b.id).delivery_state?.held_by?.[0]?.reason).toBe('waits_on');
    expect((await landing.land(a.id)).status).toBe('landed');
    expect(streams.get(b.id).waits_on?.[0]?.satisfied_at).toBeDefined();
    expect((await landing.land(b.id)).status).toBe('landed');
    await streams.wait('human', b.id, a.id, { remove: true });
    expect(streams.get(b.id).waits_on).toEqual([]);
  });
});

describe('direct merge-together (T228, P7)', () => {
  test('a pair lands together in one operation', async () => {
    await setUp('direct');
    const a = await node('a', 'a.txt', { merge_together: 'MT-1' });
    const b = await node('b', 'b.txt', { merge_together: 'MT-1' });
    const before = mustGit(['rev-parse', 'main']);
    const out = await service().land(a.id);
    expect(out.status).toBe('landed');
    expect(streams.get(a.id).human.status).toBe('landed');
    expect(streams.get(b.id).human.status).toBe('landed');
    expect(mustGit(['show', 'main:a.txt'])).toBe('a');
    expect(mustGit(['show', 'main:b.txt'])).toBe('b');
    // One ref move: main's first parent is the old main after two merges.
    expect(mustGit(['rev-parse', 'main~2'])).toBe(before);
  });

  test('a member that conflicts merges nothing', async () => {
    await setUp('direct');
    const a = await node('a', 'a.txt', { merge_together: 'MT-1' });
    await node('b', 'README.md', { merge_together: 'MT-1' });
    commitIn(repo, 'README.md', '# moved on\n');
    const before = mustGit(['rev-parse', 'main']);
    const out = await service().land(a.id);
    expect(out.status).toBe('blocked');
    expect(mustGit(['rev-parse', 'main'])).toBe(before);
    expect(streams.get(a.id).human.status).toBe('open');
    expect(streams.get(a.id).delivery_state?.held_by?.[0]?.reason).toBe('merge_together');
  });

  test('a member failing its ship check stops before the first merge', async () => {
    await setUp('direct');
    const a = await node('a', 'a.txt', { merge_together: 'MT-1' });
    const b = await node('b', 'b.txt', { merge_together: 'MT-1' });
    const before = mustGit(['rev-parse', 'main']);
    const out = await service({
      check: (ctx) =>
        ctx.stream.id === b.id
          ? { decision: 'deny', reason: 'no secrets', rule: 'r1' }
          : { decision: 'allow' },
    }).land(a.id);
    expect(out.status).toBe('refused');
    expect(mustGit(['rev-parse', 'main'])).toBe(before);
    expect(streams.get(a.id).delivery_state?.held_by?.[0]?.reason).toBe('merge_together');
  });

  test('a member with nothing to land refuses the group', async () => {
    await setUp('direct');
    const a = await node('a', 'a.txt', { merge_together: 'MT-1' });
    const created = await streams.create('human', { title: 'empty', goal: 'g', repo: 'demo' });
    mustGit(['branch', 'stream/empty', 'main']);
    await streams.update('daemon', created.id, { branch: 'stream/empty', merge_together: 'MT-1' });
    await expect(service().land(a.id)).rejects.toThrow(LandRefusedError);
    expect(streams.get(a.id).human.status).toBe('open');
  });
});
