/**
 * `QuotaService` — per-`(vendor, account)` quota records (T023; design
 * agile-agents-design.md §4 "Quota (per vendor account)", §10 "Quota-driven
 * pause and handoff" (the record/cooldown/bus-event half this ticket owns —
 * handoff itself is T024), §11 "Pointing rubric and routing calibration"
 * (barometer data feeding the retro scoreboard and §17's feed barometer)).
 *
 * Two feeds merge into one `Quota` record per account (§4): real readings
 * when a vendor exposes them (`recordReported`, `source: usage_endpoint` /
 * `stream_event`), and the daemon's own ledger countdown corrected by them
 * (`recordUsage`, `source: ledger_countdown`). A 429 (`record429`) is itself
 * a reading — remaining 0 until reset — and always sets `cooldown_until`.
 *
 * Ownership boundary: this module never writes anywhere but `Quota` records
 * (via `store.putQuota`) and the `quota_low`/`quota_exhausted` bus
 * messages/events those writes can trigger. It never touches
 * `runner/session.ts`, `store/store.ts`, or `bus/bus.ts` — those are read
 * through their existing public surface only (constructor injection), per
 * this ticket's file-ownership boundary. `runner/session.ts` is expected to
 * call `recordUsage`/`record429` at its `usage_update`/vendor-error call
 * sites; see the pipeline report for the exact wiring lines.
 *
 * Independent-review fix round (units, window reset, 429 escalation): every
 * record this service writes now carries a concrete `unit` (`tokens` |
 * `requests` | `usd` — never a bare ambiguous "fraction"), keeps
 * `remaining`/`limit` commensurable in that unit across successive writes,
 * re-arms a countdown when `resets_at` has elapsed, and escalates a 429's
 * `cooldown_until` through a ladder within one cooldown episode rather than
 * re-emitting `quota_exhausted` on every call. See each method's doc
 * comment for the specific bug it fixes and the reproduction test in
 * `records.test.ts`.
 */

import type {
  AccountQuotaConfig,
  Event,
  LedgerLine,
  Quota,
  QuotaConfidence,
  QuotaKind,
  QuotaUnit,
  VendorsConfig,
} from '@agile-agents/shared';
import { ulid, validateQuota } from '@agile-agents/shared';
import { buildEvent } from '../store/events';
import { NotFoundError, type StateStore } from '../store/store';

/** CLAUDE.md tunable: "quota floor 0.15". */
export const DEFAULT_QUOTA_FLOOR = 0.15;

/**
 * DESIGN-GAP: §4's countdown feed needs a token-budget denominator
 * ("tokens → fraction of the window limit from vendors.yaml") and an
 * account with no `quota.window_tokens` configured (every account today,
 * pre-T023 `vendors.yaml`) still needs *some* countdown behaviour rather
 * than none at all. One million tokens is a v0 placeholder magnitude (a
 * Claude subscription context/turn budget order of magnitude), correctable
 * per-account via `VendorAccount.quota.window_tokens` with zero code
 * changes once real numbers are known. This is distinct from `quotaFraction`'s
 * own "neither limit nor account config known" fallback (which returns `1`,
 * never a guessed magnitude) — this constant only ever backs a *countdown*
 * record, which therefore always has some limit, guessed or configured.
 */
export const DEFAULT_WINDOW_TOKENS = 1_000_000;

/**
 * Round-3 review-fix DESIGN-GAP: "always set `resets_at` from the vendor
 * window (default a `window_hours` when the vendor entry lacks it)". No
 * cadence tunable exists in CLAUDE.md or the design for this either. A day
 * is a v0 placeholder (a subscription window is at least this granular in
 * every vendor spike-findings entry), correctable per-account via
 * `VendorAccount.quota.window_hours` with zero code changes.
 */
export const DEFAULT_WINDOW_HOURS = 24;

/** Review-fix: "escalate cooldown (e.g. retry-after or 30 s → 1 m → 5 m → 15 m cap)". */
export const BACKOFF_LADDER_SECONDS = [30, 60, 300, 900] as const;

