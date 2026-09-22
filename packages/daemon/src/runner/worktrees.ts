/**
 * Worktree manager — the hardened creation path a stream's first attach
 * uses (T113; design/cockpit-design.md §4.4: "`<repo>/.worktrees/<stream-id>
 * -<slug>/`, ensured in the repo's `.gitignore`"), and nothing else.
 *
 * T130 deleted the ticket-shaped helpers this module used to carry
 * (`ensureTicketWorktree`, `ensureQaClone`, `ticketBranch*`,
 * `checkedOutTicketBranch`, `ensureIntegrationBranch`, `ticketDigits` and
 * the `integration` branch itself) along with the ticket model and the
 * separate QA role that needed them (§4.2: "What is deleted: … the separate
 * QA role with its fresh clone"). A worktree now belongs to a stream, is
 * created once on first attach, and is never created anywhere else.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
// T113 — hardened worktree creation (PLAN.md §5, D11: borrowed from
// KiroCrew's worktree handler).
//
// Everything below is the hardened path streams use (T120/T130). It never
// goes through a shell: every git invocation is an argv array handed to
// `Bun.spawn`. Four properties it guarantees, which the older ticket
// helpers above do not:
//
//   1. No repo hook runs during the checkout — `core.hooksPath` points at
//      an empty directory for the duration of the `worktree add`, so a
//      `post-checkout` (or any other) hook committed to the repo under
//      review cannot execute daemon-side.
//   2. Repos with filter drivers configured are refused with a reason. A
//      `.gitattributes` `filter=` entry makes checkout run `filter.<n>.smudge`
//      — arbitrary configured commands — which `core.hooksPath` does not
//      cover.
//   3. The branch is claimed atomically with the expected-old-value form of
//      `git update-ref` using the zero oid ("must not exist"), so two
//      concurrent creates for the same stream id race in git, not in us:
//      exactly one wins and the loser gets a refusal.
//   4. The branch must not already exist anywhere — local or any
//      remote-tracking ref — so a stream never silently adopts someone
//      else's history.
// ---------------------------------------------------------------------------

/** All-zero object id: `git update-ref`'s "the ref must not exist" expected-old value. */
const ZERO_OID = '0'.repeat(40);

/** Directory the hardened checkout points `core.hooksPath` at: created empty, kept empty. */
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

async function gitAsync(args: string[], cwd: string): Promise<GitResult> {
  // argv array, never a shell string — no word splitting, no metacharacter
  // interpretation, so a stream slug or branch name can never inject a
  // command (D11's argv floor).
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: sandboxedSubprocessEnv(cwd, 'git'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runGitAsync(args: string[], cwd: string): Promise<string> {
  const result = await gitAsync(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The reason a repo's checkout cannot be trusted to be inert, or undefined
 * when it can. Filter drivers (`.gitattributes` `filter=<name>` plus
 * `filter.<name>.smudge/clean` in config) run configured commands on every
 * checked-out blob; `core.hooksPath` doesn't disarm them, so a repo that
 * configures any is refused outright rather than half-sandboxed.
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

/** Every ref name in the repo whose last path segments are `branch` — local heads and any remote-tracking ref. */
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

/** Ensures `.worktrees/` is ignored, appending the entry to `<repo>/.gitignore` when it isn't already there. */
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

/** Naming input for a hardened worktree: a stream id (T120) today, any stable id tomorrow. */
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

/** `<repo>/.worktrees/<id>-<slug>` — the directory `createWorktree` uses for this name. */
export function worktreePathFor(repoRoot: string, name: WorktreeName): string {
  return join(repoRoot, '.worktrees', worktreeDirName(name));
}

function worktreeDirName(name: WorktreeName): string {
  const id = slugify(name.id, 64);
  const slug = slugify(name.slug, 40);
  return slug ? `${id}-${slug}` : id;
}

/** T137: the namespace every daemon-cut branch lives in. */
export const STREAM_BRANCH_PREFIX = 'stream/';

/**
 * Creates `<repo>/.worktrees/<id>-<slug>` on a freshly claimed branch off
 * `baseRef`, with no shell, no repo hook and no filter driver. Throws
 * `WorktreeRefusedError` (with `reason`) rather than creating anything
 * half-made; on a failed checkout the claimed branch is released again so a
 * retry is clean.
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
  // T137: every branch the daemon cuts lives under `stream/`, so a repo's
  // own branch list says at a glance which branches an agent made. The
  // worktree directory name is unchanged — `stream/` is not a path here.
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

  // Atomic claim: the zero-oid expected-old value means "create only if the
  // ref does not exist". Two concurrent creates both reach here; git's ref
  // transaction lets exactly one through and the other gets a non-zero exit.
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
