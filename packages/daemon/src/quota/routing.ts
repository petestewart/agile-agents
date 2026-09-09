/**
 * `routeCandidates` — the `(role, tier) → ordered candidates` routing
 * policy (T023; design agile-agents-design.md §11 "Pointing rubric and
 * routing calibration": "Routing table becomes a policy: `(role, tier) →
 * ordered candidates [(vendor, model, reasoning)]`. Daemon picks the first
 * candidate with `remaining > floor` ... and no cooldown."; §8 "Adapter
 * contract" → "Auth": "Routing candidates are `(vendor, account, model)`,
 * so 'Max first, API key as overflow' is a routing policy, not
 * special-casing.").
 *
 * DESIGN-GAP: §11's example gives the *shape* of a routing table
 * (`(role, tier) → ordered [(vendor, model, reasoning)]`) but no schema or
 * file location for it, and this ticket's file-ownership boundary excludes
 * `packages/shared/**`'s `vendors.ts` `VendorsConfigSchema` (a `Record<
 * vendorName, VendorConfig>` — adding a sibling non-vendor `routing` key to
 * that record would break its own shape for every other consumer). A
 * `RoutingTable` is defined here instead as a plain injectable structure
 * (`routeCandidates`'s own `routing` option), matching the ticket's own
 * fallback wording verbatim ("`routing` table per §11 *if present*, else
 * the single Claude entry") — "if present" reads as "if the caller has
 * one to give", not "if `vendors.yaml` happens to carry one" once no
 * schema for embedding it there exists yet. Wiring an actual
 * `routing.yaml`/`vendors.yaml` stanza through to this parameter is left
 * to whichever ticket owns that schema change.
 */

import type { Quota, VendorsConfig } from '@agile-agents/shared';
import { DEFAULT_QUOTA_FLOOR, quotaFraction } from './records';

export interface RoutingCandidate {
  vendor: string;
  account: string;
  model?: string;
  reasoning?: string;
}

/** Keyed `"<role>:<tier>"` — ordered, most-preferred first (§11: "ordered candidates"). */
export type RoutingTable = Record<string, RoutingCandidate[]>;

export interface RouteNone {
  none: true;
  reason: string;
}

export type RouteResult = RoutingCandidate[] | RouteNone;

export interface RouteCandidatesOptions {
  vendors: VendorsConfig;
  /** Current `Quota` records — sparse is fine; a missing record is treated as a fully-available account (never observed = never spent). */
  quotas: Quota[];
  now?: Date;
  routing?: RoutingTable;
  /** Overrides `CLAUDE.md`'s quota-floor tunable (default 0.15) for every candidate this call considers. */
  floor?: number;
}

function routingKey(role: string, tier: string): string {
  return `${role}:${tier}`;
}

/** Every `(vendor, account)` pair configured in `vendors.yaml`, in file order — "else the single Claude entry" (§11) for the default seed config. */
function allConfiguredAccounts(vendors: VendorsConfig): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  for (const [vendor, config] of Object.entries(vendors)) {
    for (const account of config.accounts) {
      candidates.push({ vendor, account: account.id });
    }
  }
  return candidates;
}

function quotaFor(quotas: Quota[], vendor: string, account: string): Quota | undefined {
  return quotas.find((q) => q.vendor === vendor && q.account === account);
}

/**
 * `(role, tier) → ordered candidates`, filtered by floor + cooldown and
 * ordered by remaining fraction (most headroom first) — "Daemon picks the
 * first candidate with `remaining > floor` ... and no cooldown" (§11).
 * Ties (equal fraction, including two never-observed accounts) preserve
 * the routing table's/`vendors.yaml`'s own declared order.
 */
export function routeCandidates(role: string, tier: string, opts: RouteCandidatesOptions): RouteResult {
  const now = opts.now ?? new Date();
  const floor = opts.floor ?? DEFAULT_QUOTA_FLOOR;
  const configured = opts.routing?.[routingKey(role, tier)] ?? allConfiguredAccounts(opts.vendors);

  const scored = configured.map((candidate) => {
    const quota = quotaFor(opts.quotas, candidate.vendor, candidate.account);
    const fraction = quota ? quotaFraction(quota) : 1;
    const coolingDown = quota?.cooldown_until != null && Date.parse(quota.cooldown_until) > now.getTime();
    return { candidate, fraction, coolingDown };
  });

  const eligible = scored
    .filter((s) => !s.coolingDown && s.fraction > floor)
    .sort((a, b) => b.fraction - a.fraction)
    .map((s) => s.candidate);

  if (eligible.length === 0) {
    const allCoolingDown = scored.length > 0 && scored.every((s) => s.coolingDown);
    const reason =
      scored.length === 0
        ? `no candidates configured for ${role}:${tier}`
        : allCoolingDown
          ? `all candidates for ${role}:${tier} are in cooldown`
          : `no candidate for ${role}:${tier} above floor ${floor}`;
    return { none: true, reason };
  }
  return eligible;
}

/** First candidate from a `RouteResult`, or the `RouteNone` passed through unchanged. */
export function pickCandidate(result: RouteResult): RoutingCandidate | RouteNone {
  if ('none' in result) return result;
  const first = result[0];
  if (first === undefined) return { none: true, reason: 'empty candidate list' };
  return first;
}
