/**
 * Decision publishing (T014 — design/agile-agents-design.md §4 "Oracle",
 * §5 "Discovery -> standup -> resume" steps 6-7).
 *
 * `publishDecision` is a thin, architect-scoped wrapper over T007's
 * `oracleWrite` (which already runs the ripple walk itself and returns the
 * staled ticket ids — see `../oracle/index.ts`); this module's own job is
 * step 7, releasing the halt the decision resolves, which `oracleWrite`
 * knows nothing about (T007's file ownership stops at `oracle/**`/`halts/**`
 * and doesn't cross ceremonies).
 */

import type { Halt, HaltId, OracleEntry } from '@agile-agents/shared';
import { releaseHalt } from '../halts';
import type { OracleWriteResult } from '../oracle';
import { oracleWrite } from '../oracle';
import type { StateStore } from '../store';

export class DiscoveryResolutionError extends Error {
  constructor(reason: string) {
    super(`resolveDiscovery refused: ${reason}`);
    this.name = 'DiscoveryResolutionError';
  }
}

/** `oracleWrite` scoped to the one actor allowed to call it from this ceremony (§4 "Oracle": "Writer: architect only"). */
export async function publishDecision(
  store: StateStore,
  entry: OracleEntry,
  body: string,
): Promise<OracleWriteResult> {
  return oracleWrite(store, { actor: 'architect', entry, body });
}

export interface ResolveDiscoveryResult {
  oracle: OracleWriteResult;
  halt: Halt;
  released: true;
}

/**
 * §5 step 6-7: "Architect publishes `decision`. Daemon runs ripple walk ...
 * Architect deletes the halt file, sends `resume`." `haltId` names the halt
 * this decision resolves; `entry`/`body` are the decision's own content (the
 * ticket's "resolveDiscovery(haltId, decisionId)" reads as "the decision
 * this halt names via `resolves_when`", but publishing needs the entry's
 * full content, not just its id — so this takes the entry/body directly and
 * treats `entry.id` as the "decisionId"). Sanity-checks the halt's own
 * `resolves_when` (when the halt already named one, from `createHalt`)
 * against `entry.id` before writing anything, so a mismatched id fails
 * before the oracle is touched rather than after.
 *
 * Sending the `resume` bus message with reassignments (§5 step 7's other
 * half) is the EM's ceremony (T015), not this one — this function's return
 * gives the caller everything needed to compose that message (`oracle.stale`
 * for who needs re-refining, `halt.affected` for who to resume).
 */
export async function resolveDiscovery(
  store: StateStore,
  haltId: HaltId,
  entry: OracleEntry,
  body: string,
): Promise<ResolveDiscoveryResult> {
  const halt = store.getHalt(haltId);
  if (halt.resolves_when !== undefined && halt.resolves_when !== entry.id) {
    throw new DiscoveryResolutionError(
      `halt ${haltId} names resolves_when=${halt.resolves_when}, not ${entry.id}`,
    );
  }

  const oracle = await publishDecision(store, entry, body);
  await releaseHalt(store, haltId);
  return { oracle, halt, released: true };
}
