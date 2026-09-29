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
    'claude-sonnet-5-5',
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
 * T467 (D46): one model a vendor reported for itself in its `session/new`
 * reply (its `configOptions` model option, else ACP's `models` list):
 * `value` is the id a session is set to, `name` what the picker shows.
 */
export const VendorModelSchema = z
  .object({
    value: z.string().min(1).max(SESSION_MODEL_MAX_CHARS),
    name: z.string().min(1).max(200),
    description: z.string().max(300).optional(),
  })
  .strict();
export type VendorModel = z.infer<typeof VendorModelSchema>;

/** T467: at most this many models are kept per vendor (Cursor reported 43). */
export const VENDOR_MODELS_MAX = 200;

/**
 * T467 (D46): a vendor's model list, as its most recent `session/new` (or
 * `session/load`) reply reported it. `current` is the model that session
 * ran on, which may be missing from `options` (Grok, LIVE-CHECKLIST §12).
 */
export const VendorModelsSchema = z
  .object({
    options: z.array(VendorModelSchema).max(VENDOR_MODELS_MAX),
    current: z.string().min(1).max(SESSION_MODEL_MAX_CHARS).optional(),
    /** When the vendor said it (the session-state file's `at`). */
    at: z.string().min(1).max(64),
    /** The session whose reply it was (a Refresh's too). */
    session: z.string().min(1).max(64).optional(),
  })
  .strict();
export type VendorModels = z.infer<typeof VendorModelsSchema>;

/** T467: `POST /api/settings/models/refresh`: ask one vendor for its models. */
export const RefreshModelsInputSchema = z.object({ vendor: SessionVendorSchema }).strict();
export type RefreshModelsInput = z.infer<typeof RefreshModelsInputSchema>;

/**
 * T456: vendors whose tool calls pass the daemon's pre-tool check (Claude's
 * `PreToolUse` hook, Pi's `agile` extension; design/spike-findings.md §B,
 * §C4). The others are gated by ACP permission (or a sandbox) only, a lower
 * enforcement floor (T229's visibility advisory reads the same list).
 */
export const HOOKED_VENDORS: readonly SessionVendor[] = ['claude', 'pi'];

/** T456: whether `vendor` has pre-tool hooks. */
export function vendorHasHooks(vendor: string): boolean {
  return (HOOKED_VENDORS as readonly string[]).includes(vendor);
}

/**
 * T460: how to log a vendor back in. Its harness runs headless over ACP,
 * so an interactive `/login` can't run in the cockpit; it runs in a
 * terminal, with the user's own login (no vendor credentials in the daemon).
 */
const VENDOR_LOGIN_HOW: Partial<Record<string, string>> = {
  claude: 'run `claude` and type /login',
  gemini: 'run `gemini` and sign in',
  codex: 'run `codex login`',
  cursor: 'run `cursor-agent login`',
};

/** T460: the way to log `vendor` in, in words ("run `claude` and type /login"). */
export function vendorLoginHow(vendor: string, label: string): string {
  return VENDOR_LOGIN_HOW[vendor] ?? `log in to ${label}`;
}

/**
 * T461: one slash command a live agent advertises over ACP
 * (`available_commands_update`): its name without the slash, what it does,
 * and the hint for its argument, if it takes one.
 */
export const AgentCommandSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w][\w:.-]*$/),
    description: z.string().max(300),
    hint: z.string().max(200).optional(),
  })
  .strict();
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

/** T461: the command a line starts with (`/compact now` → `compact`), or undefined. */
export function slashCommandOf(text: string): string | undefined {
  return /^\/([\w][\w:.-]*)(?:\s|$)/.exec(text.trimStart())?.[1];
}

