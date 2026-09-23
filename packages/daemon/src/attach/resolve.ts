/**
 * Attach-time resolution of `vendor` / `model` / `effort` (PLAN.md **D12**,
 * ticket T130).
 *
 * One order, applied field by field and nothing else:
 *
 *   1. the `agile attach` flag, when given;
 *   2. the stream's repo entry in `repos.yaml` (`vendor` / `model` /
 *      `effort`);
 *   3. the state home's `config.yaml` (`default_vendor` / `default_model` /
 *      `default_effort`);
 *   4. the built-in default (**D17**): `claude` / `claude-opus-5-5` / `low`
 *      (`BUILTIN_SESSION_DEFAULTS` in shared — the model only for Claude);
 *   5. the provider's own `defaultModel`, for a non-Claude vendor with no
 *      model named anywhere.
 *
 * Pure: no store, no filesystem, no clock — the caller hands it the two
 * config records it already has. That is what makes "why did this session
 * get sonnet at high effort?" answerable by one unit test rather than by
 * reading the daemon.
 */

import {
  type AcpProviderConfig,
  isAcpProviderId,
  resolveAcpProvider,
} from '@agile-agents/acp-client';
import {
  BUILTIN_SESSION_DEFAULTS,
  type Effort,
  type HomeConfig,
  type RepoEntry,
  SESSION_VENDORS,
  resolveSessionDefaults,
} from '@agile-agents/shared';

/** The vendor default when nothing names one (D17). */
export const DEFAULT_VENDOR = BUILTIN_SESSION_DEFAULTS.vendor;

/** A vendor name that is not a registry entry — typed so the RPC edge reports -32602, not an internal error. */
export class UnknownVendorError extends Error {
  constructor(
    public readonly vendor: string,
    known: readonly string[],
  ) {
    super(`unknown vendor: ${vendor} (known: ${known.join(', ')})`);
    this.name = 'UnknownVendorError';
  }
}

export interface AttachFlags {
  vendor?: string;
  model?: string;
  effort?: string;
}

export interface ResolveSessionSettingsInput {
  /** What `agile attach` was given. */
  flags?: AttachFlags;
  /** The stream's repo entry, when the stream has a repo. */
  repo?: RepoEntry;
  /** `<home>/config.yaml`. */
  home?: HomeConfig;
}

export interface ResolvedSessionSettings {
  vendor: string;
  model: string;
  effort: Effort;
  provider: AcpProviderConfig;
}

export function resolveSessionSettings(
  input: ResolveSessionSettingsInput = {},
): ResolvedSessionSettings {
  const { vendor, model, effort } = resolveSessionDefaults(input);
  if (!isAcpProviderId(vendor)) throw new UnknownVendorError(vendor, SESSION_VENDORS);
  const provider = resolveAcpProvider(vendor);
  return { vendor, model: model ?? provider.defaultModel, effort, provider };
}

/** What an effort level contributes to the spawn for this provider, or `undefined` when the vendor has no mapping at all. */
export function effortContribution(
  provider: AcpProviderConfig,
  effort: Effort,
): { env?: Record<string, string>; args?: string[] } | undefined {
  return provider.effort?.(effort);
}

/** The thread line the daemon writes when a vendor cannot honour the requested effort (D12). */
export function effortIgnoredLine(vendor: string, effort: Effort): string {
  return `effort ${effort} ignored by ${vendor}`;
}
