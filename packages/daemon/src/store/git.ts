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
 *
 * Ordering / partial-state note (review nit, documented not fully solved):
 * the store always writes its entity file(s) *before* calling
 * `commitPaths`. If the commit step itself throws (git missing, disk full,
 * a hook rejecting the commit), the write has already landed on disk and in
 * `log/events.jsonl`, but is not yet committed — the working tree is
 * ahead of `agile-state`'s history until the next mutation happens to touch
 * the same paths and sweep them into a commit under an unrelated message,
 * or until a human runs `git commit` by hand. `commitPaths` surfaces the
 * failure (it throws, it doesn't swallow), so the caller/daemon at least
 * sees the error rather than silently losing it; a full rollback (restoring
 * the prior file bytes and truncating the JSONL lines just appended) is not
 * implemented — flagged as a known gap rather than solved in this pass.
 */

const AUTHOR_NAME = 'agiled';
// Matches init.ts's bootstrap commit author (`agiled <agiled@localhost>`) —
// one author identity for every commit on `agile-state` (review nit: T005
// originally used `agiled@local`, a second identity for the same actor).
const AUTHOR_EMAIL = 'agiled@localhost';

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
 * Change detection (review nit fix): `git status --porcelain -- <paths>`
 * rather than matching git's human-readable commit output for "nothing to
 * commit" — porcelain format is a stable, locale-independent contract,
 * where the previous approach broke under any non-English `git` locale.
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

  const status = runGit(['status', '--porcelain', '--', ...relativePaths], stateRoot);
  if (status.length === 0) {
    return null;
  }

  runGit(['add', '-A', '--', ...relativePaths], stateRoot);

  runGit(
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

  return runGit(['rev-parse', 'HEAD'], stateRoot);
}