/** Minimal seam `Bus.send` already satisfies — avoids importing the concrete `Bus` class into a module that must not edit it. */
export interface QuotaBusSender {
  send(input: unknown): Promise<{ ok: boolean; reason?: string }>;
}

export interface QuotaServiceOptions {
  store: StateStore;
  /** Optional — omit in tests that don't care about the `quota_low`/`quota_exhausted` bus events. */
  bus?: QuotaBusSender;
  now?: () => Date;
  /** Default floor for accounts with no `VendorAccount.quota.floor` override. */
  floor?: number;
}

export interface ReportedReading {
  /**
   * Absolute remaining in `unit` when `unit` is given; otherwise (review
   * fix) a bare `0..1` fraction of whatever limit can be resolved (this
   * reading's own `limit`, else the account's `vendors.yaml`
   * `quota.window_tokens`, else the existing record's own token-unit
   * limit) — resolved immediately into a concrete `tokens` reading so the
   * stored record never carries an ambiguous unit. "Reported updates
   * replace the baseline": the resolved absolute value *replaces*
   * whatever the countdown currently thinks, and the next `recordUsage`
   * decrements from it directly.
   */
  remaining: number;
  unit?: QuotaUnit;
  /** This reading's own denominator, same unit as `remaining`/`unit`. */
  limit?: number;
  resets_at?: string | null;
  kind?: QuotaKind;
}

/**
 * `remaining / limit` when `limit` is known (the record's own denominator —
 * review fix: "must use the record's limit, drop nothing"); else
 * `remaining / windowTokensFallback` when a fallback denominator is given
 * and the record is unit `tokens`; else `1` — an unresolvable fraction
 * must never read as "exhausted" (review fix: "when neither exists ...
 * never emit exhausted").
 */
export function quotaFraction(
  quota: Pick<Quota, 'remaining' | 'limit' | 'unit'>,
  windowTokensFallback?: number,
): number {
  if (quota.limit !== undefined && quota.limit > 0) {
    return Math.max(0, Math.min(1, quota.remaining / quota.limit));
  }
  if (windowTokensFallback !== undefined && windowTokensFallback > 0 && quota.unit === 'tokens') {
    return Math.max(0, Math.min(1, quota.remaining / windowTokensFallback));
  }
  return 1;
}

const BACKOFF_FIRST_SECONDS: number = BACKOFF_LADDER_SECONDS[0];
const BACKOFF_CAP_SECONDS: number =
  BACKOFF_LADDER_SECONDS[BACKOFF_LADDER_SECONDS.length - 1] ?? BACKOFF_FIRST_SECONDS;

function nextBackoffSeconds(currentSeconds: number | undefined): number {
  if (currentSeconds === undefined) return BACKOFF_FIRST_SECONDS;
  const index = BACKOFF_LADDER_SECONDS.indexOf(
    currentSeconds as (typeof BACKOFF_LADDER_SECONDS)[number],
  );
  if (index === -1 || index === BACKOFF_LADDER_SECONDS.length - 1) {
    return BACKOFF_CAP_SECONDS;
  }
  return BACKOFF_LADDER_SECONDS[index + 1] ?? BACKOFF_CAP_SECONDS;
}

export interface BarometerStats {
  vendor: string;
  account: string;
  /** Token throughput over the trailing `windowHours` window (default 1h). */
  tokens_per_hour: number;
  /** Count of `hook_decision` events with `decision: 'deny'` for this vendor's registered agents, in the same window. */
  denials: number;
  /** Count of `quota_exhausted` events logged for this `(vendor, account)`, in the same window. */
  rate_limit_429_count: number;
  window_hours: number;
}

export class QuotaService {
  private readonly store: StateStore;
  private readonly bus?: QuotaBusSender;
  private readonly now: () => Date;
  private readonly defaultFloor: number;

  constructor(opts: QuotaServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    this.defaultFloor = opts.floor ?? DEFAULT_QUOTA_FLOOR;
  }

