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
 * T024 round 2 review-fix (opus B3): "once `setManualCooldown` also emits
 * it" was aspirational in round 1 -- the write went straight to
 * `store.putQuota` with no event at all, so `HandoffCoordinator.tick()`
 * (which reacts only to `quota_low`/`quota_exhausted` *events*, not to
 * `Quota` records directly) never saw a manual cooldown on an in-flight
 * ticket until its next real usage/reported reading happened to cross a
 * threshold -- i.e. never, for an account nobody is actively burning right
 * now. `setManualCooldown` now appends the same `quota_exhausted` event
 * `QuotaService.emitQuotaEvent` writes (`{vendor, account, remaining}` in
 * `data` -- the exact shape `coordinator.ts`'s `drainQuotaEvents` reads) and,
 * when a `bus` is given, the matching urgent bus message -- `quota_exhausted`
 * rather than `quota_low` because a human asking to free an account *now*
 * has the same "no time to wait for compliance" urgency a real 429 does
 * (design doc's hard-handoff path), not the graceful one.
 *
 * T024 round 2 review-fix (opus B4): `cooldown_backoff_seconds` is no
 * longer left `undefined` -- carried over from `existing` (if any) so a
 * later `record429` arriving mid-manual-cooldown has a real tier to
 * escalate from rather than restarting the ladder at its 30s floor (moot
 * either way now that `record429`/`recordReported` in `quota/records.ts`
 * never shorten or clear an already-future `cooldown_until` -- this is
 * belt-and-suspenders, not the load-bearing fix; that fix lives in
 * `records.ts` itself, see its own doc comments).
 *
 * DESIGN-GAP: unlike a 429 (`record429`), a manual cooldown has no
 * `retryAfterSeconds` from a vendor response -- the caller (a human, via the
 * verb/RPC) names the `until` timestamp directly instead of a duration fed
 * through the backoff ladder. `pre_cooldown_remaining` is still populated
 * the same way `record429` populates it (captured once per episode) so
 * `QuotaService`'s own cooldown-recovery step (`applyCooldownRecovery`)
 * restores the account correctly once the manual window elapses -- a manual
 * cooldown is not exempt from that recovery path.
 */

import { type Message, ulid, validateQuota } from '@agile-agents/shared';
import { BACKOFF_LADDER_SECONDS, quotaFraction } from '../quota/records';
import type { StateStore } from '../store';
import { buildEvent } from '../store/events';
import { NotFoundError } from '../store/store';

/** The ladder's own ceiling tier (`quota/records.ts`'s `BACKOFF_LADDER_SECONDS`, `[30, 60, 300, 900]`) — round 3 review-fix (N-d): a fresh manual cooldown is a human-chosen, typically-multi-hour span with no ladder tier of its own; recording the *ceiling* rather than leaving `cooldown_backoff_seconds` `undefined` means a 429 landing mid-manual-cooldown that somehow *did* need to fall back on the tier (`quota/records.ts`'s own `keepExistingCooldown` guard already makes this belt-and-suspenders, not load-bearing — see that file's doc comments) starts from the top of the ladder, not its 30s floor. */
const MANUAL_COOLDOWN_BACKOFF_SECONDS = BACKOFF_LADDER_SECONDS[BACKOFF_LADDER_SECONDS.length - 1];

/** Minimal seam a real `Bus.send` already satisfies — same shape `quota/records.ts`'s own `QuotaBusSender` uses, so a caller doesn't need to construct a full `Bus` (or its exact `SendResult` shape) just to hand one in here or in a test. */
export interface CooldownBusSender {
  send(input: unknown): Promise<{ ok: boolean; reason?: string }>;
}

export interface SetCooldownOptions {
  vendor: string;
  account: string;
  /** ISO timestamp -- the account is excluded from routing until this instant. */
  until: string;
  now?: () => Date;
  /** Optional -- when given, also sends the urgent `quota_exhausted` bus message `QuotaService.emitQuotaEvent` sends, so `em`'s inbox reflects it too (not what `HandoffCoordinator` itself reacts to -- that's the event, always written below). */
  bus?: CooldownBusSender;
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

  // Round 3 review-fix (N-c): an already-active cooldown means this call is
  // *extending* one, not starting a fresh episode — same "sameEpisode"
  // reasoning `quota/records.ts`'s `record429` already applies to its own
  // `quota_exhausted` emission, reused here so a repeated/extending
  // `setManualCooldown` call doesn't file a duplicate event every time.
  const wasAlreadyCoolingDown =
    existing?.cooldown_until != null && Date.parse(existing.cooldown_until) > now.getTime();

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
    pre_cooldown_remaining: wasAlreadyCoolingDown
      ? existing?.pre_cooldown_remaining
      : (existing?.remaining ?? existing?.limit),
    limit: existing?.limit,
    // Round 2 (opus B4) / round 3 (N-d): carried over when extending an
    // active cooldown; a *fresh* manual cooldown gets the ladder's own
    // ceiling tier rather than `undefined` — see this file's header.
    cooldown_backoff_seconds: wasAlreadyCoolingDown
      ? existing?.cooldown_backoff_seconds
      : MANUAL_COOLDOWN_BACKOFF_SECONDS,
    billing: existing?.billing,
    spend_usd: existing?.spend_usd,
  });

  const saved = await store.putQuota(updated);

  // Round 2 (opus B3): the event `HandoffCoordinator.tick()`'s
  // `drainQuotaEvents` actually reads — without this, a manual cooldown on
  // an account with no in-flight ticket burning usage right now never
  // reaches the coordinator at all. `quota_exhausted`, not `quota_low`: a
  // human explicitly asking to free an account now has no graceful
  // window to wait out (§10's hard-handoff path), the same urgency a real
  // 429 carries. Round 3 (N-c): skipped when merely extending an
  // already-active cooldown — the coordinator already reacted to this
  // account once; there is nothing new to signal, and `startHardImmediately`
  // would just re-run its (harmless but pointless) pass over a ticket that
  // already moved on.
  if (!wasAlreadyCoolingDown) {
    const windowTokensFallback = accountWindowTokens(store, opts.vendor, opts.account);
    await store.appendEvent(
      buildEvent('quota_exhausted', {
        data: {
          vendor: opts.vendor,
          account: opts.account,
          remaining: quotaFraction(saved, windowTokensFallback),
        },
      }),
    );
    if (opts.bus) {
      const message: Message = {
        id: ulid(now.getTime()),
        ts: now.toISOString(),
        from: 'daemon',
        to: ['em'],
        kind: 'quota_exhausted',
        priority: 'urgent',
        body: `${opts.vendor}/${opts.account} manually cooled down until ${opts.until}`,
        refs: [],
        requires_ack: false,
      };
      await opts.bus.send(message);
    }
  }

  return saved;
}

/** Same fallback `QuotaService.list`/`routing.ts` already use — an account's configured `quota.window_tokens`, or `undefined` when there's no `vendors.yaml` entry (or none at all) to read it from. */
function accountWindowTokens(
  store: StateStore,
  vendor: string,
  account: string,
): number | undefined {
  try {
    return store.getVendors()[vendor]?.accounts.find((a) => a.id === account)?.quota?.window_tokens;
  } catch {
    return undefined;
  }
}
