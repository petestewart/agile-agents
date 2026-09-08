/**
 * Vendors/accounts config and Quota records
 * (design/agile-agents-design.md §8 "Adapter contract (ACP)" → "Auth" for
 * `.agile/vendors.yaml`; §4 "Quota" for the per-account quota record).
 */

import { z } from 'zod';
import { formatZodError } from './ids';

export const AccountAuthSchema = z.enum(['subscription', 'api_key']);
export type AccountAuth = z.infer<typeof AccountAuthSchema>;

export const VendorAccountSchema = z
  .object({
    id: z.string().min(1),
    auth: AccountAuthSchema,
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

export const QUOTA_CONFIDENCE_LEVELS = ['reported', 'estimated'] as const;
export const QuotaConfidenceSchema = z.enum(QUOTA_CONFIDENCE_LEVELS);
export type QuotaConfidence = z.infer<typeof QuotaConfidenceSchema>;

export const QUOTA_SOURCES = [
  'stream_event',
  'usage_endpoint',
  'ledger_countdown',
  'rate_limit_429',
] as const;
export const QuotaSourceSchema = z.enum(QUOTA_SOURCES);
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

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
