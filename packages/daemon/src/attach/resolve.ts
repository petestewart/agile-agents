/**
 * Attach-time `vendor`/`model`/`effort` (D12, D17), field by field: the
 * attach flag, the node's project (P5), the repo entry, the home `config.yaml`, the built-in default
 * (`claude` / `claude-opus-5-5` / `low`), then a non-Claude provider's own
 * `defaultModel`. Pure, so "why did this session get that model?" is one
 * unit test.
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
  type ResolveSessionDefaultsInput,
  SESSION_VENDORS,
  resolveSessionDefaults,
} from '@agile-agents/shared';

/** The vendor default when nothing names one (D17). */
export const DEFAULT_VENDOR = BUILTIN_SESSION_DEFAULTS.vendor;

/** A vendor that is not a registry entry (-32602 at the edge). */
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
  /** P5: the node's project `session`, when the node has a project. */
  project?: ResolveSessionDefaultsInput['project'];
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

/** An effort level's spawn contribution for this provider; `undefined` when unmapped. */
export function effortContribution(
  provider: AcpProviderConfig,
  effort: Effort,
): { env?: Record<string, string>; args?: string[] } | undefined {
  return provider.effort?.(effort);
}

/** The thread line when a vendor can't honour the requested effort (D12). */
export function effortIgnoredLine(vendor: string, effort: Effort): string {
  return `effort ${effort} ignored by ${vendor}`;
}
