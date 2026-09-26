import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { buildStateRpcMethods, setRepoSettings } from './rpc-methods';
import { StateStore } from './store';

let scratch: string;
let store: StateStore;
let repo: string;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'agile-repo-set-'));
  store = StateStore.open(runInit(join(scratch, 'home')).stateRoot);
  repo = join(scratch, 'api');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  await store.addRepo('api', { path: repo });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const authYes = async () => true;
const authNo = async () => false;

describe('state.repo_set (T222, §14.8)', () => {
  test('direct settings apply; auto-merge, visibility and main_branch are stored, null clears', async () => {
    const set = buildStateRpcMethods(store)['state.repo_set'];
    await set?.({ name: 'api', auto_merge: true, main_branch: 'trunk' });
    expect(store.getRepos().api).toMatchObject({
      delivery: 'direct',
      auto_merge: true,
      main_branch: 'trunk',
    });
    await set?.({ name: 'api', main_branch: null });
    expect(store.getRepos().api?.main_branch).toBeUndefined();
    expect(store.listEvents().at(-1)?.kind).toBe('repos_put');
  });

  test('pr is refused with no remote', async () => {
    await expect(
      setRepoSettings(store, 'api', { delivery: 'pr' }, { githubAuth: authYes }),
    ).rejects.toThrow('has no remote origin');
    expect(store.getRepos().api?.delivery).toBe('direct');
  });

  test('pr is refused when the remote is not GitHub', async () => {
    git(['remote', 'add', 'origin', 'git@gitlab.com:o/api.git'], repo);
    await expect(
      setRepoSettings(store, 'api', { delivery: 'pr' }, { githubAuth: authYes }),
    ).rejects.toThrow('not on github.com');
  });

  test('pr is refused when GitHub auth is unavailable, and by default (no seam)', async () => {
    git(['remote', 'add', 'origin', 'https://github.com/acme/api.git'], repo);
    await expect(
      setRepoSettings(store, 'api', { delivery: 'pr' }, { githubAuth: authNo }),
    ).rejects.toThrow('needs GitHub auth');
    await expect(setRepoSettings(store, 'api', { delivery: 'pr' })).rejects.toThrow(
      'needs GitHub auth',
    );
    expect(store.getRepos().api?.delivery).toBe('direct');
  });

  test('pr with a GitHub remote and auth stores github owner/repo; a named remote is used', async () => {
    git(['remote', 'add', 'upstream', 'git@github.com:acme/api.git'], repo);
    const entry = await setRepoSettings(
      store,
      'api',
      { delivery: 'pr', remote: 'upstream', auto_merge: true },
      { githubAuth: authYes },
    );
    expect(entry).toMatchObject({
      delivery: 'pr',
      remote: 'upstream',
      auto_merge: true,
      github: { owner: 'acme', repo: 'api' },
    });
  });

  test('private visibility needs known projects; unknown fields and repos are refused', async () => {
    await expect(
      setRepoSettings(store, 'api', {
        visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
      }),
    ).rejects.toThrow('no project P-01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await expect(
      setRepoSettings(store, 'api', { github: { owner: 'x', repo: 'y' } }),
    ).rejects.toThrow();
    await expect(setRepoSettings(store, 'nope', { delivery: 'direct' })).rejects.toThrow(
      'no repo named nope',
    );
  });
});

describe('state.repo_add names (T389)', () => {
  test('a name is letters, digits, ".", "_" and "-", starting with a letter or digit', async () => {
    const add = buildStateRpcMethods(store)['state.repo_add'];
    if (!add) throw new Error('state.repo_add is missing');
    for (const name of ['__proto__', 'my repo', 'a/b', '-x', '.hidden', ' api2']) {
      await expect(add({ name, path: repo })).rejects.toThrow(/invalid name/);
    }
    await add({ name: 'ledger-lite.v2_x', path: repo });
    expect(Object.keys(store.getRepos())).toContain('ledger-lite.v2_x');
  });
});
