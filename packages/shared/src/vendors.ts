/**
 * Vendors/accounts config and Quota records
 * (design/agile-agents-design.md §8 "Adapter contract (ACP)" → "Auth" for
 * `.agile/vendors.yaml`; §4 "Quota" for the per-account quota record).
 */

import { z } from 'zod';
import { formatZodError } from './ids';

export const AccountAuthSchema = z.enum(['subscription', 'api_key']);
export type AccountAuth = z.infer<typeof AccountAuthSchema>;

/**
 * T023 DESIGN-GAP: §11 "Pointing rubric and routing calibration" needs a
 * per-account token budget to turn a ledger token delta into the "fraction
 * of the window limit" §4 "Quota" names as the countdown feed
 * ("tokens → fraction of the window limit from vendors.yaml"), and no field
 * for this exists anywhere in `.agile/vendors.yaml`'s schema. Added as an
 * optional `quota` stanza on the account entry (never required — an
 * account with no configured limit simply has no countdown feed and relies
 * on reported readings only) rather than a new top-level file, since this
 * is config for an existing entity (the account), not a new artifact type.
 */
export const AccountQuotaConfigSchema = z
  .object({
    /** Token budget for one subscription window/period, the denominator for a ledger-countdown fraction. */
    window_tokens: z.number().positive().optional(),
    /** Per-account override of the CLAUDE.md quota-floor tunable (default 0.15). */
    floor: z.number().min(0).max(1).optional(),
    /**
     * T023 review-fix DESIGN-GAP: window-reset cadence in hours (e.g. `24`
     * for a daily window, `168` for weekly). No field for this exists
     * anywhere in the design either; without it a window's `resets_at`
     * can be rearmed once (cleared to `null`) but never re-scheduled for
     * the window after that. Optional — an account with no configured
     * cadence just doesn't get automatic multi-window rearming.
     */
    window_hours: z.number().positive().optional(),
  })
  .strict();
export type AccountQuotaConfig = z.infer<typeof AccountQuotaConfigSchema>;

export const VendorAccountSchema = z
  .object({
    id: z.string().min(1),
    auth: AccountAuthSchema,
    quota: AccountQuotaConfigSchema.optional(),
  })
  .strict();
export type VendorAccount = z.infer<typeof VendorAccountSchema>;

export const VendorConfigSchema = z
  .object({
    accounts: z.array(VendorAccountSchema).min(1),
  })
  .strict();
export type VendorConfig = z.infer<typeof VendorConfigSchema>;

/** `.agile/vendors.yaml` — one entry per vendor name (claude, openai, cursor, gemini, ...). */
export const VendorsConfigSchema = z.record(z.string().min(1), VendorConfigSchema);
export type VendorsConfig = z.infer<typeof VendorsConfigSchema>;

export function validateVendorsConfig(input: unknown): VendorsConfig {
  const result = VendorsConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('VendorsConfig', result.error));
  }
  return result.data;
}

/** §4 "Quota" — per vendor account. */
export const QUOTA_KINDS = ['subscription_window', 'prepaid_credits', 'pay_as_you_go'] as const;
export const QuotaKindSchema = z.enum(QUOTA_KINDS);
export type QuotaKind = z.infer<typeof QuotaKindSchema>;

/**
 * `low` (T023 review-fix addition): a countdown/reported value computed
 * with no known denominator at all (no record `limit`, no vendor account
 * `quota.window_tokens`) — the record still needs *some* `remaining`
 * number to satisfy the schema, but nothing downstream may treat it as
 * accurate enough to threshold against. `quotaFraction` (`daemon/src/
 * quota/records.ts`) always returns `1` (never trips `quota_low`/
 * `quota_exhausted`) whenever a record's fraction can't be resolved,
 * regardless of confidence — `low` exists so a human/UI reading the record
 * directly can tell "we don't actually know" apart from a confident
 * `estimated` countdown.
 */
export const QUOTA_CONFIDENCE_LEVELS = ['reported', 'estimated', 'low'] as const;
export const QuotaConfidenceSchema = z.enum(QUOTA_CONFIDENCE_LEVELS);
export type QuotaConfidence = z.infer<typeof QuotaConfidenceSchema>;

