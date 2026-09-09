/**
 * QA environment resolution (T017 — design/agile-agents-design.md §13 "QA
 * environment and protocol": "fresh clone of the ticket branch in a
 * throwaway directory by default (`env: clone`); a container when the
 * ticket says so (`env: compose: <file>`) ... Daemon provisions, hands QA a
 * path and base URL, tears down after the verdict").
 *
 * The physical clone itself is `Runner`'s job (`runner/worktrees.ts`'s
 * `ensureQaClone`, T012, out of this ticket's file ownership) — by the time
 * `QaProtocol.start()` runs, `Runner.spawn('qa', ticket)` has already
 * created `.worktrees/<TKT-id>-qa` and handed that path to the QA agent's
 * session (`spawnResult.worktree`/`agent.worktree` — "the QA agent record's
 * worktree is the clone", this ticket's Design note). This module is the
 * validation layer in front of that: it reads `ticket.contract.env` and
 * either confirms `clone` (the only env this ticket implements) or refuses
 * clearly for `compose:` rather than silently proceeding as if the ticket's
 * env request were honored.
 */

import type { Ticket } from '@agile-agents/shared';

export interface QaEnv {
  kind: 'clone';
  /** Absolute path — the fresh clone `Runner.spawn('qa', ticket)` already made. */
  worktreePath: string;
}

/**
 * DESIGN-GAP (this ticket's Design note: "`compose` → DESIGN-GAP deferred
 * (refuse with a clear error)"): §13 names `env: compose: <file>` for
 * criteria that "need a DB, queue, browser" but gives no daemon-side
 * provisioning mechanism (docker lifecycle, base URL wiring, teardown) —
 * that's real, unbuilt machinery, not a one-line addition to this module.
 * Refusing loudly here (rather than silently running compose criteria
 * against a bare clone with no services up) is the safe reading; whoever
 * picks up compose support replaces this whole branch with the real thing.
 */
export class QaEnvUnsupportedError extends Error {
  constructor(readonly env: string) {
    super(
      `qa env ${JSON.stringify(env)} is not supported yet — only "clone" (§13 "env: clone") ships ` +
        'in this ticket; "compose: <file>" is a DESIGN-GAP deferred to a later ticket (no daemon-side ' +
        'container provisioning/teardown exists). Re-scope the ticket contract to env: clone, or pick up ' +
        'the compose environment before scheduling QA on it.',
    );
    this.name = 'QaEnvUnsupportedError';
  }
}

/** Resolves (and validates) the QA environment for `ticket`, given the worktree path `Runner` already provisioned. Throws `QaEnvUnsupportedError` for anything but `env: clone`. */
export function resolveQaEnv(ticket: Ticket, worktreePath: string): QaEnv {
  if (ticket.contract.env !== 'clone') {
    throw new QaEnvUnsupportedError(ticket.contract.env);
  }
  return { kind: 'clone', worktreePath };
}
