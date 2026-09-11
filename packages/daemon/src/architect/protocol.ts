/**
 * Discovery -> standup -> resume, the architect's half (T014 — design/
 * agile-agents-design.md §5 "Discovery -> standup -> resume").
 *
 * This module has no behaviour of its own — it is the documented sequence
 * of calls a real architect turn makes across the verbs this ticket adds
 * (`verbs.ts`), for one caller (a ceremony driver, or `protocol.test.ts`) to
 * follow without re-deriving the order from the design doc each time:
 *
 * 1. `discovery_triage` — confirm/change the tier, raise a halt if not local.
 * 2. (steps 3-5, EM/standup/quorum — T015's ceremony, not this one).
 * 3. `decision_publish` with the halt's id — writes the decision, ripples
 *    every intersecting ticket to `stale`, releases the halt.
 * 4. `reRefineStale` (`refine.ts`, not a verb — called directly by the
 *    ceremony driver once EM/architect have decided *which* re-refine path
 *    each staled ticket takes) for every id `decision_publish` returned as
 *    staled.
 *
 * `runDiscoveryProtocol` runs exactly this sequence end-to-end for the
 * simple case every staled ticket takes the same re-refine decision — the
 * shape the T014 acceptance scenario needs ("a seeded contradiction ... ->
 * global halt -> new DEC -> stale -> re-refined ready in one architect
 * run"). A real ceremony driver calling the verbs one at a time (as
 * `protocol.test.ts`'s fake architect does, over the in-process MCP server)
 * is free to give each staled ticket a different `ReRefineDecision`.
 */

import type { HaltScope, OracleEntry, StanzaDiscovery, TicketId } from '@agile-agents/shared';
import type { ReRefineDecision } from './refine';
import { reRefineStale } from './refine';
import { registerArchitectTools } from './verbs';
import type { ArchitectToolDeps } from './verbs';

export interface RunDiscoveryProtocolInput {
  reporterTicket: TicketId;
  discovery: StanzaDiscovery;
  /** The decision that resolves the discovery, once triage says it isn't `local`. */
  decisionEntry: OracleEntry;
  decisionBody: string;
  /** Applied to every ticket the decision staled. Defaults to `{ kind: 'unchanged' }` (§4 "Ticket": "unchanged -> ready"). */
  reRefineDecisionFor?: (ticketId: TicketId) => ReRefineDecision;
}

export interface RunDiscoveryProtocolResult {
  tier: 'local' | 'scoped' | 'global';
  haltId: string | null;
  haltScope: HaltScope | null;
  staled: TicketId[];
  reRefined: TicketId[];
  /** False only when the halt's quorum wasn't `reached` yet (review fix, opus blocker 3) — `staled`/`reRefined` are both empty in that case, nothing having been published. */
  released: boolean;
  /** Present only when `released` is false. */
  reason?: string;
}

/**
 * Runs the full sequence over the architect's own MCP verbs (via
 * `registerArchitectTools`, the same dispatch the in-process/stdio MCP
 * bridge uses) plus a direct `reRefineStale` call per staled ticket. Returns
 * early with `haltId: null` when triage says `local` — nothing to publish, a
 * plain discovery note is enough (§5 step 2).
 */
export async function runDiscoveryProtocol(
  deps: ArchitectToolDeps,
  input: RunDiscoveryProtocolInput,
): Promise<RunDiscoveryProtocolResult> {
  const tools = registerArchitectTools(deps);
  const ctx = { agent: 'architect' as const };

  const triage = (await tools.callTool(ctx, 'discovery_triage', {
    reporterTicket: input.reporterTicket,
    discovery: input.discovery,
  })) as {
    tier: 'local' | 'scoped' | 'global';
    affected: TicketId[];
    halt: { id: string; scope: HaltScope } | null;
  };

  if (triage.tier === 'local' || !triage.halt) {
    return {
      tier: triage.tier,
      haltId: null,
      haltScope: null,
      staled: [],
      reRefined: [],
      released: true,
    };
  }

  const published = (await tools.callTool(ctx, 'decision_publish', {
    entry: input.decisionEntry,
    body: input.decisionBody,
    haltId: triage.halt.id,
  })) as { released: boolean; reason?: string; oracle?: { stale: TicketId[] } };

  if (!published.released) {
    // §5 ordering ("reports -> quorum -> decision -> release"): the halt's
    // quorum isn't `reached` yet. The decision is published and pinned to
    // the halt (`resolveDiscovery`, twelfth live run) so its ripple has
    // run, but the release — and the re-refine that follows it — waits for
    // quorum: the EM loop releases the halt then. This function doesn't
    // loop/wait on its own.
    return {
      tier: triage.tier,
      haltId: triage.halt.id,
      haltScope: triage.halt.scope,
      staled: published.oracle?.stale ?? [],
      reRefined: [],
      released: false,
      reason: published.reason,
    };
  }

  const staled = published.oracle?.stale ?? [];
  const decisionFor = input.reRefineDecisionFor ?? (() => ({ kind: 'unchanged' as const }));
  const reRefined: TicketId[] = [];
  for (const ticketId of staled) {
    const result = await reRefineStale(deps.store, ticketId, decisionFor(ticketId), {
      by: 'architect',
    });
    reRefined.push(result.parent.id);
  }

  return {
    tier: triage.tier,
    haltId: triage.halt.id,
    haltScope: triage.halt.scope,
    staled,
    reRefined,
    released: true,
  };
}
