/**
 * Vendors/accounts config (design/agile-agents-design.md §8 "Adapter
 * contract (ACP)" → "Auth" for `.agile/vendors.yaml`).
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
    // T026 (design §6 "Enforcement tiers": "a vendor with ungated exec
    // (Codex, Grok) is an engineer only inside a tier-0 sandbox") — set
    // `true` for vendors whose ACP/native bridge cannot be made to gate
    // exec at tier 1/2 (spike-findings.md §D: Codex and Grok both prompt
    // for nothing). Routing must refuse to spawn such a vendor as an
    // engineer when `sandbox.detectBackend()` reports `none` rather than
    // running it unsandboxed — see `packages/daemon/src/sandbox`.
    // Additive + defaulted so every existing `vendors.yaml` (Claude,
    // Cursor, Gemini — none of which need it) keeps validating unchanged.
    requires_sandbox: z.boolean().default(false),
    // T026 round 3 (review round 2 nit — "`enabled` must be a schema'd
    // config field ... not ad-hoc"): the explicit opt-in that
    // `sandbox.wrapAgentCommand`'s `enabled` input and
    // `runner/session.ts`'s `AgentSessionOptions.sandboxEnabled` both
    // exist to receive — turns tier-0 wrapping on for a vendor that
    // doesn't `requires_sandbox`, without a backend's mere presence being
    // enough on its own (design §6, review round 1 B2). Not yet read by
    // any caller — `runner.ts` (outside this ticket's file ownership)
    // needs to thread `VendorConfig.sandbox_enabled` through the same path
    // `requires_sandbox` takes; see the pipeline report's wiring section.
    sandbox_enabled: z.boolean().default(false),
  })
  .strict();
export type VendorConfig = z.infer<typeof VendorConfigSchema>;

/** `.agile/vendors.yaml` — one entry per vendor name (claude, openai, cursor, gemini, ...). */
export const VendorsConfigSchema = z.record(z.string().min(1), VendorConfigSchema);
export type VendorsConfig = z.infer<typeof VendorsConfigSchema>;
/** Pre-validation shape: the defaulted fields (`requires_sandbox`, `sandbox_enabled`) are optional on input. */
export type VendorsConfigInput = z.input<typeof VendorsConfigSchema>;

export function validateVendorsConfig(input: unknown): VendorsConfig {
  const result = VendorsConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('VendorsConfig', result.error));
  }
  return result.data;
}
