/**
 * Manual `cooldown_until` per account (T024; design/agile-agents-design.md
 * §10 "Quota-driven pause and handoff": "Manual: `cooldown_until` on an
 * account (\"keep my Max window free for 4h\") triggers the same
 * handoffs."; §4 "Quota" `cooldown_until`).
 *
 * Reuses the *same* `Quota.cooldown_until` field `QuotaService.record429`
 * already writes (`packages/shared/src/vendors.ts` — no schema change
 * needed, see the pipeline report) rather than a separate config-level
 * override: `routeCandidates` (`quota/routing.ts`) already excludes any
 * account with a future `cooldown_until` regardless of *why* it's set, so a
 * human-requested cooldown "triggers the same handoffs" for free — a
 * manually-cooling-down account's in-flight ticket sees the same
 * `quota_exhausted`-shaped signal `record429` produces, once
 * `setManualCooldown` also emits it (see below).
 *
 * DESIGN-GAP: unlike a 429 (`record429`), a manual cooldown has no
 * `retryAfterSeconds` from a vendor response — the caller (a human, via the
 * verb/RPC) names the `until` timestamp directly instead of a duration fed
 * through the backoff ladder. `cooldown_backoff_seconds`/
 * `pre_cooldown_remaining` are still populated the same way `record429`
 * populates them (captured once per episode) so `QuotaService`'s own
 * cooldown-recovery step (`applyCooldownRecovery`) restores the account
 * correctly once the manual window elapses — a manual cooldown is not
 * exempt from that recovery path.
 */

import { validateQuota } from '@agile-agents/shared';
import type { StateStore } from '../store';
import { NotFoundError } from '../store/store';

export interface SetCooldownOptions {
  vendor: string;
  account: string;
  /** ISO timestamp — the account is excluded from routing until this instant. */
  until: string;
  now?: () => Date;
}

export class CooldownError extends Error {}

/**
 * Writes (or extends) `cooldown_until` on the named account's `Quota`
 * record directly via `store.putQuota` — deliberately *not* routed through
 * `QuotaService.record429` (that method's `source: 'rate_limit_429'` and
 * backoff-ladder escalation are specific to an actual vendor rate limit;
 * this is a distinct, human-initiated reading). No record yet for this
 * account synthesizes a minimal `subscription_window`/`estimated` one first
 * (mirrors `QuotaService`'s own `defaultQuota`) rather than requiring a
 * prior reading to exist before a human can ask for quiet hours.
 */
export async function setManualCooldown(
  store: StateStore,
  opts: SetCooldownOptions,
): Promise<ReturnType<typeof validateQuota>> {
  if (Number.isNaN(Date.parse(opts.until))) {
    throw new CooldownError(
      `setManualCooldown: "until" is not a valid ISO timestamp: ${opts.until}`,
    );
  }
  const now = opts.now?.() ?? new Date();

  let existing: ReturnType<StateStore['getQuota']> | undefined;
  try {
    existing = store.getQuota(opts.vendor, opts.account);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    existing = undefined;
  }

  const updated = validateQuota({
    vendor: opts.vendor,
    account: opts.account,
    kind: existing?.kind ?? 'subscription_window',
    remaining: 0,
    unit: existing?.unit ?? 'tokens',
    resets_at: existing?.resets_at ?? null,
    confidence: existing?.confidence ?? 'estimated',
    source: existing?.source ?? 'ledger_countdown',
    updated: now.toISOString(),
    cooldown_until: opts.until,
    // First manual cooldown this episode captures whatever was there before
    // (so recovery has something real to restore); a manual cooldown that
    // only *extends* an already-active one keeps the original capture.
    pre_cooldown_remaining:
      existing?.cooldown_until != null && Date.parse(existing.cooldown_until) > now.getTime()
        ? existing.pre_cooldown_remaining
        : (existing?.remaining ?? existing?.limit),
    limit: existing?.limit,
    billing: existing?.billing,
    spend_usd: existing?.spend_usd,
  });

  return store.putQuota(updated);
}