/**
 * T023 review-fix: "Model units explicitly per record" — every `Quota`
 * record `QuotaService` writes now uses one of these three concrete units
 * (never an ambiguous bare "fraction") so `remaining`/`limit` are always
 * commensurable within one record and across successive writes to the
 * same record. `QuotaSchema.unit` itself stays `z.string().min(1)`
 * (unchanged) rather than a `.enum()` — tightening it would break the
 * existing `__fixtures__/quota.yaml` fixture's literal `unit: fraction`
 * (verbatim from the design doc's own example) and is a `packages/shared`
 * schema decision beyond this fix's scope; this is the closed set
 * `daemon/src/quota/**`'s own code always writes going forward.
 */
export const QUOTA_UNITS = ['tokens', 'requests', 'usd'] as const;
export const QuotaUnitSchema = z.enum(QUOTA_UNITS);
export type QuotaUnit = z.infer<typeof QuotaUnitSchema>;

export const QUOTA_SOURCES = [
  'stream_event',
  'usage_endpoint',
  'ledger_countdown',
  'rate_limit_429',
] as const;
export const QuotaSourceSchema = z.enum(QUOTA_SOURCES);
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

/**
 * T023 DESIGN-GAP: two additive fields beyond the §4 yaml block.
 *
 * `limit` — the design's `remaining` is deliberately unit-agnostic
 * ("fraction, $ or tokens"). The ledger-countdown feed (§4: "the daemon's
 * own ledger counting down from a user-set cap") needs an absolute
 * denominator to turn a token delta into a fraction, so `limit` carries
 * that denominator in the same `unit` as `remaining` (e.g. both in raw
 * tokens for a countdown record) — optional because a `reported` record
 * sourced from a real usage endpoint/stream event has no local cap to
 * report.
 *
 * `billing`/`spend_usd` — §4/§11 name "Pi-on-Claude billed as extra-usage
 * dollars" as a quota concern with no schema given anywhere. `billing`
 * tags which model applies to this account (plain subscription-window
 * countdown, vs. a subscription that also accrues metered extra-usage
 * charges once the included window is spent); `spend_usd` is the running
 * accrued dollar total under that billing model. Both optional/default so
 * every non-Pi account (the overwhelming majority) never carries them.
 */
export const QUOTA_BILLING_MODES = ['subscription', 'extra_usage_dollars'] as const;
export const QuotaBillingSchema = z.enum(QUOTA_BILLING_MODES);
export type QuotaBilling = z.infer<typeof QuotaBillingSchema>;

export const QuotaSchema = z
  .object({
    vendor: z.string().min(1),
    account: z.string().min(1),
    kind: QuotaKindSchema,
    // "remaining: 0.22  # fraction, $ or tokens — whatever the vendor exposes"
    remaining: z.number(),
    unit: z.string().min(1),
    resets_at: z.string().min(1).nullable().optional(),
    confidence: QuotaConfidenceSchema,
    source: QuotaSourceSchema,
    updated: z.string().min(1),
    // "cooldown_until: null  # set on 429"
    cooldown_until: z.string().min(1).nullable().default(null),
    /** Absolute denominator backing `remaining` for a ledger-countdown record — same `unit`. */
    limit: z.number().positive().optional(),
    /** Billing model for this account — Pi-on-Claude style extra-usage charges vs. plain subscription. */
    billing: QuotaBillingSchema.optional(),
    /** Cumulative dollars accrued under `billing: extra_usage_dollars`. */
    spend_usd: z.number().min(0).optional(),
    /**
     * T023 review-fix DESIGN-GAP: current escalation tier for `record429`'s
     * backoff ladder (30s → 1m → 5m → 15m cap), so a repeated 429 within the
     * same cooldown episode can escalate from *this* tier rather than
     * re-deriving it from `cooldown_until - updated` (fragile once a vendor
     * `Retry-After` and our own ladder are mixed across calls). Cleared
     * (`undefined`) on the next successful `recordUsage`/`recordReported`
     * call — "a reset after a successful call".
     */
    cooldown_backoff_seconds: z.number().positive().optional(),
  })
  .strict();

export type Quota = z.infer<typeof QuotaSchema>;

export function validateQuota(input: unknown): Quota {
  const result = QuotaSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Quota', result.error));
  }
  return result.data;
}
