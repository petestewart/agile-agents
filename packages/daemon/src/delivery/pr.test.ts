/**
 * T224: PR delivery against the fake GitHub (`github/fake-server.ts`), with
 * real git. Never the real `gh` or the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { type FakeGitHub, startFakeGitHub } from '../github/fake-server';
import { createGitHubRest } from '../github/rest';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { DeliveryService, type DiffRules, LandRefusedError } from './service';

const TOKEN = 'ghs_T224sentinelTOKENvalue0123456789';

let home: string;
let repo: string;
let gh: FakeGitHub;
let store: StateStore;
let streams: StreamService;

function git(args: string[], cwd = repo): { code: number; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}
function mustGit(args: string[], cwd = repo): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return r.out;
}
function commitIn(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  mustGit(['add', '-A'], cwd);
  mustGit(['commit', '-q', '-m', `edit ${file}`], cwd);
}

function service(diffRules?: DiffRules): DeliveryService {
  return new DeliveryService({
    store,
    streams,
    ...(diffRules ? { diffRules } : {}),
    github: (entry) =>
      createGitHubRest({
        apiUrl: gh.apiUrl,
        ...(entry.github ? { repo: entry.github } : {}),
        staticToken: TOKEN,
      }),
  });
}

async function prStream(): Promise<{ stream: Stream; worktree: string }> {
  const worktree = join(repo, '.worktrees', 's-pr');
  mustGit(['worktree', 'add', '-q', '-b', 'stream/s-pr', worktree, 'main']);
  commitIn(worktree, 'a.txt', 'a\n');
  const created = await streams.create('human', {
    title: 'CSV parser',
    goal: 'parse CSV',
    repo: 'demo',
  });
  const stream = await streams.update('daemon', created.id, {
    branch: 'stream/s-pr',
    worktree,
    agent: { status: 'idle', progress: 'parser done', updated_at: new Date().toISOString() },
  });
  return { stream, worktree };
}

beforeEach(async () => {
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop', token: TOKEN });
  home = mkdtempSync(join(tmpdir(), 'agile-pr-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-pr-repo-'));
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

describe('PR delivery (T224)', () => {
  test('deliver pushes and opens PR #1; a second deliver after a commit pushes and keeps #1', async () => {
    const { stream, worktree } = await prStream();
    const landing = service();

    const first = await landing.land(stream.id);
    expect(first.status).toBe('pr_open');
    if (first.status !== 'pr_open') throw new Error('unreachable');
    expect(first.pr.number).toBe(1);
    expect(mustGit(['rev-parse', 'stream/s-pr'], gh.bareDir)).toBe(
      mustGit(['rev-parse', 'HEAD'], worktree),
    );
    const after = streams.get(stream.id);
    expect(after.delivery_state?.status).toBe('pr_open');
    expect(after.delivery_state?.mode).toBe('pr');
    expect(after.delivery_state?.pr).toMatchObject({
      number: 1,
      url: first.pr.url,
      head: 'stream/s-pr',
      base: 'main',
      state: 'open',
    });
    expect(after.human.status).toBe('open');
    const pull = await createGitHubRest({
      apiUrl: gh.apiUrl,
      repo: { owner: 'acme', repo: 'shop' },
      staticToken: TOKEN,
    }).getPull(1);
    if (pull.notModified) throw new Error('unexpected 304');
    expect(pull.data.title).toBe('CSV parser');
    expect(pull.data.body).toContain('parse CSV');
    expect(pull.data.body).toContain('parser done');

    commitIn(worktree, 'b.txt', 'b\n');
    const second = await landing.land(stream.id);
    expect(second.status).toBe('pr_open');
    if (second.status === 'pr_open') expect(second.pr.number).toBe(1);
    expect(mustGit(['rev-parse', 'stream/s-pr'], gh.bareDir)).toBe(
      mustGit(['rev-parse', 'HEAD'], worktree),
    );
    const all = await createGitHubRest({
      apiUrl: gh.apiUrl,
      repo: { owner: 'acme', repo: 'shop' },
      staticToken: TOKEN,
    }).listPulls({ state: 'all' });
    expect(all.map((p) => p.number)).toEqual([1]);
    // Nothing merged locally: main is untouched.
    expect(mustGit(['rev-list', '--count', 'main'])).toBe('1');
  });

  test('a ship-check hold never pushes', async () => {
    const { stream } = await prStream();
    const outcome = await service({
      check: () => ({ decision: 'deny', reason: 'no secrets', rule: 'r1' }),
    }).land(stream.id);
    expect(outcome.status).toBe('refused');
    expect(git(['rev-parse', '--verify', 'refs/heads/stream/s-pr'], gh.bareDir).code).not.toBe(0);
    expect(gh.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(streams.get(stream.id).delivery_state?.status).toBe('held');
  });

  test('a pr repo with no GitHub repository refuses before touching anything', async () => {
    const { stream } = await prStream();
    const entry = store.getRepos().demo;
    if (!entry) throw new Error('no repo');
    const { github: _g, ...rest } = entry;
    await store.putRepos({ demo: rest });
    await expect(service().land(stream.id)).rejects.toThrow(LandRefusedError);
    expect(git(['rev-parse', '--verify', 'refs/heads/stream/s-pr'], gh.bareDir).code).not.toBe(0);
  });

  test('the token never reaches the thread, events.jsonl, agiled.log or any home file', async () => {
    const { stream, worktree } = await prStream();
    const landing = service();
    await landing.land(stream.id);
    commitIn(worktree, 'b.txt', 'b\n');
    await landing.land(stream.id);
    await store.flush();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(home);
    expect(files.some((f) => f.endsWith('events.jsonl'))).toBe(true);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
  });
});
