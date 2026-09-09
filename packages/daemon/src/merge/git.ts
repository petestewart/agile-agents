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
 *
 * T034: every spawn here also runs with `sandboxedSubprocessEnv` (never
 * this process's inherited `$HOME`) — git respects `HOME` for its own
 * global config (`~/.gitconfig`) and, on some platforms, credential
 * helpers, and this module's callers span the daemon's own worktrees
 * (the repo root, a ticket worktree, `.worktrees/_integration`,
 * `.worktrees/_main`), never the operator's real home. Production must not
 * rely on the test preload's `GIT_CONFIG_GLOBAL=/dev/null` for this.
 *
 * T034 round 2 (review): `git`/`gitWrite`/`runGit` take `repoRoot` as an
 * explicit parameter — not derived from `cwd` by string-matching a
 * `/.worktrees/` segment (an earlier version of this file did that; a
 * heuristic is exactly the kind of thing that quietly breaks the day a
 * repo root or worktree happens to contain that literal substring itself,
 * or the layout changes). Every caller already knows its own repo root
 * (`merge/owner.ts`'s `this.repoRoot`, `merge/precommit.ts`'s threaded
 * `repoRoot` parameter) — passing it explicitly is strictly simpler than
 * recovering it.
 */

import { sandboxedSubprocessEnv } from '../subprocess-env';

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

function daemonEnv(repoRoot: string): Record<string, string> {
  return {
    ...sandboxedSubprocessEnv(repoRoot, 'git'),
    GIT_AUTHOR_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: DAEMON_GIT_AUTHOR.email,
    GIT_COMMITTER_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: DAEMON_GIT_AUTHOR.email,
  };
}

/** Read-only / plumbing commands (checkout, log, diff, rev-parse, worktree, ...). */
export function git(args: string[], cwd: string, repoRoot: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: sandboxedSubprocessEnv(repoRoot, 'git'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
export function runGit(args: string[], cwd: string, repoRoot: string): string {
  const result = git(args, cwd, repoRoot);
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
export function gitWrite(args: string[], cwd: string, repoRoot: string): GitResult {
  const result = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: daemonEnv(repoRoot),
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
