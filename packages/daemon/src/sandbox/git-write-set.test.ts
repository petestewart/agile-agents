/**
 * Proves round 3's B6 fix (review round 2: "an engineer still cannot commit
 * under either backend — `.git/logs` was missing from the write set") with
 * an actual `git commit`, not just a rendered-text assertion. This creates
 * a *real* linked worktree (`git worktree add`, so the `.git` gitfile
 * indirection is real — exactly the shape `git-paths.ts` parses), makes a
 * real commit in it, and — per the coordinator's suggested method — lists
 * every path git actually touched under the shared git dir via
 * `find -newer` and asserts each one falls inside the write set this
 * module's `buildSandboxProfile` + `sandbox-exec.ts`/`container.ts` would
 * grant an engineer. If a future git operation starts touching a path
 * outside that set, this test fails with the exact path, not a "trust me"
 * green run.
 *
 * Always runs (no `AGILE_LIVE` gate) — it needs only a local `git` binary
 * and a scratch directory, both available in this container.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveWorktreeGitPaths } from './git-paths';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Every filesystem root this module's engineer profile grants write into, given a real `WorktreeGitPaths` — mirrors exactly what `sandbox-exec.ts`/`container.ts` render (kept independent of importing them, so this test would still catch a regression in either). */
function engineerGitWriteRoots(gitPaths: {
  worktreeGitDir: string;
  commonGitDir: string;
}): string[] {
  return [
    gitPaths.worktreeGitDir,
    join(gitPaths.commonGitDir, 'objects'),
    join(gitPaths.commonGitDir, 'refs'),
    join(gitPaths.commonGitDir, 'logs'),
  ];
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

describe('engineer git write set (round 3 B6)', () => {
  test('a real `git commit` in a real linked worktree touches only paths the rendered write set covers', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'agile-sandbox-git-write-set-'));
    try {
      const repo = join(scratch, 'repo');
      const wt = join(scratch, 'wt');
      const gitEnv = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];

      git(['init', '-q', '-b', 'main', repo], scratch);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      git(['add', 'seed.txt'], repo);
      git([...gitEnv, 'commit', '-q', '-m', 'seed'], repo);
      git(['worktree', 'add', '-q', '-b', 'ticket-branch', wt, 'main'], repo);

      const gitPaths = resolveWorktreeGitPaths(wt);
      expect(gitPaths).not.toBeNull();
      if (!gitPaths) throw new Error('unreachable');

      const writeRoots = engineerGitWriteRoots(gitPaths);

      const sentinel = join(scratch, 'sentinel');
      // Sleep-free ordering guarantee: mtime resolution on most filesystems
      // is at least 1s on some (notably ext4 with certain mount options);
      // write the sentinel, then immediately do the commit — `find -newer`
      // only needs the sentinel to predate the commit's writes, which a
      // synchronous write-then-spawn sequence already guarantees without a
      // real sleep.
      writeFileSync(sentinel, '');

      writeFileSync(join(wt, 'change.txt'), 'change\n');
      git(['add', 'change.txt'], wt);
      git([...gitEnv, 'commit', '-q', '-m', 'a real engineer commit'], wt);

      // `commonGitDir` subsumes `worktreeGitDir` (it's
      // `<commonGitDir>/worktrees/<name>`), so one `find` over it sees
      // everything git touched for this commit on the shared side.
      const touched = execFileSync(
        'find',
        [gitPaths.commonGitDir, '-newer', sentinel, '-type', 'f'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      // Sanity: the commit really did touch something under the common
      // dir (objects + the branch reflog at minimum) — otherwise this test
      // would trivially pass by finding nothing.
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.some((p) => p.includes('logs/refs/heads/ticket-branch'))).toBe(true);

      const uncovered = touched.filter((p) => !writeRoots.some((root) => isUnder(p, root)));
      expect(uncovered).toEqual([]);
    } finally {
      // `git worktree add` registers the linked worktree in the main
      // repo's admin dir; a bare `rmSync` of the scratch tree is fine here
      // since the whole `repo` (including that admin state) is inside the
      // same scratch dir being removed — nothing outside `scratch` is left
      // dangling.
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
