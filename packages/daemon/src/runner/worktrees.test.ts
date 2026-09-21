import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorktreeRefusedError,
  createWorktree,
  slugify,
  worktreePathFor,
} from './worktrees';

let repo: string;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-runner-worktrees-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('slugify', () => {
  test('kebab-cases and caps at 40 chars', () => {
    expect(slugify('Agent runner and worktree manager')).toBe('agent-runner-and-worktree-manager');
    expect(slugify('A'.repeat(60)).length).toBeLessThanOrEqual(40);
    expect(slugify('!!!')).toBe('stream');
  });
});

describe('T034: git spawns in this module are sandboxed, never the real $HOME', () => {
  test('createWorktree sandboxes HOME under the repo root, not inside the worktree', async () => {
    const created = await createWorktree(repo, { id: 'str-9', slug: 'sandboxed' });
    expect(existsSync(join(repo, '.agile-daemon-cache', 'git', 'home'))).toBe(true);
    expect(existsSync(join(created.path, '.agile-daemon-cache'))).toBe(false);
  });
});

describe('T113: hardened worktree creation', () => {
  const name = { id: 'str-7', slug: 'hardened creation' };

  test('creates <repo>/.worktrees/<id>-<slug> on a freshly claimed branch', async () => {
    const result = await createWorktree(repo, name);
    expect(result.path).toBe(join(repo, '.worktrees', 'str-7-hardened-creation'));
    expect(result.branch).toBe('str-7-hardened-creation');
    expect(result.head).toBe(git(['rev-parse', 'HEAD']));
    expect(existsSync(join(result.path, 'README.md'))).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path)).toBe(result.branch);
    expect(worktreePathFor(repo, name)).toBe(result.path);
  });

  test('ensures .worktrees/ is in the repo .gitignore, appending once', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    await createWorktree(repo, name);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.worktrees/\n');
    await createWorktree(repo, { id: 'str-8', slug: 'second' });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.worktrees/\n');
  });

  test('two concurrent creates for the same id: exactly one succeeds', async () => {
    const results = await Promise.allSettled([
      createWorktree(repo, name),
      createWorktree(repo, name),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as WorktreeRefusedError;
    expect(error).toBeInstanceOf(WorktreeRefusedError);
    expect(['branch-exists', 'branch-claim-lost', 'worktree-exists']).toContain(error.reason);
    expect(error.message).toContain('str-7-hardened-creation');
  });

  test('refuses a repo with a .gitattributes filter driver, with a reason', async () => {
    writeFileSync(join(repo, '.gitattributes'), '# lfs\n*.bin filter=lfs diff=lfs -text\n');
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error).toBeInstanceOf(WorktreeRefusedError);
    expect(error.reason).toBe('filter-driver');
    expect(error.message).toContain('filter=lfs');
    expect(existsSync(join(repo, '.worktrees', 'str-7-hardened-creation'))).toBe(false);
  });

  test('refuses a repo with a filter.* git config entry', async () => {
    git(['config', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error.reason).toBe('filter-driver');
    expect(error.message).toContain('filter.lfs.smudge');
  });

  test('refuses when the branch already exists locally', async () => {
    git(['branch', 'str-7-hardened-creation']);
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error.reason).toBe('branch-exists');
    expect(error.message).toContain('refs/heads/str-7-hardened-creation');
  });

  test('refuses when the branch exists only as a remote-tracking ref', async () => {
    git(['update-ref', 'refs/remotes/origin/str-7-hardened-creation', git(['rev-parse', 'HEAD'])]);
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error.reason).toBe('branch-exists');
    expect(error.message).toContain('refs/remotes/origin/str-7-hardened-creation');
  });

  test('repo hooks do not run during the checkout', async () => {
    const marker = join(repo, 'hook-ran.txt');
    for (const hook of ['pre-checkout', 'post-checkout']) {
      const file = join(repo, '.git', 'hooks', hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> ${marker}\n`, { mode: 0o755 });
    }
    const result = await createWorktree(repo, name);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
