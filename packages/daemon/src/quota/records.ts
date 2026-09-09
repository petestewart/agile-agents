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
 */

import type { Event, LedgerLine, Quota, QuotaKind, VendorsConfig } from '@agile-agents/shared';
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
 * changes once real numbers are known.
 */
export const DEFAULT_WINDOW_TOKENS = 1_000_000;

/** CLAUDE.md doesn't tunable a 429 backoff explicitly; five minutes is the v0 default absent a vendor `Retry-After`. */
export const DEFAULT_429_BACKOFF_SECONDS = 300;

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
  /** Same unit as `unit` below — a real reading from the vendor, not a countdown estimate. */
  remaining: number;
  unit?: string;
  resets_at?: string | null;
  kind?: QuotaKind;
}

/** `remaining` normalized to a [0, 1] fraction of `limit` when present, else `remaining` itself (already a fraction — §4: "fraction, $ or tokens"). */
export function quotaFraction(quota: Pick<Quota, 'remaining' | 'limit'>): number {
  if (quota.limit !== undefined && quota.limit > 0) {
    return Math.max(0, Math.min(1, quota.remaining / quota.limit));
  }
  return quota.remaining;
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

  private accountFloor(vendor: string, account: string): number {
    try {
      const vendors = this.store.getVendors();
      const found = vendors[vendor]?.accounts.find((a) => a.id === account);
      return found?.quota?.floor ?? this.defaultFloor;
    } catch {
      return this.defaultFloor;
    }
  }

  private windowTokens(vendor: string, account: string, existing: Quota | undefined): number {
    try {
      const vendors = this.store.getVendors();
      const found = vendors[vendor]?.accounts.find((a) => a.id === account);
      if (found?.quota?.window_tokens !== undefined) return found.quota.window_tokens;
    } catch {
      // No vendors.yaml (or account not listed) — fall through to the record's own limit, then the default.
    }
    return existing?.limit ?? DEFAULT_WINDOW_TOKENS;
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
   * §4 countdown feed: `ledgerLine`'s token delta decrements the account's
   * remaining-tokens budget. Emits `quota_low`/`quota_exhausted` (bus +
   * event) exactly once per crossing — i.e. only on the transition from
   * "above floor" to "at/below floor" (or to zero) — never on every
   * subsequent decrement while already below it, which is what "once per
   * window" (§4) means absent an explicit reset signal. A later `reported`
   * reading (or the window's `resets_at` rolling over — T024's concern)
   * that brings the fraction back above the floor re-arms the crossing.
   */
  async recordUsage(vendor: string, account: string, ledgerLine: LedgerLine): Promise<Quota> {
    const existing = this.tryGetQuota(vendor, account);
    const windowTokens = this.windowTokens(vendor, account, existing);
    const previousFraction = existing ? quotaFraction(existing) : 1;

    // Baseline remaining tokens: reuse the existing record's own token
    // count when it's already tracked in tokens; otherwise (no record yet,
    // or the existing record is a `reported` fraction/dollar reading)
    // re-derive a token baseline from its fraction against this window.
    const baselineTokens =
      existing !== undefined && existing.unit === 'tokens'
        ? existing.remaining
        : windowTokens * previousFraction;

    const used = ledgerLine.in_tokens + ledgerLine.out_tokens;
    const remainingTokens = Math.max(0, baselineTokens - used);

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: existing?.kind ?? 'subscription_window',
      remaining: remainingTokens,
      unit: 'tokens',
      resets_at: existing?.resets_at ?? null,
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: this.now().toISOString(),
      cooldown_until: existing?.cooldown_until ?? null,
      limit: windowTokens,
      billing: existing?.billing,
      spend_usd: existing?.spend_usd,
    });

    await this.store.putQuota(updated);
    await this.afterQuotaWrite(vendor, account, previousFraction, updated);
    return updated;
  }

  /**
   * §4 "reported" feed: a real vendor reading (stream event / usage
   * endpoint) overrides the countdown estimate outright, regardless of
   * what the countdown currently thinks. Also the write path for
   * Pi-on-Claude's extra-usage dollar accrual (§4/§11: "Pi-on-Claude billed
   * as extra-usage dollars") via `spendDeltaUsd`.
   */
  async recordReported(
    vendor: string,
    account: string,
    reading: ReportedReading,
    opts: { spendDeltaUsd?: number } = {},
  ): Promise<Quota> {
    const existing = this.tryGetQuota(vendor, account);
    const previousFraction = existing ? quotaFraction(existing) : 1;

    const spend_usd =
      opts.spendDeltaUsd !== undefined
        ? (existing?.spend_usd ?? 0) + opts.spendDeltaUsd
        : existing?.spend_usd;

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: reading.kind ?? existing?.kind ?? 'subscription_window',
      remaining: reading.remaining,
      unit: reading.unit ?? existing?.unit ?? 'fraction',
      resets_at: reading.resets_at !== undefined ? reading.resets_at : (existing?.resets_at ?? null),
      confidence: 'reported',
      source: 'usage_endpoint',
      updated: this.now().toISOString(),
      cooldown_until: existing?.cooldown_until ?? null,
      // A reported reading is authoritative on its own terms — it carries
      // no local "limit" denominator of its own (§4's `remaining` is
      // already whatever fraction/unit the vendor reported).
      limit: undefined,
      billing: opts.spendDeltaUsd !== undefined ? 'extra_usage_dollars' : existing?.billing,
      spend_usd,
    });

    await this.store.putQuota(updated);
    await this.afterQuotaWrite(vendor, account, previousFraction, updated);
    return updated;
  }

  /**
   * §4/§10: "A 429 is a reading: remaining 0 until reset" — always sets
   * `cooldown_until` and always emits `quota_exhausted` (a 429 is a fresh,
   * discrete signal each time it happens, unlike the countdown's
   * once-per-crossing `quota_low`/`quota_exhausted`).
   */
  async record429(vendor: string, account: string, retryAfterSeconds?: number): Promise<Quota> {
    const existing = this.tryGetQuota(vendor, account);
    const windowTokens = this.windowTokens(vendor, account, existing);
    const cooldownUntil = new Date(
      this.now().getTime() + (retryAfterSeconds ?? DEFAULT_429_BACKOFF_SECONDS) * 1000,
    ).toISOString();

    const updated: Quota = validateQuota({
      vendor,
      account,
      kind: existing?.kind ?? 'subscription_window',
      remaining: 0,
      unit: existing?.unit ?? 'tokens',
      resets_at: existing?.resets_at ?? null,
      confidence: 'reported',
      source: 'rate_limit_429',
      updated: this.now().toISOString(),
      cooldown_until: cooldownUntil,
      limit: existing?.unit === 'tokens' || existing === undefined ? windowTokens : existing.limit,
      billing: existing?.billing,
      spend_usd: existing?.spend_usd,
    });

    await this.store.putQuota(updated);
    await this.emitQuotaEvent('quota_exhausted', vendor, account, updated);
    return updated;
  }

  /** Shared crossing-detection + event/bus emission for `recordUsage`/`recordReported`. */
  private async afterQuotaWrite(
    vendor: string,
    account: string,
    previousFraction: number,
    updated: Quota,
  ): Promise<void> {
    const floor = this.accountFloor(vendor, account);
    const newFraction = quotaFraction(updated);
    const isCoolingDown = updated.cooldown_until !== null && Date.parse(updated.cooldown_until) > this.now().getTime();

    if (newFraction <= 0 || isCoolingDown) {
      if (previousFraction > 0 && !isCoolingDown) {
        await this.emitQuotaEvent('quota_exhausted', vendor, account, updated);
      } else if (isCoolingDown) {
        // Cooldown is set elsewhere (record429 already emits its own
        // event) — nothing further to do here.
      }
      return;
    }
    if (newFraction <= floor && previousFraction > floor) {
      await this.emitQuotaEvent('quota_low', vendor, account, updated);
    }
  }

  private async emitQuotaEvent(
    kind: 'quota_low' | 'quota_exhausted',
    vendor: string,
    account: string,
    quota: Quota,
  ): Promise<Event> {
    const event = await this.store.appendEvent(
      buildEvent(kind, { data: { vendor, account, remaining: quotaFraction(quota) } }),
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
        body: `${vendor}/${account} ${kind === 'quota_exhausted' ? 'exhausted' : 'low'} (remaining ${(quotaFraction(quota) * 100).toFixed(0)}%)`,
        requires_ack: false,
      });
    }
    return event;
  }

  /** Every account named in `vendors.yaml`, its `Quota` record if one exists (else a synthesized full/untouched default — never persisted). */
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
        quotas.push(existing ?? this.defaultQuota(vendor, account.id, account.quota?.window_tokens ?? DEFAULT_WINDOW_TOKENS));
      }
    }
    return quotas;
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
      (e) => e.kind === 'hook_decision' && agentIds.has(e.agent ?? '') && e.data.decision === 'deny',
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
