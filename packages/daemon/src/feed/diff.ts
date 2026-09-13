/**
 * Ticket worktree diff and bus thread (T044 — the T025 gap the ticket
 * names: "Ticket detail panel: blocked-by/blocks, contract, worktree diff,
 * review and QA verdicts (new `/api/tickets/:id/diff` and thread read
 * endpoints)").
 *
 * The diff is `git diff <integration>...HEAD` run *inside the ticket's own
 * worktree* — §15's "one worktree per ticket at `.worktrees/TKT-0231` ...
 * created by the daemon off `integration`", so that three-dot range is
 * exactly "what this ticket added on top of the integration branch it was
 * cut from".
 *
 * Two rules this module exists to enforce:
 *
 *  1. **Path guard.** A ticket's `worktree` field is a string in a YAML file
 *     the daemon reads back; an id that resolves anywhere outside
 *     `<repoRoot>/.worktrees/` is refused rather than run against. The guard
 *     is on the *resolved* path (symlinks included, via `realpathSync` where
 *     the path exists), not on the string, so `.worktrees/../..` and a
 *     symlinked worktree are both caught.
 *  2. **Signal over volume** (CLAUDE.md). The response body is capped; the
 *     full patch is written to the daemon's own raw-output cache and named
 *     by a `ref` pointer, the same shape `em/chat.ts` uses for an over-cap
 *     reply.
 *
 * Read-only: `git` here is the plumbing helper (`merge/git.ts`'s `git`),
 * which runs under `sandboxedSubprocessEnv` and never creates a commit.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Message, TicketId } from '@agile-agents/shared';
import { git } from '../merge/git';
import { INTEGRATION_BRANCH } from '../runner/worktrees';
import type { StateStore } from '../store';
import { rawOutputPath, writeRawOutput } from '../tools/cache';
import { readTicketThread } from './stories';

/** How much of the patch travels in the JSON response before the pointer takes over. */
export const DIFF_BODY_MAX_CHARS = 20_000;

/** Raw-output bucket for over-cap patches (`.agile-daemon-cache/raw/ticket-diff/`). */
const DIFF_RAW_BUCKET = 'ticket-diff';

/** Refused: the ticket has no worktree, or one that resolves outside `.worktrees/`. */
export class TicketDiffError extends Error {
  constructor(
    message: string,
    /** `404` when there is simply nothing to diff yet, `400` when the path is refused. */
    public readonly status: 400 | 404,
  ) {
    super(message);
    this.name = 'TicketDiffError';
  }
}

export interface TicketDiff {
  ticket: TicketId;
  /** The range that was diffed, e.g. `integration...HEAD`. */
  range: string;
  /** The worktree path, relative to the repo root. */
  worktree: string;
  branch?: string;
  /** `git diff --stat`'s summary line, when git produced one. */
  stat: string;
  /** The patch, capped at `DIFF_BODY_MAX_CHARS`. */
  patch: string;
  truncated: boolean;
  /** Pointer to the full patch in the daemon cache — present only when `truncated`. */
  ref?: string;
}

/**
 * Resolves and *guards* a ticket's worktree path. Exported for its own test:
 * this is the check that must refuse `..`-escapes and symlinks out of
 * `.worktrees/`, and it is cheaper to assert directly than through a server.
 */
export function resolveTicketWorktree(repoRoot: string, worktree: string): string {
  const worktreesDir = join(repoRoot, '.worktrees');
  if (!existsSync(worktreesDir)) {
    throw new TicketDiffError(`no ${worktreesDir} directory — nothing has been built yet`, 404);
  }
  const worktreesRoot = realpathSync(worktreesDir);
  const candidate = isAbsolute(worktree) ? worktree : resolve(repoRoot, worktree);
  // `realpathSync` only where it exists — a not-yet-created worktree must
  // still be refused for being outside, not crash on ENOENT.
  const resolved = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
  const rel = relative(worktreesRoot, resolved);
  // Exactly one segment under `.worktrees/`: `.worktrees/<TKT-id>` (and the
  // QA clone's `<TKT-id>-qa`) are the only shapes the daemon ever creates.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 1) {
    throw new TicketDiffError(
      `refusing a worktree path outside ${join(repoRoot, '.worktrees')}: ${worktree}`,
      400,
    );
  }
  if (!existsSync(resolved)) {
    throw new TicketDiffError(`no worktree on disk for this ticket: ${worktree}`, 404);
  }
  return resolved;
}

/**
 * `git diff integration...HEAD` inside the ticket's worktree, capped, with a
 * pointer to the full patch.
 */
export function ticketDiff(store: StateStore, repoRoot: string, ticket: TicketId): TicketDiff {
  const record = store.getTicket(ticket);
  if (!record.worktree) {
    throw new TicketDiffError(`${ticket} has no worktree yet — nothing has been built`, 404);
  }
  const worktreePath = resolveTicketWorktree(repoRoot, record.worktree);
  const range = `${INTEGRATION_BRANCH}...HEAD`;

  const branch = git(['symbolic-ref', '--short', 'HEAD'], worktreePath, repoRoot);
  const stat = git(['diff', '--stat', range], worktreePath, repoRoot);
  const patch = git(['diff', range], worktreePath, repoRoot);
  if (patch.exitCode !== 0) {
    throw new TicketDiffError(`git diff ${range} failed: ${patch.stderr || 'unknown error'}`, 400);
  }

  const full = patch.stdout;
  const truncated = full.length > DIFF_BODY_MAX_CHARS;
  let ref: string | undefined;
  if (truncated) {
    ref = `${DIFF_RAW_BUCKET}/${ticket}.diff`;
    writeRawOutput(rawOutputPath(repoRoot, DIFF_RAW_BUCKET, `${ticket}.diff`), full);
  }

  return {
    ticket,
    range,
    worktree: record.worktree,
    ...(branch.exitCode === 0 && branch.stdout ? { branch: branch.stdout } : {}),
    stat: stat.exitCode === 0 ? stat.stdout : '',
    patch: truncated ? full.slice(0, DIFF_BODY_MAX_CHARS) : full,
    truncated,
    ...(ref ? { ref } : {}),
  };
}

/**
 * The ticket's bus thread (`bus/threads/<ticket>/`), oldest first — every
 * message that touched the ticket, the reviewer's and QA's verdicts
 * included. Read-only and already body-capped at write time (§5), so it
 * needs no cap of its own.
 */
export function ticketThread(store: StateStore, ticket: TicketId): Message[] {
  return readTicketThread(store, ticket);
}