/**
 * T456 (D43 follow-up): what happens when a node's agent crashes (its
 * vendor exits non-zero on its own). `vendor_failure:` in the home
 * `config.yaml`, a repo's entry in `repos.yaml` and a project record; each
 * field resolves project, then repo, then home, then the built-in
 * (`BUILTIN_VENDOR_FAILURE`).
 *
 * - `retry`: start the same vendor and model again, once (not for a login
 *   or model refusal, which a retry can't fix);
 * - `fallback`: then the next of these vendors that is installed;
 * - `allow_hookless`: a vendor with pre-tool hooks may fall back to one
 *   without (`HOOKED_VENDORS`). Off, it never lowers the enforcement floor.
 */
export const VendorFailureSchema = z
  .object({
    retry: z.boolean().optional(),
    fallback: z.array(SessionVendorSchema).max(SESSION_VENDORS.length).optional(),
    allow_hookless: z.boolean().optional(),
  })
  .strict();
export type VendorFailureSettings = z.infer<typeof VendorFailureSchema>;

export interface ResolvedVendorFailure {
  retry: boolean;
  fallback: SessionVendor[];
  allow_hookless: boolean;
}

export const BUILTIN_VENDOR_FAILURE: Readonly<ResolvedVendorFailure> = Object.freeze({
  retry: true,
  fallback: [],
  allow_hookless: false,
});

/** T456: field by field, the first step that says (most specific first), else the built-in. */
export function resolveVendorFailure(
  ...steps: ReadonlyArray<VendorFailureSettings | undefined>
): ResolvedVendorFailure {
  const pick = <K extends keyof VendorFailureSettings>(key: K) =>
    steps.find((step) => step?.[key] !== undefined)?.[key];
  return {
    retry: pick('retry') ?? BUILTIN_VENDOR_FAILURE.retry,
    fallback: [...new Set(pick('fallback') ?? BUILTIN_VENDOR_FAILURE.fallback)],
    allow_hookless: pick('allow_hookless') ?? BUILTIN_VENDOR_FAILURE.allow_hookless,
  };
}

/**
 * A Settings write: absent = unchanged, `null` = remove (fall through to
 * the next step of the order), a value = set. T456: `vendor_failure` is
 * replaced whole.
 */
export const SessionDefaultsPatchSchema = z
  .object({
    vendor: SessionVendorSchema.nullable().optional(),
    model: z.string().trim().min(1).max(SESSION_MODEL_MAX_CHARS).nullable().optional(),
    effort: EffortSchema.nullable().optional(),
    vendor_failure: VendorFailureSchema.nullable().optional(),
  })
  .strict();
export type SessionDefaultsPatch = z.infer<typeof SessionDefaultsPatchSchema>;

/** What a record (home or repo) says itself, before resolution. */
export interface SessionDefaultsFields {
  vendor?: string;
  model?: string;
  effort?: Effort;
  /** T456: what it says about a crashed agent. */
  vendor_failure?: VendorFailureSettings;
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
  // Most specific first; the built-in last.
  const steps: Array<{ vendor?: string; model?: string }> = [
    flags,
    project ?? {},
    repo ?? {},
    { vendor: home?.default_vendor, model: home?.default_model },
    BUILTIN_SESSION_DEFAULTS,
  ];
  // The vendor a step runs: its own, else what the steps below it say.
  const vendorAt = (from: number): string =>
    firstDefined(...steps.slice(from).map((step) => step.vendor)) ??
    BUILTIN_SESSION_DEFAULTS.vendor;
  const vendor = vendorAt(0);
  // T402 (D40): a model counts only where that step runs the same vendor, so a
  // Claude model named in the home never reaches a repo set to Gemini.
  const model = firstDefined(
    ...steps.map((step, index) =>
      step.model !== undefined && vendorAt(index) === vendor ? step.model : undefined,
    ),
  );
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
  /**
   * T467 (D46): each vendor's own model list, from its most recent
   * `session/new` reply; the pickers show it in place of `known_models`.
   * A vendor that never reported one is absent.
   */
  vendor_models?: Readonly<Partial<Record<SessionVendor, VendorModels>>>;
  /** T437: vendors whose command isn't on the daemon's PATH, with why in words. Absent: all found (or an older daemon). */
  not_installed?: Readonly<Partial<Record<SessionVendor, string>>>;
}
