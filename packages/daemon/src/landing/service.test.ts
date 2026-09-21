/**
 * `LandingService` against real git repositories in a temp dir — no fakes,
 * no mocked git (the `worktrees.test.ts` precedent). Everything §8.2 and
 * the T132 acceptance criteria name: the refusals, target resolution
 * (including a child landing into its repo-bearing parent's branch), the
 * `land` gate, diff-level rules, the conflict path (nothing merged,
 * worktree kept, stream blocked) and the success path (stream landed,
 * worktree removed, branch kept).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HilRequest, Stream } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { LandRefusedError, LandingService, wireLandGateResolution } from './service';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let landing: LandingService;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** A stream branch with one commit on it, checked out in its own worktree. */
function branchWithWork(
  name: string,
  file: string,
  contents: string,
  base = 'main',
): { branch: string; worktree: string } {
  const worktree = join(repo, '.worktrees', name);
  git(['worktree', 'add', '-q', '-b', name, worktree, base]);
  writeFileSync(join(worktree, file), contents);
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', `work on ${name}`], worktree);
  return { branch: name, worktree };
}

async function makeStream(
  patch: Partial<Stream> & { title?: string } = {},
  repoName: string | undefined = 'demo',
): Promise<Stream> {
  const created = await streams.create('human', {
    title: patch.title ?? 'CSV parser',
    goal: 'ship it',
    ...(repoName !== undefined ? { repo: repoName } : {}),
    ...(patch.parent !== undefined ? { parent: patch.parent } : {}),
    ...(patch.target_branch !== undefined ? { target_branch: patch.target_branch } : {}),
  });
  const { title: _t, parent: _p, target_branch: _tb, ...rest } = patch;
  if (Object.keys(rest).length === 0) return created;
  return streams.update('daemon', created.id, rest);
}

function threadBodies(streamId: string): string[] {
  return streams.readThread(streamId, { limit: 500 }).entries.map((entry) => entry.body);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-landing-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-landing-repo-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  landing = new LandingService({ store, streams });
});

