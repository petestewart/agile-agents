/**
 * `<home>/config.yaml` — the state home's own config (PLAN.md §5, D9;
 * design/cockpit-design.md §7.1/§7.2: "started once (`agile daemon start`,
 * detached, pidfile and port in `config.yaml`)").
 *
 * T112: this is the *home* config, not the per-repo `agile.config.yaml`.
 * The daemon is one long-lived process for every registered repo, so the
 * things a client needs to find it — the HTTP port and the unix socket —
 * live here, where a client with no repo cwd can still read them.
 *
 * Unknown keys are refused (`.strict()`), same rule as every other schema
 * in this package: a hand-editable file must fail loudly on a typo rather
 * than silently ignore it.
 */

import { z } from 'zod';
import { EffortSchema } from './effort';
import { formatZodError } from './ids';

/** Built-in default HTTP port for the cockpit/API when `config.yaml` names none. */
export const DEFAULT_DAEMON_PORT = 4600;

/**
 * §6.3's bands (**D6**): a classifier answer either denies, allows, or
 * routes to the human inbox, and a low-confidence answer routes whatever
 * its probability. The numbers live in config precisely so moving them is
 * not a code change (§6.3, "these are starting points").
 */
export const DEFAULT_CLASSIFIER_DENY_AT = 0.8;
export const DEFAULT_CLASSIFIER_ALLOW_BELOW = 0.4;
export const DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR = 0.5;
/** §6.2's transport: `https://api.typesafe.ai`, 25 s timeout. */
export const DEFAULT_CLASSIFIER_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 25_000;

/** A band threshold — a probability or a confidence, both in `[0, 1]`. */
const BandNumberSchema = z.number().min(0).max(1);

export const ClassifierBandsSchema = z
  .object({
    /** `probability >= deny_at` → DENY, with the rule named in the reason. */
    deny_at: BandNumberSchema.default(DEFAULT_CLASSIFIER_DENY_AT),
    /** `probability < allow_below` → ALLOW. Everything between the two routes. */
    allow_below: BandNumberSchema.default(DEFAULT_CLASSIFIER_ALLOW_BELOW),
    /** `confidence < confidence_floor` → ROUTE, whatever the probability. */
    confidence_floor: BandNumberSchema.default(DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR),
  })
  .strict();
export type ClassifierBands = z.infer<typeof ClassifierBandsSchema>;

/** `off` is the opt-out (§6.4): no classifier tier at all, home-wide. */
export const CLASSIFIER_PROVIDERS = ['jev', 'off'] as const;
export const ClassifierProviderSchema = z.enum(CLASSIFIER_PROVIDERS);
export type ClassifierProvider = z.infer<typeof ClassifierProviderSchema>;

/**
 * T150 (§6.2): the classifier tier's own config, under `classifier:` in
 * `<home>/config.yaml`.
 *
 * **D5** is the one approved exception to "no vendor credentials in the
 * daemon" — the classifier is the daemon's own dependency, not an agent's.
 * `api_key` may be left out and supplied as `TYPESAFE_API_KEY` instead;
 * neither present means the tier is simply not configured, and §6.4's fail
 * policy applies (critical rules deny, the rest proceed with a
 * `hook_unchecked` thread entry).
 */
export const ClassifierConfigSchema = z
  .object({
    provider: ClassifierProviderSchema.default('jev'),
    api_key: z.string().min(1).optional(),
    base_url: z.string().min(1).default(DEFAULT_CLASSIFIER_BASE_URL),
    timeout_ms: z.number().int().positive().default(DEFAULT_CLASSIFIER_TIMEOUT_MS),
    bands: ClassifierBandsSchema.default({}),
  })
  .strict();
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
/** Pre-validation shape: every field is defaulted, so the whole block is optional. */
export type ClassifierConfigInput = z.input<typeof ClassifierConfigSchema>;

export function validateClassifierConfig(input: unknown): ClassifierConfig {
  const result = ClassifierConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(formatZodError('classifier config', result.error));
  }
  return result.data;
}

export const HomeConfigSchema = z
  .object({
    /** HTTP port for the localhost cockpit/API. `0` lets the OS pick. */
    port: z.number().int().min(0).max(65535).optional(),
    /** Unix socket path for the JSON-RPC API. Defaults to `<home>/agiled.sock`. */
    socketPath: z.string().min(1).optional(),
    /**
     * T130 (**D12**): home-wide session defaults — the third step of the
     * resolution order (`--flag` → the stream's repo entry in `repos.yaml`
     * → here → the provider's own default).
     */
    default_vendor: z.string().min(1).optional(),
    default_model: z.string().min(1).optional(),
    default_effort: EffortSchema.optional(),
    /**
     * T150 (§6.2, **D5**): the classifier tier. Optional rather than
     * defaulted, so `HomeConfig` stays the shape of the *file* and every
     * existing caller that builds one by hand keeps compiling; the daemon
     * applies the defaults once, in `discoverConfig`, through
     * `validateClassifierConfig`.
     */
    classifier: ClassifierConfigSchema.optional(),
  })
  .strict();

export type HomeConfig = z.infer<typeof HomeConfigSchema>;

export function validateHomeConfig(input: unknown): HomeConfig {
  const result = HomeConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(formatZodError('home config', result.error));
  }
  return result.data;
}
