/**
 * Hard handoff — daemon-composed handoff stanza (T024; design/
 * agile-agents-design.md §10 "Quota-driven pause and handoff": "Hard
 * handoff: `429` mid-turn → daemon composes the handoff from diff + last
 * stanzas; same path." — also the fallback when a graceful instruction
 * (`graceful.ts`) goes unheeded past its deadline, "agent dies or won't
 * comply within a deadline" (session brief).
 *
 * Reuses `review/diff-summary.ts`'s `runDiffSummary` for the *committed*
 * side of the diff (ticket branch vs. `integration`) rather than
 * re-implementing a git-diff parser — same tool the reviewer already reads
 * before a human/model does. The *uncommitted* side (working tree) is a
 * plain `git diff --stat`, computed locally: an agent that hit a 429
 * mid-turn or never complied with the graceful instruction may have
 * unstaged/staged changes `runDiffSummary`'s ref-to-ref diff can't see at
 * all.
 */

import { existsSync } from 'node:fs';
import type { Stanza, TicketId } from '@agile-agents/shared';
import { runDiffSummary } from '../review/diff-summary';
import { INTEGRATION_BRANCH } from '../runner/worktrees';
import type { StateStore } from '../store';

interface GitResult {
  exitCode: number;
  stdout: string;
}

/** Never throws — a torn-down/never-materialized worktree (e.g. `cwd` itself doesn't exist) must not block composing *some* handoff, same reasoning as this function's own doc comment below. */
function git(args: string[], cwd: string): GitResult {
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
  } catch {
    return { exitCode: 1, stdout: '' };
  }
}

/** `git diff --stat` over the working tree (staged + unstaged) — best-effort empty string on any git failure (a corrupted/half-torn-down worktree must not block composing *some* handoff). */
function uncommittedStat(worktreePath: string): string {
  if (!existsSync(worktreePath)) return '';
  const staged = git(['diff', '--stat', '--cached'], worktreePath);
  const unstaged = git(['diff', '--stat'], worktreePath);
  const parts = [staged.stdout, unstaged.stdout].filter((s) => s.length > 0);
  return parts.join('\n');
}

/** Last `n` stanzas (any kind) for a ticket, oldest first — "diff + last stanzas" (§10). */
function lastStanzas(store: StateStore, ticket: TicketId, n = 3): Stanza[] {
  let stanzas: Stanza[];
  try {
    stanzas = store.listStanzas(ticket);
  } catch {
    stanzas = [];
  }
  return stanzas.slice(-n);
}

export interface ComposeHardHandoffOptions {
  store: StateStore;
  ticket: TicketId;
  /** Absolute path to the ticket's worktree. */
  worktreePath: string;
  repoRoot: string;
  reason: string;
}

/**
 * Synthesizes a `StanzaHandoff` block from the committed diff (vs.
 * `integration`), the working tree's uncommitted diff, and the ticket's
 * last few board stanzas — never invented prose about *why* the change was
 * made (the daemon has no turn to ask the model), only what's mechanically
 * observable. Every field is guaranteed non-empty (`StanzaHandoffSchema`'s
 * `done`/`next` are `.min(1)`) via an explicit fallback string.
 */
export function composeHardHandoff(opts: ComposeHardHandoffOptions): {
  handoff: NonNullable<Stanza['handoff']>;
  summary: string;
} {
  let committedSummary = "no committed changes on this ticket's branch yet";
  try {
    const diff = runDiffSummary({
      worktree: opts.worktreePath,
      base: INTEGRATION_BRANCH,
      head: 'HEAD',
      repoRoot: opts.repoRoot,
    });
    if (diff.files.length > 0) {
      committedSummary = diff.files.map((f) => `${f.status} ${f.path}`).join('; ');
    }
  } catch {
    // Worktree may already be gone/detached — fall back to the placeholder.
  }

  const uncommitted = uncommittedStat(opts.worktreePath);
  const stanzas = lastStanzas(opts.store, opts.ticket);
  const gotchasFromBoard = stanzas.map((s) => `[${s.kind}] ${s.summary}`).join('\n');

  const handoff: NonNullable<Stanza['handoff']> = {
    done: `(daemon-composed, hard handoff: ${opts.reason}) committed: ${committedSummary}`,
    next: 'Resume from this worktree: review the uncommitted diff and the board stanzas below before continuing.',
    gotchas: gotchasFromBoard.length > 0 ? gotchasFromBoard : undefined,
    uncommitted_state: uncommitted.length > 0 ? uncommitted : 'clean working tree',
  };

  const summary = `hard handoff (${opts.reason}): ${committedSummary}`;
  return { handoff, summary };
}
