import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorktreeRefusedError,
  branchLabel,
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

describe('branchLabel (T371)', () => {
  test('a daemon-cut branch reads as its slug; any other branch as itself', () => {
    expect(branchLabel('stream/01k2abcdefghjkmnpqrstvwxyz-add-csv-import')).toBe('add-csv-import');
    expect(branchLabel('stream/01K2ABCDEFGHJKMNPQRSTVWXYZ-x')).toBe('x');
    expect(branchLabel('stream/01k2abcdefghjkmnpqrstvwxyz')).toBe(
      'stream/01k2abcdefghjkmnpqrstvwxyz',
    );
    expect(branchLabel('main')).toBe('main');
    expect(branchLabel('feature/stream/x')).toBe('feature/stream/x');
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
    // T137: the branch lives under `stream/`; the worktree directory name
    // does not — `stream/` is a ref namespace, not a path segment.
    expect(result.branch).toBe('stream/str-7-hardened-creation');
    expect(result.head).toBe(git(['rev-parse', 'HEAD']));
    expect(existsSync(join(result.path, 'README.md'))).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path)).toBe(result.branch);
    expect(worktreePathFor(repo, name)).toBe(result.path);
  });

  test('T177: ignores .worktrees/ via info/exclude, leaving the checkout clean', async () => {
    await createWorktree(repo, name);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    git(['check-ignore', '.worktrees/x']);
    const exclude = join(repo, '.git', 'info', 'exclude');
    await createWorktree(repo, { id: 'str-8', slug: 'second' });
    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines.filter((line) => line === '.worktrees/')).toHaveLength(1);
  });

  test('T177: adds nothing when .gitignore already ignores .worktrees/', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.worktrees/\n');
    git(['add', '.gitignore']);
    git(['commit', '-qm', 'ignore']);
    const exclude = join(repo, '.git', 'info', 'exclude');
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    await createWorktree(repo, name);
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').toBe(before);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.worktrees/\n');
    expect(git(['status', '--porcelain'])).toBe('');
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
    expect(error.message).toContain('stream/str-7-hardened-creation');
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
    git(['branch', 'stream/str-7-hardened-creation']);
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error.reason).toBe('branch-exists');
    expect(error.message).toContain('refs/heads/stream/str-7-hardened-creation');
  });

  test('refuses when the branch exists only as a remote-tracking ref', async () => {
    git([
      'update-ref',
      'refs/remotes/origin/stream/str-7-hardened-creation',
      git(['rev-parse', 'HEAD']),
    ]);
    const error = (await createWorktree(repo, name).catch((e) => e)) as WorktreeRefusedError;
    expect(error.reason).toBe('branch-exists');
    expect(error.message).toContain('refs/remotes/origin/stream/str-7-hardened-creation');
  });

  test('an explicit branch option is used as given, with no prefix', async () => {
    const result = await createWorktree(repo, name, { branch: 'legacy-branch' });
    expect(result.branch).toBe('legacy-branch');
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
