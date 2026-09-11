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
import type { OracleWriteResult } from '../oracle';
import { oracleWrite } from '../oracle';
import { buildEvent } from '../store';
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

export interface ResolveDiscoveryOptions {
  /**
   * Review fix (opus blocker 3): the EM's timeout path (§5 step 4: "quorum:
   * reached ... once every affected agent reports or times out on
   * heartbeat" — the *quorum* timeout already covers the ordinary case;
   * `force` is for the rarer EM override past that, e.g. a stuck agent the
   * liveness sweep hasn't reaped yet). Bypasses the quorum check below.
   * Always logged (`halt_updated` event, `forced_release: true`) so a
   * forced resolution is visible in `log/events.jsonl`, not silent.
   */
  force?: boolean;
  /** Attributed on the forced-release log event. Defaults to `'em'` — the role §16/§5 name as the one who'd invoke this override. */
  forcedBy?: string;
}

export interface ResolveDiscoverySuccess {
  released: true;
  oracle: OracleWriteResult;
  halt: Halt;
}

/**
 * Review fix (opus blocker 3): quorum not yet `reached` and no `force` —
 * nothing is written (no decision published, halt left untouched), so a
 * caller can retry once quorum actually reaches, or escalate to a forced
 * release, without having double-published anything.
 */
export interface ResolveDiscoveryBlocked {
  released: false;
  reason: string;
  halt: Halt;
  /** Set when the decision was published anyway (quorum pending, not forced): the halt now names it via `resolves_when` and the EM loop releases it once quorum reaches. */
  oracle?: OracleWriteResult;
}

export type ResolveDiscoveryResult = ResolveDiscoverySuccess | ResolveDiscoveryBlocked;

/**
 * §5 step 6-7, in the order §5 gives the whole ceremony ("reports -> quorum
 * -> decision -> release"): "Architect publishes `decision`. Daemon runs
 * ripple walk ... Architect deletes the halt file, sends `resume`." `haltId`
 * names the halt this decision resolves; `entry`/`body` are the decision's
 * own content (the ticket's "resolveDiscovery(haltId, decisionId)" reads as
 * "the decision this halt names via `resolves_when`", but publishing needs
 * the entry's full content, not just its id — so this takes the entry/body
 * directly and treats `entry.id` as the "decisionId"). Sanity-checks the
 * halt's own `resolves_when` (when the halt already named one, from
 * `createHalt`) against `entry.id` before writing anything, so a mismatched
 * id fails before the oracle is touched rather than after.
 *
 * Review fix (opus blocker 3): the first version of this function published
 * the decision and released the halt regardless of `halt.quorum` — skipping
 * straight from "reports" to "decision/release" without ever checking
 * "quorum" landed in between, which lets a halt resolve (and its affected
 * tickets get reassigned) before every affected agent has actually reported
 * in and stashed its WIP. Now: `halt.quorum !== 'reached'` and no
 * `options.force` refuses outright (`released: false`, nothing written) —
 * see `ResolveDiscoveryOptions.force` for the one legitimate bypass.
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
  options: ResolveDiscoveryOptions = {},
): Promise<ResolveDiscoveryResult> {
  const halt = store.getHalt(haltId);
  if (halt.resolves_when !== undefined && halt.resolves_when !== entry.id) {
    throw new DiscoveryResolutionError(
      `halt ${haltId} names resolves_when=${halt.resolves_when}, not ${entry.id}`,
    );
  }

  if (halt.quorum !== 'reached' && !options.force) {
    // Twelfth live run (2026-09-11): the architect's ruling arrived 91 s
    // after it raised the halt, long before the 10-minute quorum timeout,
    // and refusing it outright left the halt with no `resolves_when` — so
    // when quorum did reach, `releaseIfResolved` had nothing to look for
    // and the global halt denied every other agent for the rest of the
    // run. Publish the decision now (its ripple is wanted regardless) and
    // pin it to the halt; the *release* still waits for quorum, which is
    // what the ordering rule protects (agents reporting and stashing WIP).
    const oracle = await publishDecision(store, entry, body);
    const pinned = await store.putHalt({ ...halt, resolves_when: entry.id });
    return {
      released: false,
      reason: `halt ${haltId} quorum is still pending — decision ${entry.id} published and pinned as resolves_when; the halt releases when quorum reaches (or on the quorum timeout)`,
      halt: pinned,
      oracle,
    };
  }

  if (halt.quorum !== 'reached') {
    // options.force === true past this point.
    await store.appendEvent(
      buildEvent('halt_updated', {
        data: {
          haltId,
          forced_release: true,
          by: options.forcedBy ?? 'em',
          quorum: halt.quorum,
        },
      }),
    );
  }

  // Eighteenth live run (2026-09-11): this used to `releaseHalt` inline —
  // the one release path with no `resume` broadcast. The agents that had
  // reported and ended their turns (the tier-1 deny tells them to) were
  // never woken; a reviewer sat idle until the liveness sweep reaped it
  // 5 min later and its ticket fell back to `ready`. The EM loop's
  // `releaseIfResolved` is the single release path now: it releases and
  // broadcasts `resume` on its next tick (seconds), given quorum `reached`
  // and the pinned decision on file — both left here. A forced resolution
  // marks quorum reached itself so that path releases it too.
  const oracle = await publishDecision(store, entry, body);
  const pinned = await store.putHalt({ ...halt, resolves_when: entry.id, quorum: 'reached' });
  return { oracle, halt: pinned, released: true };
}