afterEach(async () => {
  await store.flush();
  store.close();
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('refusals (typed, before anything is touched)', () => {
  test('a stream with no repo cannot land', async () => {
    const stream = await makeStream({}, undefined);
    expect(landing.land(stream.id)).rejects.toThrow(LandRefusedError);
  });

  test('a stream with a repo but no branch (never attached) cannot land', async () => {
    const stream = await makeStream();
    expect(landing.land(stream.id)).rejects.toThrow(/has no branch/);
  });

  test('a stream the human already closed cannot land', async () => {
    const work = branchWithWork('s-closed', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    await streams.close('human', stream.id);
    expect(landing.land(stream.id)).rejects.toThrow(/closed/);
  });

  test('a stream with a live session cannot land', async () => {
    const work = branchWithWork('s-live', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      sessions: [
        {
          id: '01J0000000000000000000000X',
          vendor: 'claude',
          model: 'opus',
          role: 'worker',
          status: 'running',
        },
      ],
    }));
    expect(landing.land(stream.id)).rejects.toThrow(/live session/);
  });

  test('a branch with no commits beyond the target has nothing to land', async () => {
    const worktree = join(repo, '.worktrees', 's-empty');
    git(['worktree', 'add', '-q', '-b', 's-empty', worktree, 'main']);
    const stream = await makeStream({ branch: 's-empty', worktree });
    expect(landing.land(stream.id)).rejects.toThrow(/nothing to land/);
  });

  test('a target branch that does not exist is named in the refusal', async () => {
    const work = branchWithWork('s-target', 'a.txt', 'a\n');
    const stream = await makeStream({ ...work, target_branch: 'nope' });
    expect(landing.land(stream.id)).rejects.toThrow(/nope does not exist/);
  });
});

describe('the success path', () => {
  test('merges --no-ff into the default branch, lands the stream, removes the worktree, keeps the branch', async () => {
    const work = branchWithWork('s-ok', 'feature.txt', 'feature\n');
    const stream = await makeStream(work);

    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('landed');
    if (outcome.status !== 'landed') throw new Error('unreachable');
    expect(outcome.target).toBe('main');

    // The merge is a real merge commit on main, with the daemon as author.
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(outcome.sha);
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('1');
    expect(git(['log', '-1', '--format=%an <%ae>', 'main'])).toBe(
      'agiled <agiled@agile-agents.local>',
    );
    expect(git(['show', 'main:feature.txt'])).toBe('feature');

    // Record + thread.
    const landed = streams.get(stream.id);
    expect(landed.human.status).toBe('landed');
    expect(threadBodies(stream.id).some((b) => b.startsWith('landed s-ok into main ('))).toBe(true);
    expect(outcome.line).toContain('landed s-ok into main');

    // The operator's own checkout was on main and clean: it is brought
    // along, not left showing the merge as a pending deletion.
    expect(git(['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);

    // Worktree removed, branch kept (git remembers the work).
    expect(existsSync(work.worktree)).toBe(false);
    expect(git(['rev-parse', '--verify', 'refs/heads/s-ok']).length).toBe(40);
  });

  test("the stream's own target_branch beats the repo entry's, which beats the default branch", async () => {
    git(['branch', 'integration', 'main']);
    await store.putRepos({
      demo: { path: repo, protected_branches: ['main'], target_branch: 'integration' },
    });
    const work = repoEntryTarget();
    const stream = await makeStream(work);
    const outcome = await landing.land(stream.id);
    expect(outcome.status === 'landed' && outcome.target).toBe('integration');
    expect(git(['rev-parse', 'refs/heads/main'])).not.toBe(
      git(['rev-parse', 'refs/heads/integration']),
    );

    // And a stream naming its own target wins over the repo entry's.
    git(['branch', 'staging', 'main']);
    const other = branchWithWork('s-staging', 'b.txt', 'b\n');
    const otherStream = await makeStream({ ...other, target_branch: 'staging' });
    const second = await landing.land(otherStream.id);
    expect(second.status === 'landed' && second.target).toBe('staging');
  });

  function repoEntryTarget(): { branch: string; worktree: string } {
    return branchWithWork('s-integration', 'a.txt', 'a\n');
  }
});

describe('child into parent (§8.2: a child with a repo-bearing parent merges into the PARENT branch)', () => {
  test('lands into the parent branch, not the repo default', async () => {
    const parentWork = branchWithWork('s-parent', 'parent.txt', 'parent\n');
    const parent = await makeStream({ ...parentWork, title: 'parent stream' });
    const childWork = branchWithWork('s-child', 'child.txt', 'child\n', 's-parent');
    const child = await makeStream({ ...childWork, parent: parent.id, title: 'child stream' });

    const outcome = await landing.land(child.id);
    expect(outcome.status === 'landed' && outcome.target).toBe('s-parent');
    // The parent's branch carries the child's file; main is untouched.
    expect(git(['show', 's-parent:child.txt'])).toBe('child');
    expect(() => git(['show', 'main:child.txt'])).toThrow();
    expect(streams.get(child.id).human.status).toBe('landed');
    expect(streams.get(parent.id).human.status).toBe('open');
  });

  test('a parent without a repo/branch (a planning stream) falls through to the repo default', async () => {
    const parent = await makeStream({ title: 'planning' }, undefined);
    const childWork = branchWithWork('s-child2', 'child.txt', 'child\n');
    const child = await makeStream({ ...childWork, parent: parent.id });

    const outcome = await landing.land(child.id);
    expect(outcome.status === 'landed' && outcome.target).toBe('main');
  });
});

describe('conflict (acceptance: blocked, conflict files on the thread, worktree kept, no partial merge)', () => {
  test('aborts the merge, leaves the target where it was, and blocks the stream', async () => {
    const work = branchWithWork('s-conflict', 'shared.txt', 'from the stream\n');
    // main moves the same file a different way — a guaranteed conflict.
    writeFileSync(join(repo, 'shared.txt'), 'from main\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'main writes shared.txt']);
    const mainBefore = git(['rev-parse', 'refs/heads/main']);
    const stream = await makeStream(work);

    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') throw new Error('unreachable');
    expect(outcome.conflicts).toEqual(['shared.txt']);

    // No partial merge: main is exactly where it was, and nothing is
    // half-merged anywhere in the repo.
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(git(['status', '--porcelain'])).toBe('');

    const blocked = streams.get(stream.id);
    expect(blocked.agent.status).toBe('blocked');
    expect(blocked.human.status).toBe('open');
    expect(threadBodies(stream.id).some((b) => b.includes('conflicted in: shared.txt'))).toBe(true);
    // The worktree is kept — that is where the conflict gets resolved.
    expect(existsSync(work.worktree)).toBe(true);
  });
});

describe('the land gate (repos.yaml `land_gate: true`)', () => {
  test('raises the gate instead of merging, and approving it performs the merge', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'], land_gate: true } });
    const gates = new GateService(store);
    landing = new LandingService({ store, streams, gates });
    wireLandGateResolution(gates, landing);

    const work = branchWithWork('s-gated', 'gated.txt', 'gated\n');
    const stream = await makeStream(work);
    const mainBefore = git(['rev-parse', 'refs/heads/main']);

    const gatedOutcome = await landing.land(stream.id);
    expect(gatedOutcome.status).toBe('gated');
    if (gatedOutcome.status !== 'gated') throw new Error('unreachable');
    const gate: HilRequest = gatedOutcome.gate;
    expect(gate.gate).toBe('land');
    expect(gate.stream).toBe(stream.id);
    expect(gate.status).toBe('pending');
    expect(gatedOutcome.line).toBe(`gate raised: ${gate.id}`);
    // Nothing merged while the gate is pending.
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(streams.get(stream.id).human.status).toBe('open');

    await gates.respond(gate.id, 'approve', 'pete');
    expect(streams.get(stream.id).human.status).toBe('landed');
    expect(git(['show', 'main:gated.txt'])).toBe('gated');
    expect(existsSync(work.worktree)).toBe(false);
  });

  test('a denied gate leaves the stream open and merges nothing', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'], land_gate: true } });
    const gates = new GateService(store);
    landing = new LandingService({ store, streams, gates });
    wireLandGateResolution(gates, landing);

    const work = branchWithWork('s-denied', 'denied.txt', 'denied\n');
    const stream = await makeStream(work);
    const outcome = await landing.land(stream.id);
    if (outcome.status !== 'gated') throw new Error('expected a gate');

    await gates.respond(outcome.gate.id, 'deny', 'pete');
    expect(streams.get(stream.id).human.status).toBe('open');
    expect(() => git(['show', 'main:denied.txt'])).toThrow();
    expect(existsSync(work.worktree)).toBe(true);
  });

  test('no gate is raised when the repo does not ask for one (§8.2 default)', async () => {
    const gates = new GateService(store);
    landing = new LandingService({ store, streams, gates });
    const work = branchWithWork('s-nogate', 'x.txt', 'x\n');
    const stream = await makeStream(work);

    expect((await landing.land(stream.id)).status).toBe('landed');
    expect(gates.list().length).toBe(0);
  });
});

describe('diff-level rules (T152 plugs in; the default is a no-op)', () => {
  test('a denying rule blocks the merge and names itself on the thread', async () => {
    const work = branchWithWork('s-rules', 'todo.txt', 'TODO: finish\n');
    const stream = await makeStream(work);
    const seen: string[] = [];
    landing = new LandingService({
      store,
      streams,
      diffRules: {
        check: (ctx) => {
          seen.push(ctx.diff());
          return { decision: 'deny', reason: 'a TODO is left in shipped code', rule: 'RULE-1' };
        },
      },
    });

    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('refused');
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('0');
    expect(seen[0]).toContain('TODO: finish');
    expect(
      threadBodies(stream.id).some((b) => b.includes('RULE-1: a TODO is left in shipped code')),
    ).toBe(true);
    // The worktree stays: the stream is still live work.
    expect(existsSync(work.worktree)).toBe(true);
  });
});

describe('the operator checkout', () => {
  test('refuses rather than merging when the target is checked out with uncommitted changes', async () => {
    const work = branchWithWork('s-dirty', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    writeFileSync(join(repo, 'README.md'), '# edited by the operator\n');

    expect(landing.land(stream.id)).rejects.toThrow(/uncommitted changes/);
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('0');
  });
});