  /** `getQuota`, but `undefined` instead of throwing when no record exists yet. */
  private tryGetQuota(vendor: string, account: string): Quota | undefined {
    try {
      return this.store.getQuota(vendor, account);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  private accountConfig(vendor: string, account: string): AccountQuotaConfig | undefined {
    try {
      const vendors = this.store.getVendors();
      return vendors[vendor]?.accounts.find((a) => a.id === account)?.quota;
    } catch {
      return undefined;
    }
  }

  private accountFloor(accountConfig: AccountQuotaConfig | undefined): number {
    return accountConfig?.floor ?? this.defaultFloor;
  }

  /**
   * Review-fix (#4, window reset): "when `now >= resets_at`, re-arm
   * (`remaining = limit`, `resets_at += window`, clear `quota_low` emitted
   * flag)". There is no separate "emitted" flag to clear — the existing
   * once-per-crossing logic (`afterQuotaWrite`'s `previousFraction`
   * comparison) already re-arms itself once `remaining` is reset to
   * `limit` here, since the *next* write's `previousFraction` reflects the
   * rearmed (full) state, not the stale below-floor one.
   *
   * Round-3 review-fix: `resets_at` is now always advanced by a concrete
   * cadence (the account's configured `window_hours`, else
   * `DEFAULT_WINDOW_HOURS`) rather than ever clearing to `null` — a record
   * with no cadence configured used to rearm once and then never again,
   * which (opus round 2) also left `record429`/`recordUsage` with no
   * window-reset backstop to fall back on when a cooldown-only recovery
   * (`applyCooldownRecovery`, below) didn't apply.
   *
   * Round-4 review-fix (opus round 3, blocker 3): advancing by exactly one
   * window left `resets_at` in the past after any idle gap longer than one
   * window (e.g. a `window_hours: 1` account idle for 5h) — every
   * subsequent write would then see `now >= resets_at` again and re-arm
   * `remaining` to `limit` before decrementing, on every single call,
   * silently discarding whatever usage that call itself just recorded.
   * Now advances by however many whole windows have elapsed (`ceil`,
   * clamped to at least one), landing `resets_at` on the first boundary
   * strictly after `now` — one rearm catches the account fully up
   * regardless of how long it sat idle, exactly once.
   *
   * Returns `existing` unchanged when no reset is due (no `resets_at`, or
   * it hasn't arrived yet).
   */
  private applyWindowReset(
    existing: Quota | undefined,
    accountConfig: AccountQuotaConfig | undefined,
  ): Quota | undefined {
    if (existing?.resets_at == null) return existing;
    const resetsAtMs = Date.parse(existing.resets_at);
    const nowMs = this.now().getTime();
    if (Number.isNaN(resetsAtMs) || nowMs < resetsAtMs) return existing;

    const windowHours = accountConfig?.window_hours ?? DEFAULT_WINDOW_HOURS;
    const windowMs = windowHours * 60 * 60 * 1000;
    const windowsElapsed = Math.max(1, Math.ceil((nowMs - resetsAtMs) / windowMs));
    let nextResetsAtMs = resetsAtMs + windowsElapsed * windowMs;
    // `ceil` can land exactly on `now` when the gap is a whole number of
    // windows — "the first boundary *after* now" must be strictly after it.
    if (nextResetsAtMs <= nowMs) nextResetsAtMs += windowMs;
    const nextResetsAt = new Date(nextResetsAtMs).toISOString();

    return {
      ...existing,
      remaining: existing.limit ?? existing.remaining,
      cooldown_until: null,
      cooldown_backoff_seconds: undefined,
      pre_cooldown_remaining: undefined,
      resets_at: nextResetsAt,
    };
  }

  /** Round-3 review-fix: every countdown record gets a real cadence, defaulting to `DEFAULT_WINDOW_HOURS` — never `null` — so `applyWindowReset` always has a `resets_at` to eventually act on, even for an account with no `quota.window_hours` configured. */
  private initialResetsAt(accountConfig: AccountQuotaConfig | undefined): string {
    const windowHours = accountConfig?.window_hours ?? DEFAULT_WINDOW_HOURS;
    return new Date(this.now().getTime() + windowHours * 60 * 60 * 1000).toISOString();
  }

  /**
   * Round-3 review-fix (opus round 2 finding): a 429 zeroes `remaining`
   * for the duration of its cooldown (§4: "remaining 0 until reset"), but
   * once the *cooldown itself* elapses that zero is stale, not a fresh
   * reading — the account's pre-429 budget is still (presumptively) there.
   * `routeCandidates` already treats a stale post-cooldown zero as "lazily"
   * available for routing *decisions* (see `routing.ts`), but the first
   * `recordUsage`/`recordReported` call after re-admission was still
   * decrementing from that stale 0 and re-persisting an even-more-final 0
   * with `cooldown_until: null` — at that point routing's own lazy rescue
   * no longer applies (there is no `cooldown_until` left to treat as
   * stale), permanently shedding an account that was never actually out of
   * budget.
   *
   * Restores `remaining` to whatever it was captured as just before the
   * 429 (`pre_cooldown_remaining`), clamped to the current `limit` (in
   * case the configured window shrank in the meantime) — "keep the
   * pre-cooldown remaining" per §4's `remaining` semantics being a live
   * account balance, not something a *rate limit* (as opposed to a window
   * rollover) has any authority to permanently reduce. A window reset that
   * has *also* elapsed by the time this runs (checked by `applyWindowReset`
   * immediately afterward, in `resolveExisting`) takes precedence and
   * rearms to the full `limit` instead, per §4's actual reset semantics.
   *
   * Returns `existing` unchanged when there is no cooldown, or it hasn't
   * elapsed yet.
   */
  private applyCooldownRecovery(
    existing: Quota | undefined,
    accountConfig: AccountQuotaConfig | undefined,
  ): Quota | undefined {
    if (existing?.cooldown_until == null) return existing;
    if (Date.parse(existing.cooldown_until) > this.now().getTime()) return existing;

    const limit = accountConfig?.window_tokens ?? existing.limit ?? DEFAULT_WINDOW_TOKENS;
    const restored = existing.pre_cooldown_remaining ?? limit;

    return {
      ...existing,
      remaining: Math.max(0, Math.min(restored, limit)),
      limit,
      cooldown_until: null,
      cooldown_backoff_seconds: undefined,
      pre_cooldown_remaining: undefined,
    };
  }

  /** Loads the current record (if any) and applies both recovery steps, in order: cooldown recovery first (restores the pre-429 remaining), then window reset (which — if *also* due — overrides that restored value with a full rearm to `limit`, taking precedence per §4). Every call site (`recordUsage`/`recordReported`/`record429`) goes through this instead of `tryGetQuota` directly, so a stale cooldown or an elapsed window is never read as this call's actual starting state. */
  private resolveExisting(
    vendor: string,
    account: string,
    accountConfig: AccountQuotaConfig | undefined,
  ): Quota | undefined {
    const raw = this.tryGetQuota(vendor, account);
    const cooldownRecovered = this.applyCooldownRecovery(raw, accountConfig);
    return this.applyWindowReset(cooldownRecovered, accountConfig);
  }

  /**
   * §4 countdown feed: `ledgerLine`'s token delta decrements the account's
   * remaining-tokens budget. Emits `quota_low`/`quota_exhausted` (bus +
   * event) exactly once per crossing — i.e. only on the transition from
   * "above floor" to "at/below floor" (or to zero) — never on every
   * subsequent decrement while already below it. A window reset (§4/review
   * fix #4) or a `recordReported` reading that brings the fraction back
   * above the floor re-arms the crossing.
   *
   * Review-fix "reset after a successful call": a successful usage record
   * clears any `cooldown_until`/escalation tier left over from a prior 429
   * — this call succeeding is itself evidence the account is usable again,
   * the same "lazily on read" reasoning `routeCandidates` (routing.ts)
   * applies independently for a stale cooldown it hasn't yet had a
   * `recordUsage` call to clear.
   */
  async recordUsage(vendor: string, account: string, ledgerLine: LedgerLine): Promise<Quota> {
    const accountConfig = this.accountConfig(vendor, account);
    const existing = this.resolveExisting(vendor, account, accountConfig);
    const previousFraction = existing ? quotaFraction(existing, accountConfig?.window_tokens) : 1;

    const windowTokens =
      accountConfig?.window_tokens ??
      (existing?.unit === 'tokens' ? existing.limit : undefined) ??
      DEFAULT_WINDOW_TOKENS;

    // Review-fix (#2): the baseline is only ever the existing record's own
    // `remaining` when it is *already* in the same `tokens` unit this
    // method works in — never inferred from a fraction (that inference is
    // exactly what let a `recordReported` value in a different unit get
    // silently misread as a raw token count). Any other existing unit (or
    // no existing record) starts a fresh full-window baseline.
    //
    // Round-4 review-fix (opus round 3, blocker 2): `existing.limit ===
    // undefined` is exactly `recordReported`'s "nothing to resolve a bare
    // fraction against" case (`confidence: 'low'`) — `existing.remaining`
    // there is the unresolved 0..1 fraction itself (e.g. `0.8`), not a
    // token count, even though `existing.unit === 'tokens'`. Trusting it
    // as a baseline is what let an 80%-full account get declared exhausted
    // by a single token. A record with no `limit` has nothing commensurable
    // to decrement from, so it gets the same fresh full-window baseline as
    // a non-token-unit record, exactly like `quotaFraction` already treats
    // a limit-less record as unresolvable rather than reading `remaining`
    // as gospel.
    const baselineTokens =
      existing?.unit === 'tokens' && existing.limit !== undefined
        ? existing.remaining
        : windowTokens;

    const used = ledgerLine.in_tokens + ledgerLine.out_tokens;
    const remainingTokens = Math.max(0, baselineTokens - used);

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: existing?.kind ?? 'subscription_window',
      remaining: remainingTokens,
      unit: 'tokens',
      resets_at: existing?.resets_at ?? this.initialResetsAt(accountConfig),
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: this.now().toISOString(),
      cooldown_until: null,
      cooldown_backoff_seconds: undefined,
      limit: windowTokens,
      billing: existing?.billing,
      spend_usd: existing?.spend_usd,
    });

    await this.store.putQuota(updated);
    await this.afterQuotaWrite(
      vendor,
      account,
      previousFraction,
      updated,
      accountConfig?.window_tokens,
    );
    return updated;
  }

