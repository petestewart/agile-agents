/**
 * T471: closed means inactive (Reopen), Restore resumes, and Delete forever
 * removes a node from the trash: its records, worktree and (merged, or when
 * asked) its branch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stream, ulid, validateQuestion } from '@agile-agents/shared';
import { git, mainBranch } from '../delivery';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { reconstructStreams } from '../store/events';
import { StreamService } from './service';
import { TrashService } from './trash';

let repo: string;
let home: string;
let store: StateStore;
let streams: StreamService;
let trash: TrashService;
let root: Stream;

function sh(args: string[], cwd: string): string {
  const run = Bun.spawnSync(['git', ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-trash-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 'test@example.com'], repo);
  sh(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'initial'], repo);
  const init = runInit(repo);
  home = init.stateRoot;
  store = StateStore.open(home);
  await store.addRepo('demo', { path: repo });
  streams = new StreamService(store);
  trash = new TrashService({
    store,
    streams,
    home,
    git,
    targetOf: (node, repoRoot) => {
      const entry = node.repo !== undefined ? store.getRepos()[node.repo] : undefined;
      return entry !== undefined ? mainBranch(entry, repoRoot) : undefined;
    },
  });
  root = await streams.create('human', { title: 'Shop', goal: 'the shop' });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A node on `demo` with its own branch and worktree; `commit` puts a change on it. */
async function worked(title: string, commit: boolean, parent = root.id): Promise<Stream> {
  const node = await streams.create('human', { title, goal: 'g', repo: 'demo', parent });
  const branch = `stream/${node.id.slice(-6).toLowerCase()}`;
  const worktree = join(repo, '.worktrees', node.id);
  sh(['worktree', 'add', '-q', '-b', branch, worktree, 'main'], repo);
  if (commit) {
    writeFileSync(join(worktree, `${node.id}.txt`), 'x\n');
    sh(['add', '-A'], worktree);
    sh(['commit', '-q', '-m', title], worktree);
  }
  const session = ulid();
  mkdirSync(join(home, 'sessions', session), { recursive: true });
  writeFileSync(join(home, 'sessions', session, 'stderr.log'), 'log\n');
  return store.updateStream('daemon', node.id, (before) => ({
    ...before,
    branch,
    worktree,
    sessions: [{ id: session, vendor: 'claude', model: 'm', role: 'worker', status: 'stopped' }],
  }));
}

const branchExists = (branch: string) =>
  Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repo,
  }).exitCode === 0;

describe('T471: closed is inactive', () => {
  test('Reopen brings a closed node back open with a thread line; open, merged or trashed are left', async () => {
    const node = await streams.create('human', { title: 'n', goal: 'g', parent: root.id });
    await streams.close('human', node.id);
    const reopened = await streams.reopen('human', node.id);
    expect(reopened.human.status).toBe('open');
    expect(streams.readThread(node.id).entries.at(-1)?.body).toBe('reopened');
    // Already open: nothing happens.
    expect((await streams.reopen('human', node.id)).human.status).toBe('open');
    await streams.update('daemon', node.id, { human: { status: 'landed' } });
    expect((await streams.reopen('human', node.id)).human.status).toBe('landed');
  });

  test('Restore brings a closed node back open, ready to resume; its parts keep their state', async () => {
    const node = await streams.create('human', { title: 'n', goal: 'g', parent: root.id });
    const part = await streams.create('human', { title: 'p', goal: 'g', parent: node.id });
    await streams.close('human', part.id);
    await streams.close('human', node.id);
    await streams.archiveTree('human', node.id);
    await expect(streams.reopen('human', node.id)).rejects.toThrow('restore it first');
    await streams.unarchiveTree('human', node.id);
    expect(streams.get(node.id).human.status).toBe('open');
    expect(streams.get(part.id).human.status).toBe('closed');
  });
});

