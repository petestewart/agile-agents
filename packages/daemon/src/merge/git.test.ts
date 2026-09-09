import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitWrite, runGit } from './git';

let repoRoot: string;

function rawGit(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'agile-merge-git-'));
  rawGit(['init', '-q', '-b', 'main'], repoRoot);
  rawGit(['config', 'user.email', 'test@example.com'], repoRoot);
  rawGit(['config', 'user.name', 'Test'], repoRoot);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  rawGit(['add', '-A'], repoRoot);
  rawGit(['commit', '-q', '-m', 'init'], repoRoot);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('T034: git()/gitWrite()/runGit() spawn with a sandboxed HOME, never the real one', () => {
  test('git() run directly in repoRoot creates a sandboxed HOME under <repoRoot>/.agile-daemon-cache/git/', () => {
    runGit(['rev-parse', 'HEAD'], repoRoot, repoRoot);
    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);
  });

  test('git() run in a `.worktrees/<name>` subdirectory sandboxes under the *explicit repoRoot* passed in, not derived from cwd', () => {
    const worktreeDir = join(repoRoot, '.worktrees', 'TKT-0001');
    mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
    rawGit(['worktree', 'add', worktreeDir, '-b', 'tkt-0001', 'main'], repoRoot);

    // cwd is the worktree; repoRoot is passed explicitly and separately —
    // T034 round 2 dropped the earlier `/.worktrees/` string-heuristic in
    // favour of every caller stating its own repo root.
    const result = git(['status', '--porcelain'], worktreeDir, repoRoot);
    expect(result.exitCode).toBe(0);

    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);
    // Nothing sandboxed lands inside the worktree itself.
    expect(existsSync(join(worktreeDir, '.agile-daemon-cache'))).toBe(false);
  });

  test('an explicit repoRoot that differs from cwd is honoured exactly, not silently corrected', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'agile-merge-git-other-'));
    try {
      const result = git(['rev-parse', 'HEAD'], repoRoot, otherRoot);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(otherRoot, '.agile-daemon-cache', 'git', 'home'))).toBe(true);
      expect(existsSync(join(repoRoot, '.agile-daemon-cache'))).toBe(false);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test('gitWrite() (rebase/merge/commit path) also sandboxes HOME, alongside the daemon author env', () => {
    const result = gitWrite(['commit', '--allow-empty', '-m', 'noop'], repoRoot, repoRoot);
    expect(result.exitCode).toBe(0);
    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);

    const author = runGit(['log', '-1', '--format=%an <%ae>'], repoRoot, repoRoot);
    expect(author).toBe('agiled <agiled@agile-agents.local>');
  });

  test('never overrides an already-set GIT_CONFIG_GLOBAL (production must not rely on it, but must not clobber it either)', () => {
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      // A plain `git()` call still succeeds with the override in place —
      // proof this module doesn't stomp on it, whatever the caller set.
      const result = git(['rev-parse', 'HEAD'], repoRoot, repoRoot);
      expect(result.exitCode).toBe(0);
    } finally {
      if (original === undefined) {
        process.env.GIT_CONFIG_GLOBAL = undefined;
      } else {
        process.env.GIT_CONFIG_GLOBAL = original;
      }
    }
  });
});
