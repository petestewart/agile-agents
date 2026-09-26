/**
 * Worktree creation for a stream's first attach (§4.4):
 * `<repo>/.worktrees/<stream-id>-<slug>/`, ignored via the repo's
 * `<git-common-dir>/info/exclude` (never `.gitignore`, so the user's
 * checkout stays clean). A worktree is created only here.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from '../subprocess-env';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const textDecoder = new TextDecoder();

/** Stream title -> kebab slug, capped (the worktree/branch name's readable half). */
export function slugify(title: string, maxLen = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLen).replace(/-+$/g, '') || 'stream';
}

// Hardened creation (D11, after KiroCrew's worktree handler). No shell:
// every git call is an argv array. It guarantees:
//
//   1. No repo hook runs during checkout (`core.hooksPath` points at an
//      empty dir), so a committed `post-checkout` can't execute daemon-side.
//   2. Repos with filter drivers are refused: a `filter=` attribute runs
//      `filter.<n>.smudge` on checkout, which `core.hooksPath` doesn't cover.
//   3. The branch is claimed atomically (`update-ref` with the zero oid as
//      expected old value), so of two concurrent creates exactly one wins.
//   4. The branch must not exist anywhere, local or remote-tracking, so a
//      stream never adopts someone else's history.

/** All-zero object id: `git update-ref`'s "the ref must not exist" expected-old value. */
const ZERO_OID = '0'.repeat(40);

/** Where `core.hooksPath` points during checkout: created empty, kept empty. */
const NO_HOOKS_DIR = join(DAEMON_CACHE_DIR, 'git', 'no-hooks');

/** A create that git (or this module's own preconditions) refused, carrying the reason. */
export class WorktreeRefusedError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason: which precondition refused. */
    readonly reason:
      | 'filter-driver'
      | 'branch-exists'
      | 'branch-claim-lost'
      | 'worktree-exists'
      | 'checkout-failed',
  ) {
    super(message);
    this.name = 'WorktreeRefusedError';
  }
}

/**
 * One `git` invocation as argv (D11: no shell, so a slug or branch can't
 * inject a command), run with `Bun.spawnSync` as the landing path's git is.
 *
 * Never the async `Bun.spawn`: it registers the child's pidfd on the
 * daemon's event loop, and when that `epoll_ctl` fails (`EBADF`: the pidfd
 * number is no longer open by the time it is registered) Bun 1.3.11 gives
 * up on the child and rejects `proc.exited` with `EBADF: bad file
 * descriptor, epoll_ctl` while git is still running, unreaped, its exit
 * status lost. Capturing stdio to files instead of pipes did not help: the
 * pidfd watch is not a stdio fd. That is how an attach failed its
 * `filterDriverRefusal` read with a 400 (the T161 cockpit e2e flake).
 * `spawnSync` falls back to a blocking `waitpid` when the watch fails, so
 * the exit status is always the child's own.
 */
function runGit(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: sandboxedSubprocessEnv(cwd, 'git'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: textDecoder.decode(result.stdout).trim(),
    stderr: textDecoder.decode(result.stderr).trim(),
  };
}

function runGitOrThrow(args: string[], cwd: string): string {
  const result = runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Why a repo's checkout can't be trusted to be inert, or `undefined`.
 * Filter drivers run configured commands on every checked-out blob and
 * `core.hooksPath` doesn't disarm them, so such a repo is refused.
 */
export async function filterDriverRefusal(repoRoot: string): Promise<string | undefined> {
  const attributeFiles = [
    join(repoRoot, '.gitattributes'),
    join(repoRoot, '.git', 'info', 'attributes'),
  ];
  for (const file of attributeFiles) {
    if (!existsSync(file)) continue;
    const text = await Bun.file(file).text();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /(?:^|\s)filter=(\S+)/.exec(line);
      if (match) {
        return `${file} configures a filter driver (filter=${match[1]}); checkout would run its smudge command`;
      }
    }
  }
  const config = runGit(['config', '--get-regexp', '^filter\\.'], repoRoot);
  if (config.exitCode === 0 && config.stdout) {
    const first = config.stdout.split('\n')[0]?.split(' ')[0] ?? 'filter.*';
    return `git config configures a filter driver (${first}); checkout would run its smudge command`;
  }
  return undefined;
}

/** Every local head or remote-tracking ref named `branch`. */
function existingBranchRefs(repoRoot: string, branch: string): string[] {
  const out = runGitOrThrow(
    ['for-each-ref', '--format=%(refname)', 'refs/heads/**', 'refs/remotes/**'],
    repoRoot,
  );
  if (!out) return [];
  return out.split('\n').filter((ref) => {
    if (ref === `refs/heads/${branch}`) return true;
    const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
    return remote?.[1] === branch;
  });
}