describe('T471: Delete forever', () => {
  test('refused for a node not in the trash and for a project root', async () => {
    const node = await streams.create('human', { title: 'n', goal: 'g', parent: root.id });
    await expect(trash.purge(node.id)).rejects.toThrow('not in the trash');
    await expect(trash.purge(root.id)).rejects.toThrow("project's root");
  });

  test('removes the subtree: records, thread, card, questions, waits, session logs, worktree and a merged branch', async () => {
    const node = await worked('Count files', false);
    const part = await streams.create('human', { title: 'part', goal: 'g', parent: node.id });
    const waiter = await streams.create('human', { title: 'waiter', goal: 'g', parent: root.id });
    await streams.wait('human', waiter.id, node.id);
    const questions = new QuestionService(store, streams);
    await questions.raise({
      stream: part.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: ulid(),
      text: 'which?',
    });
    await store.updateCard(node.id, () => undefined);
    await streams.archiveTree('human', node.id);

    const preview = trash.preview(node.id);
    expect(preview.nodes.map((n) => n.id)).toEqual([node.id, part.id]);
    expect(preview.branches).toEqual([]);

    const result = await trash.purge(node.id);
    expect(result.deleted).toEqual([node.id, part.id]);
    expect(result.kept_branches).toEqual([]);
    expect(store.hasStream(node.id)).toBe(false);
    expect(store.hasStream(part.id)).toBe(false);
    expect(existsSync(join(home, 'threads', `${node.id}.jsonl`))).toBe(false);
    expect(store.listEntities('questions', validateQuestion)).toEqual([]);
    expect(streams.get(waiter.id).waits_on).toBeUndefined();
    expect(existsSync(join(home, 'sessions', node.sessions[0]?.id ?? 'x'))).toBe(false);
    expect(existsSync(node.worktree ?? 'x')).toBe(false);
    expect(branchExists(node.branch ?? 'x')).toBe(false);
    expect(streams.readThread(root.id).entries.at(-1)?.body).toBe(
      'deleted forever: Count files with 1 below it',
    );
    // The log agrees: a deleted node is no divergence.
    const rebuilt = reconstructStreams(store.listEvents());
    expect(rebuilt[node.id]).toBeUndefined();
    expect(Object.keys(rebuilt).sort()).toEqual(
      streams
        .list({ include_archived: true })
        .map((s) => s.id)
        .sort(),
    );
  });

  test("a worktree outside the repo's .worktrees (the repo itself) is never removed", async () => {
    const odd = await streams.create('human', {
      title: 'odd',
      goal: 'g',
      repo: 'demo',
      parent: root.id,
    });
    await store.updateStream('daemon', odd.id, (before) => ({ ...before, worktree: repo }));
    await streams.archiveTree('human', odd.id);
    await trash.purge(odd.id);
    expect(store.hasStream(odd.id)).toBe(false);
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
  });

  test('a branch with unmerged commits is kept unless asked; the preview counts them', async () => {
    const kept = await worked('Add CSV', true);
    await streams.archiveTree('human', kept.id);
    expect(trash.preview(kept.id).branches).toEqual([
      { node: kept.id, title: 'Add CSV', branch: kept.branch as string, unmerged: 1 },
    ]);
    const result = await trash.purge(kept.id);
    expect(result.kept_branches).toEqual([kept.branch as string]);
    expect(branchExists(kept.branch as string)).toBe(true);
    expect(existsSync(kept.worktree as string)).toBe(false);

    const gone = await worked('Add JSON', true);
    await streams.archiveTree('human', gone.id);
    await trash.purge(gone.id, { deleteBranches: true });
    expect(branchExists(gone.branch as string)).toBe(false);
  });

  test('the preview names a worktree with uncommitted changes; Empty trash takes every trash root', async () => {
    const dirty = await worked('Half done', false);
    writeFileSync(join(dirty.worktree as string, 'README.md'), '# changed\n');
    const other = await streams.create('human', { title: 'other', goal: 'g', parent: root.id });
    await streams.archiveTree('human', dirty.id);
    await streams.archiveTree('human', other.id);
    expect(trash.preview(dirty.id).uncommitted).toEqual(['Half done']);
    expect(trash.roots().map((s) => s.id)).toEqual([other.id, dirty.id]);
    const result = await trash.empty();
    expect(result.deleted.sort()).toEqual([dirty.id, other.id].sort());
    expect(trash.roots()).toEqual([]);
    expect(streams.list({ include_archived: true }).map((s) => s.id)).toEqual([root.id]);
  });
});
