/**
 * Thin git wrapper for the merge/integration owner (T019 — design/
 * agile-agents-design.md §15 "Git model and teams": "ticket -> integration
 * on done ... integration -> main at sprint review"). `Bun.spawnSync` only,
 * never a shell string (session brief) — every argument is passed as its
 * own array element, so a branch/title/path with spaces or shell
 * metacharacters is never re-interpreted.
 *
 * `gitWrite` is used for every rebase/merge/commit this package makes: it
 * always prepends `-c commit.gpgsign=false` *before* the subcommand (a git
 * config override must precede the verb, not follow it) — same rationale as
 * `store/store.ts`'s `commitPaths` and the 2026-09-09 Discovered-Issues-Log
 * entry ("the git commit-signing hook ... fails with 'too many open
 * files' ... worker commits in worktrees may hit the same and should do
 * likewise") — and stamps a fixed daemon author/committer via env so a
 * merge/rebase commit's identity never depends on whatever `user.name`/
 * `user.email` happens to be configured in the calling environment.
 *
 * `removeWorktreeSafely` (review round 1, opus blocker 2): a plain `git
 * worktree remove` throws on a stray untracked file, and doing that *after*
 * the merge already landed would otherwise be the caller's last chance to
 * record the outcome — so this never throws, and draws the force/no-force
 * line at "tracked" vs "untracked", never forcing past uncommitted tracked
 * changes.
 */

const textDecoder = new TextDecoder();

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Fixed identity for every commit this module makes (merges, rebase replays). */
export const DAEMON_GIT_AUTHOR = {
  name: 'agiled',
  email: 'agiled@agile-agents.local',
} as const;

function daemonEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_AUTHOR_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: DAEMON_GIT_AUTHOR.email,
    GIT_COMMITTER_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: DAEMON_GIT_AUTHOR.email,
  };
}

/** Read-only / plumbing commands (checkout, log, diff, rev-parse, worktree, ...). */
export function git(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: textDecoder.decode(result.stdout).trim(),
    stderr: textDecoder.decode(result.stderr).trim(),
  };
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
export function runGit(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (result.exitCode !== 0) {
    throw new GitCommandError(args, cwd, result.stderr);
  }
  return result.stdout;
}

/**
 * Rebase / merge / commit — every command that can create a new commit.
 * Always unsigned (`-c commit.gpgsign=false`, prepended before the verb) and
 * daemon-authored (env). Never throws on a non-zero exit (rebase/merge
 * conflicts are an expected outcome the caller inspects), unlike `runGit`.
 */
export function gitWrite(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: daemonEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: textDecoder.decode(result.stdout).trim(),
    stderr: textDecoder.decode(result.stderr).trim(),
  };
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Why it wasn't removed — present whenever `removed` is `false`. */
  reason?: string;
}

/**
 * Removes `worktreePath` (a worktree of `repoRoot`) without ever throwing.
 * Reads `worktreePath`'s own status first: any *tracked* modification
 * (staged, unstaged, or a mid-operation state `git status` reports as
 * non-`??`) keeps the worktree untouched — never force past real work, even
 * though `git worktree remove --force` would happily discard it. Untracked
 * files only (build output, scratch files) get `--force`, since a plain
 * `git worktree remove` refuses to remove a non-empty directory. A status
 * check that itself fails (`worktreePath` already gone, say) is reported
 * the same way as a failed removal — this function's contract is "tell me
 * whether the worktree is gone after this call", not "diagnose why".
 */
export function removeWorktreeSafely(repoRoot: string, worktreePath: string): RemoveWorktreeResult {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath);
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
  const result = git(args, repoRoot);
  if (result.exitCode !== 0) {
    return { removed: false, reason: `git worktree remove failed: ${result.stderr}` };
  }
  return { removed: true };
}
