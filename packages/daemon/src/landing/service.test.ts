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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HilRequest, Stream } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { LandRefusedError, LandingService, mainBranch, wireLandGateResolution } from './service';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let landing: LandingService;
let stateRoot: string;

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
  });
  const { title: _t, parent: _p, ...rest } = patch;
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
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
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
    await store.putRepos({
      demo: { path: repo, protected_branches: ['main'], target_branch: 'nope' },
    });
    const work = branchWithWork('s-target', 'a.txt', 'a\n');
    const stream = await makeStream(work);
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

  test("the repo entry's main branch beats the repo's default branch", async () => {
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
  });

  function repoEntryTarget(): { branch: string; worktree: string } {
    return branchWithWork('s-integration', 'a.txt', 'a\n');
  }
});

describe('D20: a child delivers to main, never into its parent', () => {
  test("a child of a node that has a repo and a branch lands on main, not the parent's branch", async () => {
    const parentWork = branchWithWork('s-parent', 'parent.txt', 'parent\n');
    const parent = await makeStream({ ...parentWork, title: 'parent stream' });
    const childWork = branchWithWork('s-child', 'child.txt', 'child\n');
    const child = await makeStream({ ...childWork, parent: parent.id, title: 'child stream' });

    const outcome = await landing.land(child.id);
    expect(outcome.status === 'landed' && outcome.target).toBe('main');
    expect(git(['show', 'main:child.txt'])).toBe('child');
    expect(() => git(['show', 's-parent:child.txt'])).toThrow();
    expect(streams.get(child.id).human.status).toBe('landed');
    expect(streams.get(parent.id).human.status).toBe('open');
  });

  test('main_branch (T202) wins over the old target_branch, which wins over the default', () => {
    const entry = { path: repo, protected_branches: ['main'], target_branch: 'integration' };
    expect(mainBranch({ ...entry, main_branch: 'trunk' } as typeof entry, repo)).toBe('trunk');
    expect(mainBranch(entry, repo)).toBe('integration');
    expect(mainBranch({ path: repo, protected_branches: [] }, repo)).toBe('main');
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

describe('T176: after a conflict — preflight, the Resolve prompt, and the re-land', () => {
  test('preflight names the files; the prompt says merge, resolve, test, commit; a resolved branch lands', async () => {
    const work = branchWithWork('s-resolve', 'shared.txt', 'from the stream\n');
    writeFileSync(join(repo, 'shared.txt'), 'from main\n');
    git(['add', 'shared.txt']);
    git(['commit', '-q', '-m', 'main writes shared.txt']);
    const stream = await makeStream(work);
    expect(() => landing.resolvePrompt(stream.id)).toThrow(/no land conflict/);

    expect((await landing.land(stream.id)).status).toBe('blocked');
    const pre = landing.preflight(stream.id);
    expect(pre.ready).toBe(false);
    expect(pre.conflicts).toEqual(['shared.txt']);
    expect(pre.reason).toMatch(/conflicted in shared.txt/);

    const prompt = landing.resolvePrompt(stream.id);
    expect(prompt).toContain('git merge main');
    expect(prompt).toContain('shared.txt');
    expect(prompt).toMatch(/both sides' intent/);
    expect(prompt).toMatch(/Run the tests, then commit/);
    expect(prompt).toMatch(/ready to land again/);

    // What the Resolve worker does: attach (the thread line), merge, fix, commit, finish.
    await streams.update('daemon', stream.id, { agent: { status: 'done' }, land_conflict: null });
    Bun.spawnSync(['git', 'merge', 'main'], { cwd: work.worktree });
    writeFileSync(join(work.worktree, 'shared.txt'), 'from main\nfrom the stream\n');
    git(['commit', '-q', '-am', 'merge main, keep both'], work.worktree);

    expect(landing.preflight(stream.id).ready).toBe(true);
    expect((await landing.land(stream.id)).status).toBe('landed');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('from main\nfrom the stream\n');
  });
});

describe('T176: the conflict is a structured record, not parsed from the thread', () => {
  test('a filename containing ", " survives intact', async () => {
    const name = 'a, b.txt';
    const work = branchWithWork('s-comma', name, 'stream\n');
    writeFileSync(join(repo, name), 'main\n');
    git(['add', name]);
    git(['commit', '-q', '-m', 'main']);
    const stream = await makeStream(work);
    expect((await landing.land(stream.id)).status).toBe('blocked');
    expect(streams.get(stream.id).land_conflict?.files).toEqual([name]);
    expect(landing.preflight(stream.id).conflicts).toEqual([name]);
    expect(landing.resolvePrompt(stream.id)).toContain(name);
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

describe('diff-level rules (T152, §8.2)', () => {
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

  test('a routed rule holds the land on its gate: nothing merged, landing waits', async () => {
    const gates = new GateService(store);
    const work = branchWithWork('s-routed', 'dep.txt', 'new dependency\n');
    const stream = await makeStream(work);
    const gate = await gates.request('classifier_review', {
      policy: store.getPolicy(),
      stream: stream.id,
      summary: 'adds a dependency',
      call: { tool: 'land', fingerprint: '0123456789abcdef', origin: 'diff_rules' },
    });
    landing = new LandingService({
      store,
      streams,
      gates,
      diffRules: {
        check: () => ({ decision: 'route', reason: 'adds a dependency', rule: 'RULE-2', gate }),
      },
    });

    const outcome = await landing.land(stream.id);

    expect(outcome.status).toBe('gated');
    expect(outcome.status === 'gated' && outcome.gate.id).toBe(gate.id);
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('0');
    expect(existsSync(work.worktree)).toBe(true);
    expect(threadBodies(stream.id).some((b) => b.includes('routed by diff rule RULE-2'))).toBe(
      true,
    );
  });

  test("approving the diff tier's gate lands the stream (wireLandGateResolution)", async () => {
    const gates = new GateService(store);
    const work = branchWithWork('s-routed-ok', 'dep2.txt', 'new dependency\n');
    const stream = await makeStream(work);
    const gate = await gates.request('classifier_review', {
      policy: store.getPolicy(),
      stream: stream.id,
      summary: 'adds a dependency',
      call: { tool: 'land', fingerprint: 'fedcba9876543210', origin: 'diff_rules' },
    });
    let answered = false;
    landing = new LandingService({
      store,
      streams,
      gates,
      diffRules: {
        // Before the human answers: routed. After: allowed — exactly what
        // `ClassifierDiffRules` does when it spends the approval.
        check: () =>
          answered
            ? { decision: 'allow' }
            : { decision: 'route', reason: 'adds a dependency', rule: 'RULE-3', gate },
      },
    });
    wireLandGateResolution(gates, landing);

    expect((await landing.land(stream.id)).status).toBe('gated');
    answered = true;
    await gates.respond(gate.id, 'approve', 'pete');

    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('1');
    expect(streams.get(stream.id).human.status).toBe('landed');
  });

  test('approving a per-action classifier_review gate never lands, however the tool is named', async () => {
    const gates = new GateService(store);
    const work = branchWithWork('s-hook-gate', 'edit.txt', 'an ordinary edit\n');
    const stream = await makeStream(work);
    landing = new LandingService({ store, streams, gates });
    wireLandGateResolution(gates, landing);

    // What the route band raises for a blocked tool call (§8.1): a real
    // vendor tool, no `origin`. `tool` is `payload.tool_name` verbatim — an
    // unconstrained vendor string — so the one named `land` is the case the
    // marker must survive, not a hypothetical.
    for (const tool of ['Edit', 'Bash', 'land']) {
      const gate = await gates.request('classifier_review', {
        policy: store.getPolicy(),
        stream: stream.id,
        summary: `a per-action ${tool} call`,
        call: { tool, path: join(work.worktree, 'edit.txt'), fingerprint: '00112233445566aa' },
      });
      await gates.respond(gate.id, 'approve', 'pete');
    }

    // Nothing merged, and the stream is still live work.
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('0');
    expect(streams.get(stream.id).human.status).not.toBe('landed');
    expect(existsSync(work.worktree)).toBe(true);
  });
});

describe('the operator checkout', () => {
  test('a clean checkout on the target is fast-forwarded, and unrelated untracked files survive', async () => {
    const work = branchWithWork('s-ff', 'feature.txt', 'feature\n');
    const stream = await makeStream(work);
    writeFileSync(join(repo, 'scratch.txt'), 'my notes\n'); // untracked, unrelated

    const outcome = await landing.land(stream.id);
    if (outcome.status !== 'landed') throw new Error('expected a landing');
    expect(git(['rev-parse', 'HEAD'])).toBe(outcome.sha);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    // `reset --hard` never touches untracked files; the notes are still there.
    expect(readFileSync(join(repo, 'scratch.txt'), 'utf8')).toBe('my notes\n');
    expect(git(['status', '--porcelain'])).toBe('?? scratch.txt');
  });

  test('refuses (and publishes nothing) when the merge would overwrite an untracked file in that checkout', async () => {
    const work = branchWithWork('s-collide', 'feature.txt', 'from the stream\n');
    const stream = await makeStream(work);
    // The operator has their own, untracked, file at the path the merge
    // introduces — `reset --hard` would silently overwrite it.
    writeFileSync(join(repo, 'feature.txt'), 'my own draft\n');
    const mainBefore = git(['rev-parse', 'refs/heads/main']);

    expect(landing.land(stream.id)).rejects.toThrow(/would overwrite untracked feature.txt/);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('my own draft\n');
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(streams.get(stream.id).human.status).toBe('open');
    expect(existsSync(work.worktree)).toBe(true);
  });

  test('refuses rather than merging when the target is checked out with uncommitted changes', async () => {
    const work = branchWithWork('s-dirty', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    writeFileSync(join(repo, 'README.md'), '# edited by the operator\n');

    expect(landing.land(stream.id)).rejects.toThrow(/uncommitted changes at .*\(README\.md\)/);
    expect(git(['rev-list', '--count', '--merges', 'main'])).toBe('0');

    // T177: the refusal names the dirty paths, capped with "and N more".
    for (let i = 1; i <= 6; i++) writeFileSync(join(repo, `staged-${i}.txt`), `${i}\n`);
    git(['add', 'staged-*.txt']);
    await expect(landing.land(stream.id)).rejects.toThrow(/and 2 more\)/);
  });
});

describe('T161: the stream page reads (preflight and diff)', () => {
  test('preflight says why land would refuse, without writing anything', async () => {
    const never = await makeStream();
    expect(landing.preflight(never.id)).toMatchObject({ ready: false });
    expect(landing.preflight(never.id).reason).toMatch(/has no branch/);

    const work = branchWithWork('s-pre', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    const before = threadBodies(stream.id);
    expect(landing.preflight(stream.id)).toEqual({
      ready: true,
      branch: 's-pre',
      target: 'main',
      ahead: 1,
    });

    // A dirty checkout of the target is the refusal `land` would raise.
    writeFileSync(join(repo, 'README.md'), '# dirty\n');
    const dirty = landing.preflight(stream.id);
    expect(dirty.ready).toBe(false);
    expect(dirty.reason).toMatch(/uncommitted changes/);
    expect(threadBodies(stream.id)).toEqual(before);
  });

  test('diff shows the worktree against the target, uncommitted edits included', async () => {
    const work = branchWithWork('s-diff', 'a.txt', 'a\n');
    const stream = await makeStream(work);
    writeFileSync(join(work.worktree, 'b.txt'), 'uncommitted\n');
    git(['add', 'b.txt'], work.worktree);
    const diff = landing.diff(stream.id);
    expect(diff.target).toBe('main');
    expect(diff.worktree).toBe(work.worktree);
    expect(diff.patch).toContain('+a');
    expect(diff.patch).toContain('+uncommitted');
    expect(diff.truncated).toBe(false);
    const unattached = await makeStream({ title: 'never attached' });
    expect(() => landing.diff(unattached.id)).toThrow(LandRefusedError);
  });
});

describe('T166: a branch merged outside `land`', () => {
  test('a --no-ff merge done by hand: preflight says merged, Mark landed records it as human', async () => {
    const work = branchWithWork('s-merged', 'm.txt', 'm\n');
    const stream = await makeStream(work);
    git(['merge', '-q', '--no-ff', '-m', 'merge by hand', 's-merged']);
    const pre = landing.preflight(stream.id);
    expect(pre).toMatchObject({ ready: false, merged: true, target: 'main', ahead: 0 });
    expect(pre.reason).toBe('s-merged is already merged into main');

    const landed = await landing.markLanded(stream.id);
    expect(landed.human.status).toBe('landed');
    expect(threadBodies(stream.id).some((b) => b.startsWith('marked landed:'))).toBe(true);
    const lines = readFileSync(join(stateRoot, 'log', 'events.jsonl'), 'utf8');
    const updates = lines
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> })
      .filter((event) => event.kind === 'stream_updated');
    expect(updates.at(-1)?.data).toMatchObject({ human_status: 'landed', principal: 'human' });
  });

  test('a fast-forward merge is also detected (the branch moved off its fork point)', async () => {
    const work = branchWithWork('s-ff', 'f.txt', 'f\n');
    const stream = await makeStream(work);
    git(['merge', '-q', '--ff-only', 's-ff']);
    expect(landing.preflight(stream.id).merged).toBe(true);
  });

  test('a branch with no commits of its own stays "nothing to land" and cannot be marked', async () => {
    const worktree = join(repo, '.worktrees', 's-empty');
    git(['worktree', 'add', '-q', '-b', 's-empty', worktree, 'main']);
    const stream = await makeStream({ branch: 's-empty', worktree });
    // The target moves on without it.
    writeFileSync(join(repo, 'other.txt'), 'x\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'other work']);
    const pre = landing.preflight(stream.id);
    expect(pre.merged).toBeUndefined();
    expect(pre.reason).toMatch(/nothing to land/);
    await expect(landing.markLanded(stream.id)).rejects.toBeInstanceOf(LandRefusedError);
    expect(streams.get(stream.id).human.status).toBe('open');
  });
});
