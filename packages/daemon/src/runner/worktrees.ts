/**
 * Worktree creation for a stream's first attach (§4.4):
 * `<repo>/.worktrees/<stream-id>-<slug>/`, ignored in `.gitignore`. A
 * worktree is created only here.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from '../subprocess-env';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Stream title -> kebab slug, capped (the worktree/branch name's readable half). */
export function slugify(title: string, maxLen = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLen).replace(/-+$/g, '') || 'stream';
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

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
 * inject a command), captured to files rather than pipes: reading piped
 * stdio alongside `proc.exited` races Bun's fd teardown (intermittent
 * `EBADF epoll_ctl`, truncated output). The same pattern as `test-run.ts`.
 */
async function gitAsync(args: string[], cwd: string): Promise<GitResult> {
  const capture = mkdtempSync(join(tmpdir(), 'agile-git-'));
  const stdoutPath = join(capture, 'stdout');
  const stderrPath = join(capture, 'stderr');
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      env: sandboxedSubprocessEnv(cwd, 'git'),
      stdin: 'ignore',
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    rmSync(capture, { recursive: true, force: true });
  }
}

async function runGitAsync(args: string[], cwd: string): Promise<string> {
  const result = await gitAsync(args, cwd);
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
  const config = await gitAsync(['config', '--get-regexp', '^filter\\.'], repoRoot);
  if (config.exitCode === 0 && config.stdout) {
    const first = config.stdout.split('\n')[0]?.split(' ')[0] ?? 'filter.*';
    return `git config configures a filter driver (${first}); checkout would run its smudge command`;
  }
  return undefined;
}

/** Every local head or remote-tracking ref named `branch`. */
async function existingBranchRefs(repoRoot: string, branch: string): Promise<string[]> {
  const out = await runGitAsync(
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

/** Adds `.worktrees/` to `<repo>/.gitignore` unless already ignored. */
export async function ensureWorktreesIgnored(repoRoot: string): Promise<void> {
  const gitignore = join(repoRoot, '.gitignore');
  const existing = existsSync(gitignore) ? await Bun.file(gitignore).text() : '';
  const ignored = existing
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === '.worktrees' || line === '.worktrees/' || line === '/.worktrees/');
  if (ignored) return;
  const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  await Bun.write(gitignore, `${prefix}.worktrees/\n`);
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

  const clashes = await existingBranchRefs(repoRoot, branch);
  if (clashes.length > 0) {
    throw new WorktreeRefusedError(
      `branch ${branch} already exists (${clashes.join(', ')})`,
      'branch-exists',
    );
  }

  const head = await runGitAsync(
    ['rev-parse', '--verify', `${options.baseRef ?? 'HEAD'}^{commit}`],
    repoRoot,
  );

  // Atomic claim: the zero oid means "only if the ref doesn't exist".
  const claim = await gitAsync(['update-ref', `refs/heads/${branch}`, head, ZERO_OID], repoRoot);
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

  const add = await gitAsync(
    ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'add', '--', path, branch],
    repoRoot,
  );
  if (add.exitCode !== 0) {
    // Release the claim so a retry isn't blocked by our own half-made state.
    rmSync(path, { recursive: true, force: true });
    await gitAsync(['worktree', 'prune'], repoRoot);
    await gitAsync(['update-ref', '-d', `refs/heads/${branch}`, head], repoRoot);
    throw new WorktreeRefusedError(
      `git worktree add failed for ${path}: ${add.stderr}`,
      'checkout-failed',
    );
  }

  return { path, branch, head };
}
