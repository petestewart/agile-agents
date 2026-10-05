/**
 * T489 (**D58**): the vendor self-check. The daemon measures, per vendor and
 * CLI version, what routing depends on and only a real login can show: does
 * the vendor take a model set through ACP, does it take an effort level, what
 * usage does it report for a turn, does `session/load` resume a session, and
 * what does it say about rate limits or plan usage (for T491).
 *
 * One check is one probe session with no node and no repo; its result is one
 * file beside that session's `session-state.json`
 * (`<home>/sessions/<id>/self-check.json`, `VENDOR_CHECK_FILE`), validated by
 * `VendorCheckResultSchema`. No new home dir: the session dirs are the
 * record, and the daemon rebuilds the latest result per vendor from them at
 * start (`packages/daemon/src/runner/vendor-check.ts`).
 *
 * The automatic trigger (after a CLI update, or a CLI version with no check
 * yet) is the home switch `vendor_checks: auto | manual` (absent = auto).
 */

import { z } from 'zod';
import type { VendorInstallView } from './bridges';
import { type SessionVendor, SessionVendorSchema } from './session-defaults';

/** The result file, in the probe session's own dir. */
export const VENDOR_CHECK_FILE = 'self-check.json';

/** The one prompt a check sends. */
export const VENDOR_CHECK_PROMPT = 'Reply with the single word OK.';

export const VENDOR_CHECK_MODES = ['auto', 'manual'] as const;
export const VendorCheckModeSchema = z.enum(VENDOR_CHECK_MODES);
export type VendorCheckMode = z.infer<typeof VendorCheckModeSchema>;
/** Absent from the home config = `auto`. */
export const DEFAULT_VENDOR_CHECK_MODE: VendorCheckMode = 'auto';

/** Why a check ran. */
export const VENDOR_CHECK_REASONS = ['manual', 'update', 'new_version'] as const;
export const VendorCheckReasonSchema = z.enum(VENDOR_CHECK_REASONS);
export type VendorCheckReason = z.infer<typeof VendorCheckReasonSchema>;

/**
 * How a setting went:
 *  - `honoured`: the reply read back the value that was set;
 *  - `kept`: the reply read back the value it had (or another), not the one set;
 *  - `refused`: the call failed (the error is in `detail`);
 *  - `unclear`: the reply named no value to read back;
 *  - `not_applicable`: nothing to set (no list, no option, no other value);
 *  - `skipped`: the check stopped before this step (not logged in, didn't open).
 */
export const VENDOR_CHECK_SETTING_OUTCOMES = [
  'honoured',
  'kept',
  'refused',
  'unclear',
  'not_applicable',
  'skipped',
] as const;
export const VendorCheckSettingOutcomeSchema = z.enum(VENDOR_CHECK_SETTING_OUTCOMES);
export type VendorCheckSettingOutcome = z.infer<typeof VendorCheckSettingOutcomeSchema>;

const words = z.string().min(1).max(500);
const value = z.string().min(1).max(200);

export const VendorCheckSettingSchema = z
  .object({
    outcome: VendorCheckSettingOutcomeSchema,
    /** What it ran before. */
    from: value.optional(),
    /** What the check set. */
    to: value.optional(),
    /** What the reply read back. */
    after: value.optional(),
    /** In words: what happened, or why nothing was set. */
    detail: words.optional(),
  })
  .strict();
export type VendorCheckSetting = z.infer<typeof VendorCheckSettingSchema>;

export const VENDOR_CHECK_PROMPT_OUTCOMES = ['finished', 'failed', 'timed_out', 'skipped'] as const;
export const VendorCheckPromptOutcomeSchema = z.enum(VENDOR_CHECK_PROMPT_OUTCOMES);
export type VendorCheckPromptOutcome = z.infer<typeof VendorCheckPromptOutcomeSchema>;

export const VendorCheckPromptSchema = z
  .object({
    outcome: VendorCheckPromptOutcomeSchema,
    stop_reason: z.string().min(1).max(64).optional(),
    /** How long the turn took. */
    took_ms: z.number().int().min(0).optional(),
    /** What it replied, cut short. */
    reply: z.string().max(200).optional(),
    detail: words.optional(),
  })
  .strict();
export type VendorCheckPrompt = z.infer<typeof VendorCheckPromptSchema>;

/** A field name as the vendor sent it (a dotted path for a nested one). */
const fieldName = z.string().min(1).max(120);
/** At most this many field names per list. */
export const VENDOR_CHECK_FIELDS_MAX = 40;

export const VendorCheckUsageSchema = z
  .object({
    /** The `usage_update` fields that arrived (`used`, `size`, `cost`…), `sessionUpdate` left out. */
    update_fields: z.array(fieldName).max(VENDOR_CHECK_FIELDS_MAX),
    /** The prompt reply's keys (`stopReason`, `usage`, `_meta`…). */
    reply_keys: z.array(fieldName).max(VENDOR_CHECK_FIELDS_MAX),
    /** The reply `usage`'s fields (`inputTokens`, `outputTokens`…). */
    reply_usage_fields: z.array(fieldName).max(VENDOR_CHECK_FIELDS_MAX),
    /** A `cost` the vendor sent, as it sent it (JSON, cut short). */
    cost: z.string().min(1).max(200).optional(),
    /** Whether the turn's own token counts arrived (not only the context window's fill). */
    turn_tokens: z.boolean(),
    /** Whether the context window's fill arrived (`usage_update`'s `used`/`size`). */
    context: z.boolean(),
  })
  .strict();
export type VendorCheckUsage = z.infer<typeof VendorCheckUsageSchema>;

/** At most this many rate-limit fields are kept. */
export const VENDOR_CHECK_RATE_LIMITS_MAX = 20;

