/**
 * Thin git wrapper for the landing path (§8.2). `Bun.spawnSync` with argv,
 * never a shell string, so no argument is re-interpreted. Every spawn uses
 * `sandboxedSubprocessEnv` (git reads `HOME` for global config and
 * credential helpers), and callers pass `repoRoot` explicitly rather than
 * have it guessed from a `/.worktrees/` path segment.
 *
 * `gitWrite` is for anything that can create a commit: unsigned (`-c
 * commit.gpgsign=false` before the verb; the signing hook has failed with
 * "too many open files") and authored by a fixed daemon identity.
 */

import { sandboxedSubprocessEnv } from '../subprocess-env';

const textDecoder = new TextDecoder();

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Fixed identity for every commit this module makes. */
export const DAEMON_GIT_AUTHOR = {
  name: 'agiled',
  email: 'agiled@agile-agents.local',
} as const;

function daemonEnv(repoRoot: string): Record<string, string> {
  return {
    ...sandboxedSubprocessEnv(repoRoot, 'git'),
    GIT_AUTHOR_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: DAEMON_GIT_AUTHOR.email,
    GIT_COMMITTER_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: DAEMON_GIT_AUTHOR.email,
  };
}

function spawnGit(argv: string[], cwd: string, env: Record<string, string>): GitResult {
  const result = Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: textDecoder.decode(result.stdout).trim(),
    stderr: textDecoder.decode(result.stderr).trim(),
  };
}

/** Read-only and plumbing commands (log, diff, rev-parse, worktree, ...). */
export function git(args: string[], cwd: string, repoRoot: string): GitResult {
  return spawnGit(['git', ...args], cwd, sandboxedSubprocessEnv(repoRoot, 'git'));
}

export class GitCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly cwd: string,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
    this.name = 'GitCommandError';
  }
}

/** Runs a plumbing command, throwing `GitCommandError` on a non-zero exit. */
export function runGit(args: string[], cwd: string, repoRoot: string): string {
  const result = git(args, cwd, repoRoot);
  if (result.exitCode !== 0) {
    throw new GitCommandError(args, cwd, result.stderr);
  }
  return result.stdout;
}

/**
 * Merge and commit: unsigned and daemon-authored. Never throws on a
 * non-zero exit (a conflict is an outcome the caller inspects).
 */
export function gitWrite(args: string[], cwd: string, repoRoot: string): GitResult {
  return spawnGit(['git', '-c', 'commit.gpgsign=false', ...args], cwd, daemonEnv(repoRoot));
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Why it wasn't removed; present whenever `removed` is `false`. */
  reason?: string;
}

/**
 * Removes a worktree without ever throwing. Any tracked modification keeps
 * it (never force past real work); untracked files only get `--force`,
 * since a plain remove refuses a non-empty dir. A failed status read is
 * reported like a failed removal: the contract is "is it gone now".
 */
export function removeWorktreeSafely(repoRoot: string, worktreePath: string): RemoveWorktreeResult {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, repoRoot);
  if (status.exitCode !== 0) {
    return { removed: false, reason: `could not read worktree status: ${status.stderr}` };
  }

  const lines = status.stdout.split('\n').filter((line) => line.length > 0);
  const hasTrackedChanges = lines.some((line) => !line.startsWith('??'));
  if (hasTrackedChanges) {
    return {
      removed: false,
      reason: 'worktree has uncommitted tracked changes — kept for inspection, not force-removed',
    };
  }

  const hasUntrackedOnly = lines.length > 0;
  const args = hasUntrackedOnly
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath];
  const result = git(args, repoRoot, repoRoot);
  if (result.exitCode !== 0) {
    return { removed: false, reason: `git worktree remove failed: ${result.stderr}` };
  }
  return { removed: true };
}
