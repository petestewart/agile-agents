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

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket, TicketId } from '@agile-agents/shared';

/** §15: "created by the daemon off `integration`". */
export const INTEGRATION_BRANCH = 'integration';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
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

/** `tkt/<digits>-<slug>` — pure function of the ticket's id/title, so it's stable across engineer/reviewer/QA callers without reading anything off disk. */
export function ticketBranchName(ticket: Ticket): string {
  return `tkt/${ticketDigits(ticket.id)}-${slugify(ticket.title)}`;
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
    return { path, branch, created: false };
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
  const branch = ticketBranchName(ticket);
  const path = join(repoRoot, '.worktrees', `${ticket.id}-qa`);
  if (existsSync(path)) {
    return { path, branch, created: false };
  }

  ensureIntegrationBranch(repoRoot);
  if (!branchExists(repoRoot, branch)) {
    runGit(['branch', branch, INTEGRATION_BRANCH], repoRoot);
  }
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  runGit(['clone', '--branch', branch, '--single-branch', '--', repoRoot, path], repoRoot);
  return { path, branch, created: true };
}
