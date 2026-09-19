/**
 * Worktree manager (T012 — design/agile-agents-design.md §15 "Git model and
 * teams": "One worktree per ticket at `.worktrees/TKT-0231` on
 * `tkt/0231-<slug>`, created by the daemon off `integration` at
 * assignment... Deleted after merge; kept while `stale`/abandoned until the
 * architect says otherwise" — T019 owns deletion, this module never removes
 * a worktree once created).
 *
 * Reviewer path (manager decision, CLAUDE.md v0 default: "Reviewers read the
 * engineer's worktree through tools under a read-only permission policy"):
 * no separate `-review` worktree is created — the reviewer session runs in
 * the *same* physical directory `ensureTicketWorktree` returns for the
 * engineer, with the daemon's ACP permission responder confining it to
 * read-only via `role: 'reviewer'` (T010). QA gets a fresh clone (§13
 * "env: clone") at `.worktrees/<TKT-id>-qa`, cloned from the repo root
 * itself rather than a remote — the ticket's branch already exists there
 * once an engineer has run.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket, TicketId } from '@agile-agents/shared';
import { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from '../subprocess-env';

/** §15: "created by the daemon off `integration`". */
export const INTEGRATION_BRANCH = 'integration';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * T034: sandboxed, never this process's inherited `$HOME` — every call
 * site in this module passes `repoRoot` itself as `cwd` (worktree/clone
 * *targets* are always a `path` argument, never the cwd a command runs
 * from), so `cwd` here already *is* the repo root the sandbox should be
 * keyed on.
 */
function git(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: sandboxedSubprocessEnv(cwd, 'git'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

function branchExists(repoRoot: string, branch: string): boolean {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).exitCode === 0;
}

/**
 * Ticket id "TKT-0231" -> "0231" — §15's literal branch example is
 * `tkt/0231-<slug>` (digits only, not the full `TKT-` id), unlike the
 * directory name `.worktrees/TKT-0231` (full id). DESIGN-GAP: the design
 * gives exactly one worked example, not a rule; read literally rather than
 * inventing a different split.
 */
export function ticketDigits(id: TicketId): string {
  const match = /(\d+)\s*$/.exec(id);
  return match?.[1] ?? id.toLowerCase();
}

/** Ticket title -> kebab slug, ≤40 chars (ticket "Design" note). */
export function slugify(title: string, maxLen = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLen).replace(/-+$/g, '') || 'ticket';
}

/**
 * `tkt/<digits>-<slug>` — the name a *new* worktree for this ticket gets.
 * It is a function of the title, and the title is mutable: the architect's
 * `ticket_refine` (a ripple re-refine) rewrites it, after which this no
 * longer names the branch the worktree is on. Thirteen live runs in a row
 * lost every re-refined ticket this way — `diff_summary`, the review
 * protocol and the merge owner all asked git for the re-slugged name
 * (`fatal: ambiguous argument 'integration...tkt/1002-…-stable-on-tie'`)
 * while `.worktrees/TKT-1002` sat on `tkt/1002-sort-listtasks-by-due-date`.
 * Every caller that operates on an existing worktree must use
 * `ticketBranch` (the checked-out branch) instead; this stays the creation
 * name only.
 */
export function ticketBranchName(ticket: Ticket): string {
  return `tkt/${ticketDigits(ticket.id)}-${slugify(ticket.title)}`;
}

/** Branch checked out in `.worktrees/<TKT-id>`, or undefined when there is no such worktree (or it is detached). */
export function checkedOutTicketBranch(repoRoot: string, ticket: Ticket): string | undefined {
  const path = join(repoRoot, '.worktrees', ticket.id);
  if (!existsSync(path)) return undefined;
  // `-C path` with `repoRoot` as cwd: the sandboxed HOME must stay under
  // the repo root, never inside a worktree (T034).
  const result = git(['-C', path, 'symbolic-ref', '--short', 'HEAD'], repoRoot);
  return result.exitCode === 0 && result.stdout ? result.stdout : undefined;
}

/**
 * The ticket's branch for every git operation: the one its worktree is on
 * when the worktree exists, else the name a new worktree would get. Stable
 * across title edits, which `ticketBranchName` alone is not.
 */
export function ticketBranch(repoRoot: string, ticket: Ticket): string {
  return checkedOutTicketBranch(repoRoot, ticket) ?? ticketBranchName(ticket);
}

