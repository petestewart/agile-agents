/**
 * Discovery triage (T014 — design/agile-agents-design.md §5 "Discovery ->
 * standup -> resume" steps 1-3, §4 "Board"/"Halts").
 *
 * "1. Engineer writes a discovery board stanza ... 2. EM forwards to
 * architect; architect confirms or changes tier. 3. Architect creates the
 * halt file (scoped or global) ..." — `triageDiscovery` is the pure decision
 * (no store/bus access) the architect's MCP verb (`verbs.ts`'s
 * `discovery_triage`) wraps with the actual `createHalt` call.
 *
 * DESIGN-GAP: the design names the three tiers (§3 "Tiered halts": "local
 * (note it, continue) / scoped (named tickets pause) / global (oracle
 * changes, everyone stops)") but gives no formula for picking between scoped
 * and global from a discovery's data. Read literally from that one-line
 * definition: `local` when nothing beyond the reporter itself is
 * live-affected (nothing to pause); otherwise the tier tracks blast radius
 * the same way the pointing rubric does — a discovery that ripples to most
 * of the currently-live board is "everyone stops" (global), a discovery that
 * ripples to a named handful is "named tickets pause" (scoped). The 50%
 * threshold below is this ticket's own reading, not a cited number — see
 * `GLOBAL_THRESHOLD_FRACTION`.
 */

import type {
  OracleIndex,
  StanzaDiscovery,
  Ticket,
  TicketId,
  TicketStatus,
} from '@agile-agents/shared';

/** Statuses a halt has anything to say to — a `done`/`draft` ticket can't be "paused" by one. */
const LIVE_STATUSES: readonly TicketStatus[] = [
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
  'blocked',
  'paused',
];

/** See file header — this ticket's own reading of "everyone stops" vs "named tickets pause", not a cited design number. */
export const GLOBAL_THRESHOLD_FRACTION = 0.5;

export interface TriageInput {
  /** The ticket whose engineer raised the discovery — excluded from "affects more than just me" unless it also happens to be named some other way (it can't be, `affects` names oracle ids, not tickets). */
  reporterTicket: TicketId;
  discovery: StanzaDiscovery;
}

export interface TriageResult {
  tier: 'local' | 'scoped' | 'global';
  /** Live tickets (other than the reporter) whose `oracle_refs` intersect the discovery's proposed `affects` — the halt's scope when `tier !== 'local'`. */
  affected: TicketId[];
}

/**
 * `triageDiscovery` — the architect's confirm-or-change-tier step. Computes
 * the real affected set from current oracle/ticket state (never trusts the
 * engineer's own `discovery.tier` guess at face value, though a scoped/
 * global proposal from the engineer is folded in as a floor: the architect
 * "confirms or changes" a tier, and confirming a floor the engineer already
 * raised needs no new evidence to *lower* it below what was reported).
 */
export function triageDiscovery(
  input: TriageInput,
  tickets: readonly Ticket[],
  _oracleIndex: OracleIndex,
): TriageResult {
  const { reporterTicket, discovery } = input;

  const liveOthers = tickets.filter(
    (t) => t.id !== reporterTicket && LIVE_STATUSES.includes(t.status),
  );

  const affectedIds = new Set<TicketId>();
  if (discovery.affects.length > 0) {
    for (const ticket of liveOthers) {
      if (ticket.oracle_refs.some((ref) => discovery.affects.includes(ref))) {
        affectedIds.add(ticket.id);
      }
    }
  }
  const affected = [...affectedIds];

  if (affected.length === 0) {
    // Nothing else on the live board depends on what this discovery touches
    // — the engineer's own proposed tier floor still applies (§5 step 2:
    // "confirms or changes", not "always trusts blindly downward", but with
    // no computed evidence for a wider scope there is nothing to raise it
    // with either) only when it names concrete tickets we can't see here;
    // absent that, `local` — nothing to halt.
    return { tier: 'local', affected: [] };
  }

  const liveCount = Math.max(liveOthers.length, 1);
  const tier =
    affected.length / liveCount >= GLOBAL_THRESHOLD_FRACTION || discovery.tier === 'global'
      ? 'global'
      : 'scoped';

  return { tier, affected };
}
