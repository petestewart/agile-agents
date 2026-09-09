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
