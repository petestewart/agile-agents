/**
 * T170 (PLAN.md **D17**): the session defaults — what a session gets when
 * `agile attach` / the cockpit's picker names nothing.
 *
 * D12's order, field by field, with D17's built-in step:
 *
 *   1. the flag (or the cockpit picker's value);
 *   2. the node's project (`projects/<id>.yaml` `session`, P5);
 *   3. the stream's repo entry in `repos.yaml`;
 *   4. the home's `config.yaml` (`default_vendor|model|effort`);
 *   5. the built-in default — `claude` / `claude-opus-5-5` / `low`;
 *   6. the provider's own default model (only reached for a non-Claude
 *      vendor with no model named anywhere: the built-in model is a Claude id).
 *
 * Pure and here rather than in the daemon so the CLI's `daemon status` and
 * the cockpit resolve exactly as attach does.
 */

import { z } from 'zod';
import { type Effort, EffortSchema, validateEffort } from './effort';
import type { HomeConfig } from './home-config';
import type { RepoEntry } from './repos';

/** Every vendor the provider registry knows (`@agile-agents/acp-client`'s `ACP_PROVIDERS`). */
export const SESSION_VENDORS = ['claude', 'gemini', 'cursor', 'grok', 'pi', 'codex'] as const;
export const SessionVendorSchema = z.enum(SESSION_VENDORS);
export type SessionVendor = z.infer<typeof SessionVendorSchema>;

/**
 * T401 (D12): the vendors whose adapter maps an effort level to something
 * (`ACP_PROVIDERS[v].effort`; a daemon test keeps the two in step). For any
 * other the level is recorded but never sent ("effort … ignored by …"), so
 * the cockpit leaves it out of labels.
 */
export const EFFORT_VENDORS: readonly SessionVendor[] = ['claude'];

/** T401: whether `vendor` does anything with an effort level. */
export function vendorTakesEffort(vendor: string): boolean {
  return (EFFORT_VENDORS as readonly string[]).includes(vendor);
}

/** D17's step 4. */
export const BUILTIN_SESSION_DEFAULTS = {
  vendor: 'claude',
  model: 'claude-opus-5-5',
  effort: 'low',
} as const satisfies { vendor: SessionVendor; model: string; effort: Effort };

/** Suggestions for the free-text model field (Settings, the attach picker). Not a closed list. */
export const KNOWN_MODEL_IDS: Readonly<Record<SessionVendor, readonly string[]>> = {
  claude: [
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'opus',
    'sonnet',
    'haiku',
  ],
  gemini: [],
  cursor: [],
  grok: [],
  pi: [],
  codex: [],
};

export const SESSION_MODEL_MAX_CHARS = 200;

/**
 * A Settings write: absent = unchanged, `null` = remove (fall through to
 * the next step of the order), a value = set.
 */
export const SessionDefaultsPatchSchema = z
  .object({
    vendor: SessionVendorSchema.nullable().optional(),
    model: z.string().trim().min(1).max(SESSION_MODEL_MAX_CHARS).nullable().optional(),
    effort: EffortSchema.nullable().optional(),
  })
  .strict();
export type SessionDefaultsPatch = z.infer<typeof SessionDefaultsPatchSchema>;

/** What a record (home or repo) says itself, before resolution. */
export interface SessionDefaultsFields {
  vendor?: string;
  model?: string;
  effort?: Effort;
}

export interface ResolvedSessionDefaults {
  vendor: string;
  /** `undefined` only for a non-Claude vendor with no model named: the provider's own default. */
  model?: string;
  effort: Effort;
}

export interface ResolveSessionDefaultsInput {
  flags?: { vendor?: string; model?: string; effort?: string };
  /** P5: the project step, between the flag and the repo. */
  project?: { vendor?: string; model?: string; effort?: Effort };
  repo?: Pick<RepoEntry, 'vendor' | 'model' | 'effort'>;
  home?: Pick<HomeConfig, 'default_vendor' | 'default_model' | 'default_effort'>;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

export function resolveSessionDefaults(
  input: ResolveSessionDefaultsInput = {},
): ResolvedSessionDefaults {
  const { flags = {}, project, repo, home } = input;
  const vendor =
    firstDefined(flags.vendor, project?.vendor, repo?.vendor, home?.default_vendor) ??
    BUILTIN_SESSION_DEFAULTS.vendor;
  const named = firstDefined(flags.model, project?.model, repo?.model, home?.default_model);
  const model =
    named ??
    (vendor === BUILTIN_SESSION_DEFAULTS.vendor ? BUILTIN_SESSION_DEFAULTS.model : undefined);
  // The flag is a raw string; the records are schema-checked already.
  const effortRaw = firstDefined(flags.effort, project?.effort, repo?.effort, home?.default_effort);
  const effort =
    effortRaw === undefined ? BUILTIN_SESSION_DEFAULTS.effort : validateEffort(effortRaw);
  return { vendor, ...(model !== undefined ? { model } : {}), effort };
}

/** `claude/claude-opus-5-5 · low` — never a bare "default". */
export function formatSessionDefaults(resolved: ResolvedSessionDefaults): string {
  const model = resolved.model ?? `${resolved.vendor}'s own default model`;
  return `${resolved.vendor}/${model} · ${resolved.effort}`;
}

/** `GET /api/settings/session`: every step of the order, and what it resolves to. */
export interface SessionDefaultsStatus {
  builtin: ResolvedSessionDefaults;
  home: SessionDefaultsFields;
  /** Home + built-in: what a stream with no repo (or a repo naming nothing) gets. */
  resolved: ResolvedSessionDefaults;
  repos: Record<string, SessionDefaultsFields & { resolved: ResolvedSessionDefaults }>;
  vendors: readonly SessionVendor[];
  known_models: Readonly<Record<SessionVendor, readonly string[]>>;
}