/**
 * Creates `integration` off the repo's currently checked-out branch if it
 * doesn't exist yet ("create `integration` from the repo's default branch if
 * missing — document", per the ticket's Design note). DESIGN-GAP: neither
 * the design nor the ticket says how to resolve "the repo's default branch"
 * when there's no remote to ask — this reads it as whatever `repoRoot`
 * itself has checked out (the state worktree lives at `.agile/` on its own
 * `agile-state` branch and never touches `repoRoot`'s HEAD, so this is safe
 * to call at any point after `agile init`).
 */
export function ensureIntegrationBranch(repoRoot: string): void {
  if (branchExists(repoRoot, INTEGRATION_BRANCH)) return;
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (currentBranch === 'HEAD') {
    // Detached HEAD (rare — a fresh test repo with no branch checked out).
    runGit(['branch', INTEGRATION_BRANCH], repoRoot);
    return;
  }
  runGit(['branch', INTEGRATION_BRANCH, currentBranch], repoRoot);
}

export interface WorktreeResult {
  /** Absolute path. */
  path: string;
  branch: string;
  /** False when an existing worktree/branch was reused (fix cycles, escalations — "the same worktree" per §15). */
  created: boolean;
}

/**
 * `.worktrees/<TKT-id>` on `tkt/<digits>-<slug>` off `integration` —
 * created once, reused on every later call for the same ticket (engineer
 * fix cycles, and the reviewer reusing the same physical directory — see
 * file header). Never deletes anything (T019's job).
 */
export function ensureTicketWorktree(repoRoot: string, ticket: Ticket): WorktreeResult {
  const path = join(repoRoot, '.worktrees', ticket.id);
  const branch = ticketBranchName(ticket);
  if (existsSync(path)) {
    // Report the branch the worktree is actually on — after a title edit
    // that is not `branch` (see `ticketBranchName`).
    return { path, branch: checkedOutTicketBranch(repoRoot, ticket) ?? branch, created: false };
  }

  ensureIntegrationBranch(repoRoot);
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  if (branchExists(repoRoot, branch)) {
    // Branch survived a worktree removal (or a QA clone created it first) —
    // reattach rather than fail on "branch already checked out" logic that
    // doesn't apply here (git worktree add-with-existing-branch is legal as
    // long as no *other* worktree already has it checked out).
    runGit(['worktree', 'add', path, branch], repoRoot);
  } else {
    runGit(['worktree', 'add', path, '-b', branch, INTEGRATION_BRANCH], repoRoot);
  }
  return { path, branch, created: true };
}

export interface QaCloneResult {
  /** Absolute path. */
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Fresh clone at `.worktrees/<TKT-id>-qa` (§13 "env: clone" — QA "gets a
 * fresh clone of the ticket branch in a throwaway directory by default").
 * Cloned from `repoRoot` itself, not a remote: the ticket's branch already
 * lives there (either from an engineer's worktree, or created here off
 * `integration` if QA is spawned before any engineer has run).
 */
export function ensureQaClone(repoRoot: string, ticket: Ticket): QaCloneResult {
  const branch = ticketBranch(repoRoot, ticket);
  const path = join(repoRoot, '.worktrees', `${ticket.id}-qa`);
  if (existsSync(path)) {
    return { path, branch, created: false };
  }

  ensureIntegrationBranch(repoRoot);
  if (!branchExists(repoRoot, branch)) {
    runGit(['branch', branch, INTEGRATION_BRANCH], repoRoot);
  }
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  // A local clone hard-links every loose object it finds in `repoRoot`'s
  // object store — which the engineer sessions' own `git commit`s (separate
  // processes, worktrees of this same repo) are writing to at the same
  // time: a `tmp_obj_*` seen by the clone's readdir and renamed before its
  // link() fails the whole clone with "failed to copy file … No such file
  // or directory" (CI, offline e2e, 2026-09-10 — the driver no longer
  // waits for turns, so QA clones now overlap other tickets' commits).
  // Retry from a clean destination; the race window is milliseconds.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      runGit(['clone', '--branch', branch, '--single-branch', '--', repoRoot, path], repoRoot);
      return { path, branch, created: true };
    } catch (err) {
      lastError = err;
      rmSync(path, { recursive: true, force: true });
      Bun.sleepSync(200 * attempt);
    }
  }
  throw lastError;
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
  /** Branch name to claim. Default: `<id>-<slug>`. */
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
  const branch = options.branch ?? dirName;

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
