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
 *   4. the provider's own default (`claude`, its `defaultModel`, `medium`).
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
  DEFAULT_EFFORT,
  type Effort,
  type HomeConfig,
  type RepoEntry,
  validateEffort,
} from '@agile-agents/shared';

/** The vendor default when nothing names one (CLAUDE.md v0 default: "Claude for every role"). */
export const DEFAULT_VENDOR = 'claude';

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

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

export function resolveSessionSettings(
  input: ResolveSessionSettingsInput = {},
): ResolvedSessionSettings {
  const { flags = {}, repo, home } = input;

  const vendor = firstDefined(flags.vendor, repo?.vendor, home?.default_vendor) ?? DEFAULT_VENDOR;
  if (!isAcpProviderId(vendor)) {
    throw new UnknownVendorError(vendor, ['claude', 'gemini', 'cursor', 'grok', 'pi', 'codex']);
  }
  const provider = resolveAcpProvider(vendor);

  const model =
    firstDefined(flags.model, repo?.model, home?.default_model) ?? provider.defaultModel;

  // The flag is a raw string off the command line; the two config records
  // are schema-checked already. Validating here keeps the error the
  // operator sees about *effort*, not about a config file they didn't edit.
  const effortRaw = firstDefined(flags.effort, repo?.effort, home?.default_effort);
  const effort = effortRaw === undefined ? DEFAULT_EFFORT : validateEffort(effortRaw);

  return { vendor, model, effort, provider };
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