  /**
   * §4 "reported" feed: a real vendor reading (stream event / usage
   * endpoint) overrides the countdown estimate outright, regardless of
   * what the countdown currently thinks — "reported updates replace the
   * baseline" (review fix #2). A bare `0..1` fraction reading (no `unit`
   * given) is resolved into a concrete `tokens` reading immediately
   * (against this reading's own `limit`, else the account's configured
   * `window_tokens`, else the existing record's own token-unit limit) so
   * the stored record's `unit`/`remaining`/`limit` are always mutually
   * consistent — never inherited from whatever unit the *previous* record
   * happened to be in, which was the review-flagged bug: a reported 0.8
   * (80% full) got stored with an inherited `unit: 'tokens'`, so the very
   * next countdown decrement read "0.8" as "0.8 tokens left" and tripped a
   * spurious `quota_exhausted` (see `records.test.ts`'s
   * `'reproduces and fixes the reviewed unit-inheritance bug'`).
   *
   * Also the write path for Pi-on-Claude's extra-usage dollar accrual
   * (§4/§11: "Pi-on-Claude billed as extra-usage dollars") via
   * `spendDeltaUsd`.
   */
  async recordReported(
    vendor: string,
    account: string,
    reading: ReportedReading,
    opts: { spendDeltaUsd?: number } = {},
  ): Promise<Quota> {
    const accountConfig = this.accountConfig(vendor, account);
    const existing = this.resolveExisting(vendor, account, accountConfig);
    const previousFraction = existing ? quotaFraction(existing, accountConfig?.window_tokens) : 1;

    let remaining: number;
    let unit: QuotaUnit;
    let limit: number | undefined;
    let confidence: QuotaConfidence;

    if (reading.unit !== undefined) {
      unit = reading.unit;
      remaining = reading.remaining;
      limit = reading.limit ?? (unit === 'tokens' ? accountConfig?.window_tokens : undefined);
      confidence = 'reported';
    } else {
      const resolvedLimit =
        reading.limit ??
        accountConfig?.window_tokens ??
        (existing?.unit === 'tokens' ? existing.limit : undefined);
      if (resolvedLimit !== undefined) {
        unit = 'tokens';
        limit = resolvedLimit;
        remaining = Math.round(reading.remaining * resolvedLimit);
        confidence = 'reported';
      } else {
        // Nothing to resolve the bare fraction against — store it as a
        // last resort with `limit` left unset and `confidence: 'low'`, so
        // `quotaFraction` (no limit, no fallback given) always reads it as
        // `1` regardless of this stored number (review fix #3).
        unit = 'tokens';
        limit = undefined;
        remaining = reading.remaining;
        confidence = 'low';
      }
    }

    const spend_usd =
      opts.spendDeltaUsd !== undefined
        ? (existing?.spend_usd ?? 0) + opts.spendDeltaUsd
        : existing?.spend_usd;

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: reading.kind ?? existing?.kind ?? 'subscription_window',
      remaining,
      unit,
      limit,
      // An explicit `null` from the reading (the vendor genuinely reports
      // no window) is respected as-is; `undefined` (not given at all)
      // falls back to whatever's already known, then a fresh default
      // cadence — same "always set resets_at" round-3 fix as `recordUsage`.
      resets_at:
        reading.resets_at !== undefined
          ? reading.resets_at
          : (existing?.resets_at ?? this.initialResetsAt(accountConfig)),
      confidence,
      source: 'usage_endpoint',
      updated: this.now().toISOString(),
      cooldown_until: null,
      cooldown_backoff_seconds: undefined,
      billing: opts.spendDeltaUsd !== undefined ? 'extra_usage_dollars' : existing?.billing,
      spend_usd,
    });

    await this.store.putQuota(updated);
    await this.afterQuotaWrite(
      vendor,
      account,
      previousFraction,
      updated,
      accountConfig?.window_tokens,
    );
    return updated;
  }

  /**
   * §4/§10: "A 429 is a reading: remaining 0 until reset". Review-fix #5:
   * emits `quota_exhausted` once per *cooldown episode* — a repeated 429
   * while the previous `cooldown_until` is still in the future escalates
   * the same episode's backoff (an explicit `retryAfterSeconds` always
   * wins; otherwise the ladder 30s → 1m → 5m → 15m cap) without a second
   * event/bus send. A 429 arriving after the prior cooldown has already
   * elapsed (or none was ever set) starts a fresh episode at the ladder's
   * first tier and emits.
   */
  async record429(vendor: string, account: string, retryAfterSeconds?: number): Promise<Quota> {
    const accountConfig = this.accountConfig(vendor, account);
    // `resolveExisting` recovers any *prior* episode's stale cooldown/window
    // first, so `existing` here reflects the account's true state right
    // before *this* 429 — the correct value to capture as
    // `pre_cooldown_remaining` below when this is a fresh episode.
    const existing = this.resolveExisting(vendor, account, accountConfig);
    const nowMs = this.now().getTime();
    const sameEpisode =
      existing?.cooldown_until != null && Date.parse(existing.cooldown_until) > nowMs;

    const backoffSeconds =
      retryAfterSeconds ??
      nextBackoffSeconds(sameEpisode ? existing?.cooldown_backoff_seconds : undefined);
    const cooldownUntil = new Date(nowMs + backoffSeconds * 1000).toISOString();

    const windowTokens = accountConfig?.window_tokens ?? existing?.limit ?? DEFAULT_WINDOW_TOKENS;

    // Round-3 review-fix: capture the pre-429 `remaining` once, on this
    // episode's first 429 — never re-captured while merely escalating the
    // same episode's backoff, since `remaining` is already 0 by then and
    // would clobber the real value this is meant to restore later.
    const preCooldownRemaining = sameEpisode
      ? existing?.pre_cooldown_remaining
      : (existing?.remaining ?? windowTokens);

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: existing?.kind ?? 'subscription_window',
      remaining: 0,
      unit: existing?.unit ?? 'tokens',
      resets_at: existing?.resets_at ?? this.initialResetsAt(accountConfig),
      confidence: 'reported',
      source: 'rate_limit_429',
      updated: new Date(nowMs).toISOString(),
      cooldown_until: cooldownUntil,
      cooldown_backoff_seconds: backoffSeconds,
      pre_cooldown_remaining: preCooldownRemaining,
      limit: existing?.unit === 'tokens' || existing === undefined ? windowTokens : existing.limit,
      billing: existing?.billing,
      spend_usd: existing?.spend_usd,
    });

    await this.store.putQuota(updated);
    if (!sameEpisode) {
      await this.emitQuotaEvent(
        'quota_exhausted',
        vendor,
        account,
        updated,
        accountConfig?.window_tokens,
      );
    }
    return updated;
  }

  /** Shared crossing-detection + event/bus emission for `recordUsage`/`recordReported`. */
  private async afterQuotaWrite(
    vendor: string,
    account: string,
    previousFraction: number,
    updated: Quota,
    windowTokensFallback: number | undefined,
  ): Promise<void> {
    const floor = this.accountFloor(this.accountConfig(vendor, account));
    const newFraction = quotaFraction(updated, windowTokensFallback);
    const isCoolingDown =
      updated.cooldown_until !== null && Date.parse(updated.cooldown_until) > this.now().getTime();

    if (newFraction <= 0 || isCoolingDown) {
      if (previousFraction > 0 && !isCoolingDown) {
        await this.emitQuotaEvent(
          'quota_exhausted',
          vendor,
          account,
          updated,
          windowTokensFallback,
        );
      }
      return;
    }
    if (newFraction <= floor && previousFraction > floor) {
      await this.emitQuotaEvent('quota_low', vendor, account, updated, windowTokensFallback);
    }
  }

  private async emitQuotaEvent(
    kind: 'quota_low' | 'quota_exhausted',
    vendor: string,
    account: string,
    quota: Quota,
    windowTokensFallback: number | undefined,
  ): Promise<Event> {
    const event = await this.store.appendEvent(
      buildEvent(kind, {
        data: { vendor, account, remaining: quotaFraction(quota, windowTokensFallback) },
      }),
    );
    if (this.bus) {
      const now = this.now();
      await this.bus.send({
        id: ulid(now.getTime()),
        ts: now.toISOString(),
        from: 'daemon',
        to: ['em'],
        kind,
        priority: kind === 'quota_exhausted' ? 'urgent' : 'normal',
        body: `${vendor}/${account} ${kind === 'quota_exhausted' ? 'exhausted' : 'low'} (remaining ${(quotaFraction(quota, windowTokensFallback) * 100).toFixed(0)}%)`,
        requires_ack: false,
      });
    }
    return event;
  }

  /**
   * Every account named in `vendors.yaml`, its `Quota` record if one
   * exists (else a synthesized full/untouched default — never persisted).
   * Enriches a record that has no `limit` of its own with the account's
   * configured `window_tokens` as an effective display-only limit (never
   * persisted), so a caller with no `vendors.yaml` of its own (the feed
   * snapshot, `agile status`) can call `quotaFraction(quota)` — 1-arg —
   * and still get an accurate fraction.
   *
   * Round-4 review-fix (opus round 3, blocker 1): reads now run through
   * the same `resolveExisting` (cooldown recovery, then window reset) that
   * `recordUsage`/`recordReported`/`record429` apply on write — computed
   * fresh here, **never persisted** (a read must never itself mutate
   * state; the next real write persists whatever recovery implies). Before
   * this fix, recovery only ever ran on write, so an account the
   * countdown alone exhausted (no 429 involved) had nothing left to write
   * to it once routing excluded it — the window could roll over
   * indefinitely and `list()`/`routeCandidates` would keep reading the
   * pre-rollover exhausted record forever, since nothing was ever calling
   * `recordUsage` again to trigger the rearm. `routeCandidates` (`routing.
   * ts`) independently also treats a stale `resets_at` the same way for
   * hand-built `Quota` records that never go through this method.
   */
  list(): Quota[] {
    let vendors: VendorsConfig;
    try {
      vendors = this.store.getVendors();
    } catch {
      return [];
    }
    const quotas: Quota[] = [];
    for (const [vendor, config] of Object.entries(vendors)) {
      for (const account of config.accounts) {
        const existing = this.resolveExisting(vendor, account.id, account.quota);
        const record =
          existing ??
          this.defaultQuota(
            vendor,
            account.id,
            account.quota?.window_tokens ?? DEFAULT_WINDOW_TOKENS,
          );
        const effectiveLimit =
          record.limit ?? (record.unit === 'tokens' ? account.quota?.window_tokens : undefined);
        quotas.push(
          effectiveLimit !== undefined && record.limit === undefined
            ? { ...record, limit: effectiveLimit }
            : record,
        );
      }
    }
    return quotas;
  }

  private defaultQuota(vendor: string, account: string, windowTokens: number): Quota {
    return validateQuota({
      vendor,
      account,
      kind: 'subscription_window',
      remaining: windowTokens,
      unit: 'tokens',
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: this.now().toISOString(),
      cooldown_until: null,
      limit: windowTokens,
    });
  }

  /**
   * §11 "barometer": rolling stats for the feed/retro scoreboard. Ledger
   * lines carry no `vendor`/`account` field (§4's `LedgerLine` schema), so
   * agent registrations (`AgentRecord.vendor`) are the join key — a
   * best-effort attribution (DESIGN-GAP: `AgentRecord` has no `account`
   * field either, so this attributes by vendor only, not per-account, when
   * more than one account of the same vendor is in play).
   */
  barometer(vendor: string, account: string, opts: { windowHours?: number } = {}): BarometerStats {
    const windowHours = opts.windowHours ?? 1;
    const now = this.now();
    const windowStartMs = now.getTime() - windowHours * 60 * 60 * 1000;

    const agentIds = new Set(
      this.store
        .listAgents()
        .filter((a) => a.record.vendor === vendor)
        .map((a) => a.id),
    );

    const sprintIds = new Set<string>(this.store.listSprints().map((s) => s.id));
    sprintIds.add('nosprint');
    let tokens = 0;
    for (const sprintId of sprintIds) {
      let lines: LedgerLine[];
      try {
        lines = this.store.listLedger(sprintId);
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!agentIds.has(line.agent)) continue;
        if (Date.parse(line.ts) < windowStartMs) continue;
        tokens += line.in_tokens + line.out_tokens;
      }
    }

    const events = this.store.listEvents().filter((e) => Date.parse(e.ts) >= windowStartMs);
    const denials = events.filter(
      (e) =>
        e.kind === 'hook_decision' && agentIds.has(e.agent ?? '') && e.data.decision === 'deny',
    ).length;
    const rateLimit429Count = events.filter(
      (e) => e.kind === 'quota_exhausted' && e.data.vendor === vendor && e.data.account === account,
    ).length;

    return {
      vendor,
      account,
      tokens_per_hour: tokens / windowHours,
      denials,
      rate_limit_429_count: rateLimit429Count,
      window_hours: windowHours,
    };
  }
}
