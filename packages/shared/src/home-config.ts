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
import { HarnessUpdatesConfigSchema } from './harness-updates';
import { formatZodError } from './ids';
import { ModelPolicyPartialSchema, ModelProfilesSchema } from './model-policy';
import { PermissionPostureSchema } from './posture';
import {
  FAVOURITE_MODELS_MAX,
  FavouriteModelSchema,
  VendorFailureSchema,
} from './session-defaults';

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

/**
 * T320 (projects-design §14.10, P17/**D31**): Jira and Linear connections
 * under `trackers:` in `<home>/config.yaml`. `token` is the second written
 * credential exception after the classifier key: written only through the
 * store at 0600, never printed, logged, put in an event or sent to the
 * browser; status surfaces say only whether one is set.
 */
export const TRACKER_SYSTEMS = ['jira', 'linear'] as const;
export const TrackerSystemSchema = z.enum(TRACKER_SYSTEMS);
export type TrackerSystem = z.infer<typeof TrackerSystemSchema>;
export const DEFAULT_LINEAR_API_URL = 'https://api.linear.app/graphql';
export const TRACKER_TOKEN_MAX_CHARS = 1024;
const TrackerTokenSchema = z.string().trim().min(1).max(TRACKER_TOKEN_MAX_CHARS);
export const TrackersConfigSchema = z
  .object({
    /** Jira Cloud/Server. With `email`, Basic auth (`email:token`); without, a Bearer PAT. */
    jira: z
      .object({
        base_url: z.string().url(),
        email: z.string().min(1).optional(),
        token: TrackerTokenSchema.optional(),
      })
      .strict()
      .optional(),
    linear: z
      .object({
        api_url: z.string().url().default(DEFAULT_LINEAR_API_URL),
        token: TrackerTokenSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TrackersConfig = z.infer<typeof TrackersConfigSchema>;

export function validateTrackersConfig(input: unknown): TrackersConfig {
  const result = TrackersConfigSchema.safeParse(input ?? {});
  // The schema's message could quote a value; never echo a token.
  if (!result.success) throw new Error('home config: trackers is invalid (values not shown)');
  return result.data;
}

/** What `daemon.status` says per tracker: configured (a connection and a token) or not. Never the token. */
export type TrackerStatus = Record<TrackerSystem, 'configured' | 'not configured'>;

export function trackerStatus(config: TrackersConfig | undefined): TrackerStatus {
  return {
    jira: config?.jira?.token ? 'configured' : 'not configured',
    linear: config?.linear?.token ? 'configured' : 'not configured',
  };
}

/** T454: `knowledge_wake`'s two values; `source` is the default. */
export const KNOWLEDGE_WAKE_MODES = ['source', 'jev'] as const;
export type KnowledgeWakeMode = (typeof KNOWLEDGE_WAKE_MODES)[number];

/** T465 (D48): a finished turn's session is kept this long (minutes) when the home sets nothing. */
export const DEFAULT_SESSION_IDLE_MINUTES = 30;
/** T465: the longest a finished turn's session may be kept (a day). */
export const MAX_SESSION_IDLE_MINUTES = 1440;

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
    /** T456: retry and fall back on a crashed agent (home step; `VendorFailureSchema`). */
    vendor_failure: VendorFailureSchema.optional(),
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
    /** T320 (D31): Jira/Linear connections and tokens. */
    trackers: TrackersConfigSchema.optional(),
    /**
     * T434 (D41): quick drafts by one cheap model call through the user's own
     * `claude` login: an untitled node's title, and Turn into work's goal.
     * `false` turns both off (the first line stays the title; the goal starts
     * from the last reply). Absent = on.
     */
    quick_drafts: z.boolean().optional(),
    /**
     * T454 (D44 follow-up): who an accepted knowledge item wakes among the
     * conversations in its scope. `source` (absent): only the one that
     * proposed it (T453). `jev`: also any other the classifier judges it
     * relevant to and still current (`events/knowledge-wake.ts`).
     */
    knowledge_wake: z.enum(KNOWLEDGE_WAKE_MODES).optional(),
    /** T457: the permission posture (`posture.ts`); a project may override it. Absent = `ask`. */
    permissions: PermissionPostureSchema.optional(),
    /** T478: New node's "Close it when its goal is met" starts on. Absent = off. */
    auto_close: z.boolean().optional(),
    /**
     * T480 (D49): run the Claude Code / Codex the operator installed (found on
     * PATH) rather than the copy bundled in the ACP bridge. `false` for a
     * vendor keeps its bundled copy. Absent = on.
     */
    installed_cli: z
      .object({ claude: z.boolean().optional(), codex: z.boolean().optional() })
      .strict()
      .optional(),
    /**
     * T469: the models starred as favourites. With any, the model picker
     * lists only these (and what runs), with a Show all switch.
     */
    favourite_models: z.array(FavouriteModelSchema).max(FAVOURITE_MODELS_MAX).optional(),
    /**
     * T482 (D54): the home's model choice, the default every project inherits
     * field by field (Settings → Agents → Model choice). A field left out
     * reads what ships: Choose, quality 50, Start cheap, the favourites as
     * the preset models, no pinned rules.
     */
    model_policy: ModelPolicyPartialSchema.optional(),
    /**
     * T482: each model's tier and relative cost, keyed `vendor/model`, over
     * the shipped ones (`DEFAULT_MODEL_PROFILES`). Only the operator sets them.
     */
    model_profiles: ModelProfilesSchema.optional(),
    /**
     * T465 (D48): how long an agent's session stays alive and idle after its
     * turn finished, in minutes, so the next message keeps its context.
     * Absent = `DEFAULT_SESSION_IDLE_MINUTES`.
     */
    session_idle_minutes: z.number().int().min(1).max(MAX_SESSION_IDLE_MINUTES).optional(),
    /**
     * T481 (D50): keeping each vendor's CLI up to date: Off, Alert (absent)
     * or Auto, a vendor's own mode, and the dismissed versions.
     */
    harness_updates: HarnessUpdatesConfigSchema.optional(),
    /** T243 (P11): routed-event settings. `wake_budget_per_hour` defaults to 20. */
    events: z
      .object({ wake_budget_per_hour: z.number().int().positive().optional() })
      .strict()
      .optional(),
    /**
     * T302: the Director's sight. `stuck_after_minutes` (default 60): a
     * `working` node idle this long is stuck. `wake_budget_per_hour`
     * (default 6): daemon-emitted Director wakes for stuck nodes.
     */
    director: z
      .object({
        stuck_after_minutes: z.number().int().positive().optional(),
        wake_budget_per_hour: z.number().int().positive().optional(),
      })
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

/**
 * T326 (D31): one write to a tracker's settings, from Settings
 * (`POST /api/settings/trackers`) or `agile tracker set|clear`
 * (`tracker.set`). Absent = unchanged, `null` = removed. `base_url` and
 * `email` are Jira's and are not secret; `token` is write-only.
 */
export const TrackerSettingsInputSchema = z
  .object({
    system: TrackerSystemSchema,
    base_url: z.string().url().nullable().optional(),
    email: z.string().trim().min(1).nullable().optional(),
    token: TrackerTokenSchema.nullable().optional(),
  })
  .strict();
export type TrackerSettingsInput = z.infer<typeof TrackerSettingsInputSchema>;

/** T326: what Settings and `agile tracker status` show — the non-secret fields and whether a token is set. */
export interface TrackerSettingsStatus {
  jira: { token_set: boolean; base_url?: string; email?: string };
  linear: { token_set: boolean };
}

export function trackerSettingsStatus(config: TrackersConfig | undefined): TrackerSettingsStatus {
  const jira = config?.jira;
  return {
    jira: {
      token_set: jira?.token !== undefined,
      ...(jira?.base_url ? { base_url: jira.base_url } : {}),
      ...(jira?.email ? { email: jira.email } : {}),
    },
    linear: { token_set: config?.linear?.token !== undefined },
  };
}

/** T434: Settings' quick drafts switch (`POST /api/settings/quick-drafts`). */
export const QuickDraftsInputSchema = z.object({ on: z.boolean() }).strict();
export type QuickDraftsInput = z.infer<typeof QuickDraftsInputSchema>;

/** T480 (D49): the vendors whose installed CLI can stand in for the bridge's bundled copy. */
export const INSTALLED_CLI_VENDORS = ['claude', 'codex'] as const;
export type InstalledCliVendor = (typeof INSTALLED_CLI_VENDORS)[number];

/** T480: Settings' "Use the installed …" switch (`POST /api/settings/installed-cli`). */
export const InstalledCliInputSchema = z
  .object({ vendor: z.enum(INSTALLED_CLI_VENDORS), on: z.boolean() })
  .strict();
export type InstalledCliInput = z.infer<typeof InstalledCliInputSchema>;

/** T454: Settings' "Let Jev decide" switch (`POST /api/settings/knowledge-wake`). */
export const KnowledgeWakeInputSchema = z.object({ on: z.boolean() }).strict();
export type KnowledgeWakeInput = z.infer<typeof KnowledgeWakeInputSchema>;

/** T478: Settings' auto-close default for new nodes (`POST /api/settings/auto-close`). */
export const AutoCloseInputSchema = z.object({ on: z.boolean() }).strict();
export type AutoCloseInput = z.infer<typeof AutoCloseInputSchema>;

/** T465 (D48): Settings' idle session timeout (`POST /api/settings/session-idle`). */
export const SessionIdleInputSchema = z
  .object({ minutes: z.number().int().min(1).max(MAX_SESSION_IDLE_MINUTES) })
  .strict();
export type SessionIdleInput = z.infer<typeof SessionIdleInputSchema>;
