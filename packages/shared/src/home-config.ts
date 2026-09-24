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
 * routes to the human inbox. **D14**: a Noul's single value is the answer
 * and its certainty in one, so the bands read that raw value and nothing
 * else — the route band *is* the low-confidence case. The numbers live in
 * config precisely so moving them is not a code change (§6.3, "these are
 * starting points").
 */
export const DEFAULT_CLASSIFIER_DENY_AT = 0.8;
export const DEFAULT_CLASSIFIER_ALLOW_BELOW = 0.4;
/** §6.2's transport: `https://api.typesafe.ai`, 25 s timeout. */
export const DEFAULT_CLASSIFIER_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 25_000;
/**
 * T152 (§8.2): how much state one classifier call may carry. The diff-level
 * check at landing sends the stream's whole diff, and a large one does not
 * fit in a single call — "over the classifier's budget ⇒ split per file,
 * take the MAX". A field rather than a constant in the daemon so the budget
 * moves with the provider's limits without a code change.
 */
export const DEFAULT_CLASSIFIER_STATE_MAX_CHARS = 60_000;

/** A band threshold on the raw Noul value, in `[0, 1]`. */
const BandNumberSchema = z.number().min(0).max(1);

/**
 * The key D14 removed (T156). An old `config.yaml` that still carries it is
 * refused with a message naming the decision rather than a bare "unrecognized
 * key", and it is never silently dropped: the human deletes the line.
 */
const REMOVED_BAND_KEY = 'confidence_floor';
export const REMOVED_BAND_KEY_MESSAGE = `classifier.bands.${REMOVED_BAND_KEY} was removed by D14 (T156): a Noul has no separate confidence, the bands read the raw value only — delete this key from config.yaml`;

export const ClassifierBandsSchema = z
  .object(
    {
      /** `probability >= deny_at` → DENY, with the rule named in the reason. */
      deny_at: BandNumberSchema.default(DEFAULT_CLASSIFIER_DENY_AT),
      /** `probability < allow_below` → ALLOW. Everything between the two routes. */
      allow_below: BandNumberSchema.default(DEFAULT_CLASSIFIER_ALLOW_BELOW),
    },
    {
      errorMap: (issue, ctx) =>
        issue.code === 'unrecognized_keys' && issue.keys.includes(REMOVED_BAND_KEY)
          ? { message: REMOVED_BAND_KEY_MESSAGE }
          : { message: ctx.defaultError },
    },
  )
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
    /** §8.2's budget: a state longer than this is split per file (T152). */
    state_max_chars: z.number().int().positive().default(DEFAULT_CLASSIFIER_STATE_MAX_CHARS),
    bands: ClassifierBandsSchema.default({}),
  })
  .strict();
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
/** Pre-validation shape: every field is defaulted, so the whole block is optional. */
export type ClassifierConfigInput = z.input<typeof ClassifierConfigSchema>;

/**
 * T167: the cockpit's "TypeSafe API key" field (`POST
 * /api/settings/classifier/key`). Write-only: nothing the daemon returns
 * ever carries the key back, only where it came from
 * (`ClassifierKeyStatus`).
 */
export const CLASSIFIER_KEY_MAX_CHARS = 512;
export const ClassifierKeyInputSchema = z
  .object({ api_key: z.string().trim().min(1).max(CLASSIFIER_KEY_MAX_CHARS) })
  .strict();
export type ClassifierKeyInput = z.infer<typeof ClassifierKeyInputSchema>;

/** Where the daemon's classifier key comes from: `config.yaml`, `TYPESAFE_API_KEY`, or nowhere. */
export const CLASSIFIER_KEY_SOURCES = ['config', 'environment', 'none'] as const;
export type ClassifierKeySource = (typeof CLASSIFIER_KEY_SOURCES)[number];

/**
 * T167: what `GET /api/settings/classifier` and `daemon.status` say about
 * the key — its source and whether a call could be made, never the key.
 * `loaded` is false when the provider is `off`, whatever the key.
 * `environment_also` is true when a config key shadows an env key, so the
 * UI can say that Remove falls back to it.
 */
export interface ClassifierKeyStatus {
  source: ClassifierKeySource;
  loaded: boolean;
  provider: ClassifierProvider;
  environment_also: boolean;
}

export function validateClassifierConfig(input: unknown): ClassifierConfig {
  const result = ClassifierConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(formatZodError('classifier config', result.error));
  }
  return result.data;
}

/** T221 (projects-design §18): the GitHub REST endpoint. No token here (P18): `gh auth token` per call. */
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const GitHubConfigSchema = z
  .object({
    api_url: z.string().url().default(DEFAULT_GITHUB_API_URL),
    /**
     * The `gh` the daemon borrows a token from. Test homes point it at a
     * path that does not exist, so no test daemon ever runs the real `gh`.
     */
    gh_command: z.string().min(1).default('gh'),
  })
  .strict();
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

export function validateGitHubConfig(input: unknown): GitHubConfig {
  const result = GitHubConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(formatZodError('github config', result.error));
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
    /** T221: `github.api_url`, defaulted in `discoverConfig`. */
    github: GitHubConfigSchema.optional(),
    /** T243 (P11): routed-event settings. `wake_budget_per_hour` defaults to 20. */
    events: z
      .object({ wake_budget_per_hour: z.number().int().positive().optional() })
      .strict()
      .optional(),
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