/**
 * Ignores `.worktrees/` via `<git-common-dir>/info/exclude` unless it is
 * already ignored (by `.gitignore`, exclude, or global excludes). Never
 * edits `.gitignore`: that would leave the user's checkout dirty.
 */
export async function ensureWorktreesIgnored(repoRoot: string): Promise<void> {
  const check = runGit(['check-ignore', '-q', '.worktrees/'], repoRoot);
  if (check.exitCode === 0) return;
  const commonDir = runGitOrThrow(['rev-parse', '--git-common-dir'], repoRoot);
  const infoDir = join(isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir), 'info');
  mkdirSync(infoDir, { recursive: true });
  const exclude = join(infoDir, 'exclude');
  const existing = existsSync(exclude) ? await Bun.file(exclude).text() : '';
  const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  await Bun.write(exclude, `${prefix}.worktrees/\n`);
}

/** Naming input for a worktree: a stream id and a slug. */
export interface WorktreeName {
  id: string;
  slug: string;
}

export interface CreateWorktreeOptions {
  /** Commit-ish the new branch starts at. Default: `HEAD`. */
  baseRef?: string;
  /** Branch name to claim. Default: `stream/<id>-<slug>`. */
  branch?: string;
}

export interface CreatedWorktree {
  /** Absolute path, `<repo>/.worktrees/<id>-<slug>`. */
  path: string;
  branch: string;
  /** The commit the branch was claimed at. */
  head: string;
}

/** `<repo>/.worktrees/<id>-<slug>`: the directory `createWorktree` uses. */
export function worktreePathFor(repoRoot: string, name: WorktreeName): string {
  return join(repoRoot, '.worktrees', worktreeDirName(name));
}

function worktreeDirName(name: WorktreeName): string {
  const id = slugify(name.id, 64);
  const slug = slugify(name.slug, 40);
  return slug ? `${id}-${slug}` : id;
}

/** Every daemon-cut branch lives under `stream/`. */
export const STREAM_BRANCH_PREFIX = 'stream/';

/**
 * A branch as a person reads it (T371): a daemon-cut `stream/<id>-<slug>`
 * is its slug; any other branch (or one with no slug) is itself.
 */
export function branchLabel(branch: string): string {
  const match = /^stream\/[0-9a-z]{26}-(.+)$/i.exec(branch);
  return match?.[1] ?? branch;
}

/**
 * Creates the worktree on a freshly claimed branch off `baseRef`, with no
 * shell, repo hook or filter driver. Throws `WorktreeRefusedError` rather
 * than leave anything half-made; a failed checkout releases the branch.
 */
export async function createWorktree(
  repoRoot: string,
  name: WorktreeName,
  options: CreateWorktreeOptions = {},
): Promise<CreatedWorktree> {
  const refusal = await filterDriverRefusal(repoRoot);
  if (refusal) {
    throw new WorktreeRefusedError(
      `refusing to create a worktree in ${repoRoot}: ${refusal}`,
      'filter-driver',
    );
  }

  const dirName = worktreeDirName(name);
  const path = join(repoRoot, '.worktrees', dirName);
  // Under `stream/`, so a repo's branch list shows which branches an agent made.
  const branch = options.branch ?? `${STREAM_BRANCH_PREFIX}${dirName}`;

  if (existsSync(path)) {
    throw new WorktreeRefusedError(`worktree path already exists: ${path}`, 'worktree-exists');
  }

  const clashes = existingBranchRefs(repoRoot, branch);
  if (clashes.length > 0) {
    throw new WorktreeRefusedError(
      `branch ${branch} already exists (${clashes.join(', ')})`,
      'branch-exists',
    );
  }

  const head = runGitOrThrow(
    ['rev-parse', '--verify', `${options.baseRef ?? 'HEAD'}^{commit}`],
    repoRoot,
  );

  // Atomic claim: the zero oid means "only if the ref doesn't exist".
  const claim = runGit(['update-ref', `refs/heads/${branch}`, head, ZERO_OID], repoRoot);
  if (claim.exitCode !== 0) {
    throw new WorktreeRefusedError(
      `lost the race to claim branch ${branch}: ${claim.stderr}`,
      'branch-claim-lost',
    );
  }

  await ensureWorktreesIgnored(repoRoot);
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  const hooksPath = join(repoRoot, NO_HOOKS_DIR);
  mkdirSync(hooksPath, { recursive: true });

  const add = runGit(
    ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'add', '--', path, branch],
    repoRoot,
  );
  if (add.exitCode !== 0) {
    // Release the claim so a retry isn't blocked by our own half-made state.
    rmSync(path, { recursive: true, force: true });
    runGit(['worktree', 'prune'], repoRoot);
    runGit(['update-ref', '-d', `refs/heads/${branch}`, head], repoRoot);
    throw new WorktreeRefusedError(
      `git worktree add failed for ${path}: ${add.stderr}`,
      'checkout-failed',
    );
  }

  return { path, branch, head };
}