/** A field that looks like a rate limit or plan usage, as the vendor sent it. */
export const VendorCheckRateLimitSchema = z
  .object({
    /** Where it came from: `usage_update`, `turn_end` (the reply's `usage`/`_meta`) or `session` (the `session/new` reply). */
    where: z.enum(['usage_update', 'turn_end', 'session']),
    name: fieldName,
    /** Its value, as JSON, cut short. */
    value: z.string().max(200),
  })
  .strict();
export type VendorCheckRateLimit = z.infer<typeof VendorCheckRateLimitSchema>;

export const VENDOR_CHECK_RESUME_OUTCOMES = ['ok', 'failed', 'not_supported', 'skipped'] as const;
export const VendorCheckResumeOutcomeSchema = z.enum(VENDOR_CHECK_RESUME_OUTCOMES);
export type VendorCheckResumeOutcome = z.infer<typeof VendorCheckResumeOutcomeSchema>;

export const VendorCheckResumeSchema = z
  .object({
    outcome: VendorCheckResumeOutcomeSchema,
    detail: words.optional(),
  })
  .strict();
export type VendorCheckResume = z.infer<typeof VendorCheckResumeSchema>;

export const VendorCheckResultSchema = z
  .object({
    vendor: SessionVendorSchema,
    /** The vendor's name in words (`Cursor`). */
    label: z.string().min(1).max(64),
    /** The probe session: its dir holds this file, `session-state.json`, `usage.jsonl`, `stderr.log`. */
    session: z.string().min(1).max(64),
    /** The vendor CLI's version, when the daemon knew it (T481). */
    cli_version: z.string().min(1).max(64).optional(),
    /** The ACP bridge the daemon pins, for Claude and Codex. */
    bridge: z
      .object({ package: z.string().min(1).max(200), version: z.string().min(1).max(64) })
      .strict()
      .optional(),
    started_at: z.string().min(1).max(64),
    finished_at: z.string().min(1).max(64),
    reason: VendorCheckReasonSchema,
    by: z.enum(['human', 'daemon']),
    /** False when the vendor asked for a login: the check stopped there. */
    logged_in: z.boolean(),
    /** Whether a session opened at all. */
    opened: z.boolean(),
    model: VendorCheckSettingSchema,
    effort: VendorCheckSettingSchema,
    prompt: VendorCheckPromptSchema,
    usage: VendorCheckUsageSchema.optional(),
    rate_limits: z.array(VendorCheckRateLimitSchema).max(VENDOR_CHECK_RATE_LIMITS_MAX),
    resume: VendorCheckResumeSchema,
    /** What went wrong, in words. */
    errors: z.array(words).max(10),
  })
  .strict();
export type VendorCheckResult = z.infer<typeof VendorCheckResultSchema>;

/** `POST /api/settings/vendor-checks/run` and `vendors.check`: every installed vendor, or one. */
export const VendorCheckRunInputSchema = z
  .object({ vendor: SessionVendorSchema.optional() })
  .strict();
export type VendorCheckRunInput = z.infer<typeof VendorCheckRunInputSchema>;

/** `POST /api/settings/vendor-checks`: the automatic trigger's switch. */
export const VendorCheckModeInputSchema = z.object({ mode: VendorCheckModeSchema }).strict();
export type VendorCheckModeInput = z.infer<typeof VendorCheckModeInputSchema>;

/** One vendor's row in Settings → Agents → Vendors and `agile vendors`. */
export interface VendorCheckRow {
  vendor: SessionVendor;
  label: string;
  /** Its command is on the daemon's PATH. */
  installed: boolean;
  /**
   * T494: why it can't start, in words, when a command it needs isn't on
   * the PATH: its own, or (T501) one its bridge spawns. Pi needs `npx` for
   * its `pi-acp` bridge and its own `pi` CLI, so `pi` can be installed
   * while the bridge can't run.
   */
  missing?: string;
  /** The CLI version the daemon knows now (T481's last check), if any. */
  cli_version?: string;
  running: boolean;
  queued: boolean;
  /** Its latest result, if it was ever checked. */
  last?: VendorCheckResult;
  /** T500: a server the daemon downloads (Antigravity's): what Install fetches, and the install. */
  install?: VendorInstallView;
}

export interface VendorChecksStatus {
  mode: VendorCheckMode;
  vendors: VendorCheckRow[];
  /** Whether any check runs or waits. */
  running: boolean;
}

/** A setting's outcome as a mark: ✓ took, ✗ didn't, — nothing to measure. */
export function settingMark(outcome: VendorCheckSettingOutcome): '✓' | '✗' | '—' {
  if (outcome === 'honoured') return '✓';
  if (outcome === 'kept' || outcome === 'refused' || outcome === 'unclear') return '✗';
  return '—';
}

/** Resume as a mark. */
export function resumeMark(outcome: VendorCheckResumeOutcome): '✓' | '✗' | '—' {
  if (outcome === 'ok') return '✓';
  if (outcome === 'failed') return '✗';
  return '—';
}

/** The usage fields in one short line: "used, size · reply: inputTokens, outputTokens", or "none". */
export function usageWords(usage: VendorCheckUsage | undefined): string {
  if (usage === undefined) return 'none';
  const parts: string[] = [];
  if (usage.update_fields.length > 0) parts.push(`updates: ${usage.update_fields.join(', ')}`);
  if (usage.reply_usage_fields.length > 0)
    parts.push(`reply: ${usage.reply_usage_fields.join(', ')}`);
  if (usage.cost !== undefined) parts.push(`cost ${usage.cost}`);
  return parts.length > 0 ? parts.join(' · ') : 'none';
}
