/**
 * Commit batching on the `agile-state` worktree (T005 — design
 * agile-agents-design.md §15 "Git model and teams": ".agile/ lives on an
 * orphan branch agile-state, checked out as its own worktree"; §4 "What this
 * buys": every mutation is one commit so `git log` on `agile-state` reads as
 * an audit trail).
 *
 * One call = one logical operation = at most one commit, restricted to the
 * files that operation touched (never a blanket `git add -A`, so an
 * in-flight write from a different logical operation — there shouldn't be
 * one, given the store's mutex, but a human editing `.agile/` by hand is
 * possible — never rides along). "Nothing to commit" (the write produced no
 * byte-level change, e.g. re-transitioning to a state that re-serializes
 * identically) is not an error — it's the common case for idempotent retries.
 */

const AUTHOR_NAME = 'agiled';
const AUTHOR_EMAIL = 'agiled@local';

function git(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function runGit(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Stages exactly `relativePaths` (additions, modifications, and deletions —
 * `git add -A -- <paths>` scopes the "-A" to those pathspecs, not the whole
 * tree) and commits them with `message`, authored as `agiled`. No-op
 * (returns `null`) if none of those paths actually changed relative to
 * HEAD — "must tolerate nothing to commit" (T005 scope).
 *
 * `relativePaths` are relative to `stateRoot` (the `agile-state` worktree
 * root), matching how every store module builds paths.
 */
export function commitPaths(
  stateRoot: string,
  relativePaths: string[],
  message: string,
): string | null {
  if (relativePaths.length === 0) {
    throw new Error('commitPaths: relativePaths must be non-empty');
  }

  runGit(['add', '-A', '--', ...relativePaths], stateRoot);

  const result = git(
    [
      '-c',
      `user.name=${AUTHOR_NAME}`,
      '-c',
      `user.email=${AUTHOR_EMAIL}`,
      'commit',
      '-m',
      message,
      '--',
      ...relativePaths,
    ],
    stateRoot,
  );

  if (result.exitCode !== 0) {
    // "nothing to commit, working tree clean" (or the pathspec-scoped
    // equivalent) is not an error — tolerate it (T005 scope) and unstage
    // whatever `add -A` may have staged for these paths.
    if (/nothing to commit/.test(result.stdout) || /nothing to commit/.test(result.stderr)) {
      git(['reset', '--', ...relativePaths], stateRoot);
      return null;
    }
    throw new Error(`git commit failed in ${stateRoot}: ${result.stderr || result.stdout}`);
  }

  return runGit(['rev-parse', 'HEAD'], stateRoot);
}
