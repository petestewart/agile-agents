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
   * Returns `existing` unchanged when no reset is due (no `resets_at`, or
   * it hasn't arrived yet).
   */
  private applyWindowReset(
    existing: Quota | undefined,
    accountConfig: AccountQuotaConfig | undefined,
  ): Quota | undefined {
    if (existing?.resets_at == null) return existing;
    const resetsAtMs = Date.parse(existing.resets_at);
    if (Number.isNaN(resetsAtMs) || this.now().getTime() < resetsAtMs) return existing;

    const windowHours = accountConfig?.window_hours;
    // DESIGN-GAP: with no configured cadence, this is a one-shot rearm —
    // `resets_at` clears to `null` and no further automatic rearm happens
    // until something (a reported reading, or vendors.yaml gaining
    // `window_hours`) sets a new one.
    const nextResetsAt =
      windowHours !== undefined
        ? new Date(resetsAtMs + windowHours * 60 * 60 * 1000).toISOString()
        : null;

    return {
      ...existing,
      remaining: existing.limit ?? existing.remaining,
      cooldown_until: null,
      cooldown_backoff_seconds: undefined,
      resets_at: nextResetsAt,
    };
  }

  private initialResetsAt(accountConfig: AccountQuotaConfig | undefined): string | null {
    if (accountConfig?.window_hours === undefined) return null;
    return new Date(
      this.now().getTime() + accountConfig.window_hours * 60 * 60 * 1000,
    ).toISOString();
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
    const existing = this.applyWindowReset(this.tryGetQuota(vendor, account), accountConfig);
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
    const baselineTokens = existing?.unit === 'tokens' ? existing.remaining : windowTokens;

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
    const existing = this.applyWindowReset(this.tryGetQuota(vendor, account), accountConfig);
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
      resets_at:
        reading.resets_at !== undefined ? reading.resets_at : (existing?.resets_at ?? null),
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
    const existing = this.applyWindowReset(this.tryGetQuota(vendor, account), accountConfig);
    const nowMs = this.now().getTime();
    const sameEpisode =
      existing?.cooldown_until != null && Date.parse(existing.cooldown_until) > nowMs;

    const backoffSeconds =
      retryAfterSeconds ??
      nextBackoffSeconds(sameEpisode ? existing?.cooldown_backoff_seconds : undefined);
    const cooldownUntil = new Date(nowMs + backoffSeconds * 1000).toISOString();

    const windowTokens = accountConfig?.window_tokens ?? existing?.limit ?? DEFAULT_WINDOW_TOKENS;

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: existing?.kind ?? 'subscription_window',
      remaining: 0,
      unit: existing?.unit ?? 'tokens',
      resets_at: existing?.resets_at ?? null,
      confidence: 'reported',
      source: 'rate_limit_429',
      updated: new Date(nowMs).toISOString(),
      cooldown_until: cooldownUntil,
      cooldown_backoff_seconds: backoffSeconds,
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
        const existing = this.tryGetQuota(vendor, account.id);
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
