/**
 * T482 (design/model-routing.md §3–§4, D53–D55): model routing's policy and
 * lock. Who picks a node's model, and inside which limits.
 *
 * - An **explicit pick** is the operator's own (the composer's model chip,
 *   Start with…, New node's model, `agile attach --vendor/--model/--effort`).
 *   It always wins and is never clamped (D53).
 * - A **routed pick** is any other: a coordinator's or the Director's node,
 *   a wake, a node made without a model. It is made once, at the node's first
 *   start, and again only after "Let the policy choose again" (D55).
 *
 * The policy resolves field by field: the node, its ancestors (nearest
 * first), its project, the home `config.yaml`, then the built-in (what ships,
 * D54). `pickModel` is the precedence of §4 as one pure function, so the
 * daemon, the CLI and the cockpit read a pick the same way. T483 adds the
 * chooser (Jev) and the pinned rules; here they are schema only.
 */

import { z } from 'zod';
import { EFFORT_LEVELS, type Effort, EffortSchema } from './effort';
import { UlidSchema } from './ids';
import {
  type FavouriteModel,
  KNOWN_MODEL_IDS,
  SESSION_MODEL_MAX_CHARS,
  type SessionVendor,
  SessionVendorSchema,
  isSessionVendor,
  vendorTakesEffort,
} from './session-defaults';

// ---------------------------------------------------------------- the policy

/** `default`: today's resolution. `inherit`: the parent's current pick. `choose`: the chooser (§5). */
export const MODEL_POLICY_MODES = ['default', 'inherit', 'choose'] as const;
export const ModelPolicyModeSchema = z.enum(MODEL_POLICY_MODES);
export type ModelPolicyMode = z.infer<typeof ModelPolicyModeSchema>;

/** §6: begin cheap and step up, or the strongest preset model and stay there. */
export const MODEL_ESCALATIONS = ['start_cheap', 'strongest_first'] as const;
export const ModelEscalationSchema = z.enum(MODEL_ESCALATIONS);
export type ModelEscalation = z.infer<typeof ModelEscalationSchema>;

/** §5's criteria, each weighted 0–3 (default 1). */
export const ROUTING_CRITERIA = [
  'clarity',
  'verifiability',
  'horizon',
  'stakes',
  'volume',
] as const;
export type RoutingCriterion = (typeof ROUTING_CRITERIA)[number];

/** The node roles a pinned rule's `when` may name (§3). */
export const PINNED_RULE_ROLES = ['coordinator', 'worker', 'reviewer', 'conversation'] as const;
/** The topics the chooser reads (§5's `topic`). */
export const PINNED_RULE_TOPICS = ['architecture', 'migration', 'security'] as const;

export const MODEL_POLICY_GUIDANCE_MAX_CHARS = 2000;
export const PRESET_MODELS_MAX = 100;
export const PINNED_RULES_MAX = 50;
export const MODEL_PROFILES_MAX = 300;

/**
 * One preset model: a vendor and a model id. `default` is the vendor's own
 * default model (a favourite with no model is kept that way here).
 */
export const PresetModelSchema = z
  .object({
    vendor: SessionVendorSchema,
    model: z.string().trim().min(1).max(SESSION_MODEL_MAX_CHARS),
  })
  .strict();
export type PresetModel = z.infer<typeof PresetModelSchema>;

const WeightSchema = z.number().int().min(0).max(3);

/** The criterion weights; a criterion left out weighs 1. */
export const CriterionWeightsSchema = z
  .object({
    clarity: WeightSchema.optional(),
    verifiability: WeightSchema.optional(),
    horizon: WeightSchema.optional(),
    stakes: WeightSchema.optional(),
    volume: WeightSchema.optional(),
  })
  .strict();
export type CriterionWeights = z.infer<typeof CriterionWeightsSchema>;
export type ResolvedCriterionWeights = Record<RoutingCriterion, number>;

/** A pinned rule: *when* (a role, a label or a topic; at least one) → *pick*. T483 applies them. */
export const PinnedRuleSchema = z
  .object({
    when: z
      .object({
        role: z.enum(PINNED_RULE_ROLES).optional(),
        label: z.string().trim().min(1).max(40).optional(),
        topic: z.enum(PINNED_RULE_TOPICS).optional(),
      })
      .strict()
      .refine((w) => w.role !== undefined || w.label !== undefined || w.topic !== undefined, {
        message: 'a pinned rule names a role, a label or a topic',
      }),
    pick: z
      .object({
        vendor: SessionVendorSchema,
        model: z.string().trim().min(1).max(SESSION_MODEL_MAX_CHARS),
        effort: EffortSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type PinnedRule = z.infer<typeof PinnedRuleSchema>;

const fields = {
  mode: ModelPolicyModeSchema,
  quality: z.number().int().min(0).max(100),
  presets: z.array(PresetModelSchema).max(PRESET_MODELS_MAX),
  effort_ceiling: EffortSchema,
  escalation: ModelEscalationSchema,
  pinned_rules: z.array(PinnedRuleSchema).max(PINNED_RULES_MAX),
  guidance: z.string().max(MODEL_POLICY_GUIDANCE_MAX_CHARS),
  weights: CriterionWeightsSchema,
};

/** Every field of the policy, in the order Settings shows them. */
export const MODEL_POLICY_FIELDS = [
  'mode',
  'quality',
  'presets',
  'effort_ceiling',
  'escalation',
  'pinned_rules',
  'guidance',
  'weights',
] as const;
export type ModelPolicyField = (typeof MODEL_POLICY_FIELDS)[number];

/** A resolved policy: every field has a value (weights too, each criterion). */
export const ModelPolicySchema = z.object(fields).strict();
export type ModelPolicy = Omit<z.infer<typeof ModelPolicySchema>, 'weights'> & {
  weights: ResolvedCriterionWeights;
};

/**
 * What a layer says (the home `config.yaml`, a project record, a node's
 * `human.model_policy`): any field, each optional. Absent inherits.
 */
export const ModelPolicyPartialSchema = ModelPolicySchema.partial().strict();
export type ModelPolicyPartial = z.infer<typeof ModelPolicyPartialSchema>;

/** A write to one layer: absent = unchanged, `null` = inherit again, a value = set here. */
export const ModelPolicyPatchSchema = z
  .object({
    mode: fields.mode.nullable().optional(),
    quality: fields.quality.nullable().optional(),
    presets: fields.presets.nullable().optional(),
    effort_ceiling: fields.effort_ceiling.nullable().optional(),
    escalation: fields.escalation.nullable().optional(),
    pinned_rules: fields.pinned_rules.nullable().optional(),
    guidance: fields.guidance.nullable().optional(),
    weights: fields.weights.nullable().optional(),
  })
  .strict();
export type ModelPolicyPatch = z.infer<typeof ModelPolicyPatchSchema>;

/** A layer after a patch; `undefined` when nothing is set there any more. */
export function applyModelPolicyPatch(
  before: ModelPolicyPartial | undefined,
  patch: ModelPolicyPatch,
): ModelPolicyPartial {
  const next: Record<string, unknown> = { ...(before ?? {}) };
  for (const field of MODEL_POLICY_FIELDS) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return ModelPolicyPartialSchema.parse(next);
}

// ---------------------------------------------------------------- model profiles

export const MODEL_TIERS = ['fast', 'balanced', 'strongest'] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** §3: which models are cheap and which are strong (the vendors don't say). */
export const ModelProfileSchema = z
  .object({
    tier: ModelTierSchema,
    /** Relative, e.g. Sonnet 1, Opus 2, Haiku 0.3. */
    cost: z.number().positive().max(1000),
  })
  .strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** `claude/claude-sonnet-5-5`: a profile's key. */
export const MODEL_KEY_PATTERN = /^[a-z]+\/[^\s/][^\s]*$/;
export const ModelKeySchema = z
  .string()
  .max(SESSION_MODEL_MAX_CHARS + 20)
  .regex(MODEL_KEY_PATTERN, 'must look like vendor/model')
  .refine((key) => isSessionVendor(key.slice(0, key.indexOf('/'))), {
    message: 'names an unknown vendor',
  });

/** Home `config.yaml` `model_profiles`, keyed `vendor/model`. */
export const ModelProfilesSchema = z
  .record(ModelKeySchema, ModelProfileSchema)
  .refine((r) => Object.keys(r).length <= MODEL_PROFILES_MAX, {
    message: `at most ${MODEL_PROFILES_MAX} model profiles`,
  });
export type ModelProfiles = z.infer<typeof ModelProfilesSchema>;

/** A write to the profiles: a profile sets one, `null` goes back to the shipped one (or none). */
export const ModelProfilesPatchSchema = z.record(ModelKeySchema, ModelProfileSchema.nullable());
export type ModelProfilesPatch = z.infer<typeof ModelProfilesPatchSchema>;

export function modelKey(vendor: string, model: string): string {
  return `${vendor}/${model}`;
}

/**
 * What ships (§3, measured in LIVE-CHECKLIST §12): Claude's models and
 * aliases, and Codex's. The Codex tiers are a first guess from its list;
 * Settings edits them all.
 */
export const DEFAULT_MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  'claude/claude-opus-5-5': { tier: 'strongest', cost: 2 },
  'claude/claude-fable-5-1': { tier: 'strongest', cost: 2 },
  'claude/claude-opus-4-8': { tier: 'strongest', cost: 2 },
  'claude/opus': { tier: 'strongest', cost: 2 },
  'claude/claude-sonnet-5-5': { tier: 'balanced', cost: 1 },
  'claude/claude-sonnet-4-6': { tier: 'balanced', cost: 1 },
  'claude/sonnet': { tier: 'balanced', cost: 1 },
  'claude/claude-haiku-4-5': { tier: 'fast', cost: 0.3 },
  'claude/haiku': { tier: 'fast', cost: 0.3 },
  'codex/gpt-6-astra': { tier: 'strongest', cost: 2 },
  'codex/gpt-5.6-sol': { tier: 'balanced', cost: 1 },
  'codex/gpt-5.6-terra': { tier: 'balanced', cost: 1 },
  'codex/gpt-5.6-luna': { tier: 'fast', cost: 0.3 },
  'codex/gpt-5.5': { tier: 'balanced', cost: 1 },
});

/** A model with no profile reads balanced, cost 1 (§3). */
export const UNKNOWN_MODEL_PROFILE: Readonly<ModelProfile> = Object.freeze({
  tier: 'balanced',
  cost: 1,
});

/** The shipped profiles with the home's own over them. */
export function effectiveModelProfiles(own?: ModelProfiles): Record<string, ModelProfile> {
  return { ...DEFAULT_MODEL_PROFILES, ...(own ?? {}) };
}

/**
 * A model's profile: its own key, else the key without a vendor's bracketed
 * settings (Claude's `opus[1m]` reads as `opus`), else balanced, cost 1.
 */
export function profileOf(
  vendor: string,
  model: string,
  profiles: Readonly<Record<string, ModelProfile>> = DEFAULT_MODEL_PROFILES,
): ModelProfile & { known: boolean } {
  const exact = profiles[modelKey(vendor, model)];
  if (exact !== undefined) return { ...exact, known: true };
  const bare = model.replace(/\[[^\]]*\]$/, '');
  const stripped = bare !== model ? profiles[modelKey(vendor, bare)] : undefined;
  if (stripped !== undefined) return { ...stripped, known: true };
  return { ...UNKNOWN_MODEL_PROFILE, known: false };
}

// ---------------------------------------------------------------- resolution

/** D54: what ships as the home default when `config.yaml` sets nothing. */
export const BUILTIN_MODEL_POLICY: Readonly<Omit<ModelPolicy, 'presets'>> = Object.freeze({
  mode: 'choose',
  quality: 50,
  effort_ceiling: 'max',
  escalation: 'start_cheap',
  pinned_rules: [],
  guidance: '',
  weights: { clarity: 1, verifiability: 1, horizon: 1, stakes: 1, volume: 1 },
});

/** T469's favourites as preset models (no model = the vendor's own default). */
export function favouritesAsPresets(favourites: readonly FavouriteModel[] = []): PresetModel[] {
  const seen = new Set<string>();
  const out: PresetModel[] = [];
  for (const f of favourites) {
    const preset = { vendor: f.vendor, model: f.model ?? 'default' };
    const key = modelKey(preset.vendor, preset.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(preset);
  }
  return out;
}

/** The built-in step, whole: D54's defaults, with the favourites as the presets. */
export function builtinModelPolicy(favourites: readonly FavouriteModel[] = []): ModelPolicy {
  return {
    ...BUILTIN_MODEL_POLICY,
    weights: { ...BUILTIN_MODEL_POLICY.weights },
    pinned_rules: [],
    presets: favouritesAsPresets(favourites),
  };
}

export const POLICY_SOURCE_KINDS = ['node', 'ancestor', 'project', 'home', 'built-in'] as const;
export type PolicySourceKind = (typeof POLICY_SOURCE_KINDS)[number];

/** Where one field's value came from. An ancestor is named. */
export interface PolicySource {
  from: PolicySourceKind;
  /** An ancestor's (or the project's) id. */
  id?: string;
  /** An ancestor's title, or the project's name. */
  title?: string;
}

export interface ResolveModelPolicyInput {
  /** The node's own `human.model_policy`. */
  node?: ModelPolicyPartial;
  /** Its ancestors, nearest first (a policy on a coordinator governs its subtree). */
  ancestors?: ReadonlyArray<{ id: string; title: string; policy?: ModelPolicyPartial }>;
  /** Its project's `model_policy`, and the project for naming. */
  project?: { id?: string; name?: string; policy?: ModelPolicyPartial };
  /** The home `config.yaml` `model_policy`. */
  home?: ModelPolicyPartial;
  /** T469: the favourites, the built-in presets. */
  favourites?: readonly FavouriteModel[];
}

export interface ResolvedModelPolicy {
  policy: ModelPolicy;
  sources: Record<ModelPolicyField, PolicySource>;
}

function resolvedWeights(weights: CriterionWeights | undefined): ResolvedCriterionWeights {
  const out = { ...BUILTIN_MODEL_POLICY.weights };
  for (const c of ROUTING_CRITERIA) {
    const w = weights?.[c];
    if (w !== undefined) out[c] = w;
  }
  return out;
}

/**
 * §4: each field from the first layer that sets it: the node, its ancestors
 * (nearest first), the project, the home, then the built-in.
 */
export function resolveModelPolicy(input: ResolveModelPolicyInput = {}): ResolvedModelPolicy {
  const layers: Array<{ policy: ModelPolicyPartial | undefined; source: PolicySource }> = [
    { policy: input.node, source: { from: 'node' } },
    ...(input.ancestors ?? []).map((a) => ({
      policy: a.policy,
      source: { from: 'ancestor' as const, id: a.id, title: a.title },
    })),
    {
      policy: input.project?.policy,
      source: {
        from: 'project',
        ...(input.project?.id !== undefined ? { id: input.project.id } : {}),
        ...(input.project?.name !== undefined ? { title: input.project.name } : {}),
      },
    },
    { policy: input.home, source: { from: 'home' } },
  ];
  const builtin = builtinModelPolicy(input.favourites);
  const policy = { ...builtin } as Record<ModelPolicyField, unknown>;
  const sources = {} as Record<ModelPolicyField, PolicySource>;
  for (const field of MODEL_POLICY_FIELDS) {
    const layer = layers.find((l) => l.policy?.[field] !== undefined);
    if (layer !== undefined) {
      policy[field] = layer.policy?.[field];
      sources[field] = layer.source;
    } else {
      sources[field] = { from: 'built-in' };
    }
  }
  policy.weights = resolvedWeights(policy.weights as CriterionWeights | undefined);
  return { policy: policy as unknown as ModelPolicy, sources };
}

/**
 * "set here", "from Billing" (an ancestor), "from the project (shop)", "from
 * Home". What ships (D54) is the home's default, so below the home a built-in
 * value reads "from Home" too; in the home's own view it reads "built in".
 */
export function policySourceWords(source: PolicySource, here: 'node' | 'project' | 'home'): string {
  if (source.from === here) return 'set here';
  if (source.from === 'built-in' && here !== 'home') return 'from Home';
  switch (source.from) {
    case 'node':
      return 'from this node';
    case 'ancestor':
      return `from ${source.title ?? 'a parent'}`;
    case 'project':
      return `from ${source.title !== undefined ? `the project (${source.title})` : 'the project'}`;
    case 'home':
      return 'from Home';
    default:
      return 'built in';
  }
}

// ---------------------------------------------------------------- the pick

/** How a session's pick was made (`agent.pick.how`). */
export const PICK_HOWS = ['explicit', 'kept', 'inherit', 'default', 'rule', 'clamp'] as const;
export const PickHowSchema = z.enum(PICK_HOWS);
export type PickHow = z.infer<typeof PickHowSchema>;

export interface ModelPickTriple {
  vendor: string;
  model: string;
  effort: Effort;
}

export interface ModelPick extends ModelPickTriple {
  how: PickHow;
  /** The route before a clamp changed it (`how: clamp` only). */
  base?: Exclude<PickHow, 'clamp' | 'explicit' | 'kept'>;
  /** How it was picked, in words ("inherited from Billing"). */
  why: string;
  /** What the operator should know: a clamp, or an explicit pick outside the presets. */
  note?: string;
}

/**
 * The node record's `agent.pick`: what its agent's last start ran and why,
 * written by the daemon when the agent starts (design §8).
 */
export const ModelPickRecordSchema = z
  .object({
    vendor: z.string().min(1).max(64),
    model: z.string().min(1).max(SESSION_MODEL_MAX_CHARS),
    effort: EffortSchema.optional(),
    how: PickHowSchema,
    base: PickHowSchema.optional(),
    why: z.string().min(1).max(300),
    note: z.string().min(1).max(500).optional(),
    session: UlidSchema.optional(),
    at: z.string().min(1),
  })
  .strict();
export type ModelPickRecord = z.infer<typeof ModelPickRecordSchema>;

/** One model a vendor offers, as the pick sees it. */
export interface PickCatalogModel {
  value: string;
  name?: string;
}

export interface PickModelInput {
  policy: ModelPolicy;
  /** The operator's pick, resolved (the flags, filled from the defaults). */
  explicit?: ModelPickTriple;
  /** T464: the node's last agent session, when the node has run. */
  kept?: ModelPickTriple;
  /** For `inherit`: the parent node's current pick, and its title for the words. */
  parent?: ModelPickTriple & { title?: string };
  /** `default`: today's resolution (project, repo, home, built-in). */
  fallback: ModelPickTriple;
  /** The vendors installed here. */
  installed: readonly string[];
  /** Each vendor's models (T467's lists); `KNOWN_MODEL_IDS` where none. */
  models?: Readonly<Partial<Record<string, readonly PickCatalogModel[]>>>;
  /** The model profiles (the shipped ones with the home's over them). */
  profiles?: Readonly<Record<string, ModelProfile>>;
  /** The node is in a project: the note says "this project's preset models". */
  inProject?: boolean;
}

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, strongest: 2 };

function effortRank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

/** A model's name for a sentence: its vendor's own, else its id in words ("Claude Sonnet 5.5"). */
export function modelWords(
  vendor: string,
  model: string,
  models?: Readonly<Partial<Record<string, readonly PickCatalogModel[]>>>,
): string {
  const listed = models?.[vendor]?.find((m) => m.value === model)?.name;
  if (listed !== undefined) return listed;
  const bare = model.replace(/\[[^\]]*\]$/, '');
  const vendorName = vendor ? `${vendor[0]?.toUpperCase()}${vendor.slice(1)}` : 'Agent';
  if (bare === '' || bare === 'default') return `${vendorName} default model`;
  const versioned = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(bare);
  const cap = (w: string) => (w ? `${w[0]?.toUpperCase()}${w.slice(1)}` : w);
  if (versioned) {
    const [, family = '', major, minor] = versioned;
    return `Claude ${cap(family)} ${major}${minor !== undefined ? `.${minor}` : ''}`;
  }
  if (vendor === 'claude' && /^(opus|sonnet|haiku|fable)$/.test(bare)) return `Claude ${cap(bare)}`;
  return bare;
}

/** "Claude Sonnet 5.5 · medium" (the effort only for a vendor that uses it). */
export function pickWords(
  pick: Pick<ModelPickTriple, 'vendor' | 'model'> & { effort?: Effort | undefined },
  models?: PickModelInput['models'],
): string {
  const name = modelWords(pick.vendor, pick.model, models);
  return pick.effort !== undefined && vendorTakesEffort(pick.vendor)
    ? `${name} · ${pick.effort}`
    : name;
}

/** The candidates a routed pick may land on: the presets whose vendor is installed, else every model installed. */
export function presetCandidates(
  policy: Pick<ModelPolicy, 'presets'>,
  input: Pick<PickModelInput, 'installed' | 'models'> & { prefer?: string },
): { candidates: PresetModel[]; locked: boolean } {
  const installed = new Set(input.installed);
  const presets = policy.presets.filter((p) => installed.has(p.vendor));
  if (presets.length > 0) return { candidates: presets, locked: true };
  const vendors = [...installed].filter(isSessionVendor);
  // The default's vendor first, so a tie lands where today's default would.
  vendors.sort((a, b) => Number(b === input.prefer) - Number(a === input.prefer));
  const out: PresetModel[] = [];
  const seen = new Set<string>();
  for (const vendor of vendors) {
    const listed = input.models?.[vendor]?.map((m) => m.value);
    const ids = listed !== undefined && listed.length > 0 ? listed : KNOWN_MODEL_IDS[vendor];
    for (const model of ids) {
      if (model === 'default') continue;
      const key = modelKey(vendor, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ vendor: vendor as SessionVendor, model });
    }
  }
  return { candidates: out, locked: false };
}

function inPresets(
  pick: Pick<ModelPickTriple, 'vendor' | 'model'>,
  presets: readonly PresetModel[],
) {
  return presets.some((p) => p.vendor === pick.vendor && p.model === pick.model);
}

function capEffort(effort: Effort, ceiling: Effort): Effort {
  return effortRank(effort) > effortRank(ceiling) ? ceiling : effort;
}

/**
 * §5 "Without Jev": under `start_cheap` the cheapest balanced preset at
 * medium effort (else the cheapest of any tier); under `strongest_first`
 * the strongest (highest tier, then highest cost) at high effort. T483's
 * chooser runs before this, and falls back to it.
 */
export function ruleFallbackPick(
  policy: ModelPolicy,
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
): { vendor: string; model: string; effort: Effort; why: string } | undefined {
  if (candidates.length === 0) return undefined;
  const scored = candidates.map((c, order) => ({
    c,
    order,
    p: profileOf(c.vendor, c.model, profiles),
  }));
  if (policy.escalation === 'strongest_first') {
    const best = [...scored].sort(
      (a, b) =>
        TIER_RANK[b.p.tier] - TIER_RANK[a.p.tier] || b.p.cost - a.p.cost || a.order - b.order,
    )[0];
    if (best === undefined) return undefined;
    return {
      vendor: best.c.vendor,
      model: best.c.model,
      effort: 'high',
      why: 'strongest first: the strongest preset model',
    };
  }
  const cheapest = (rows: typeof scored) =>
    [...rows].sort((a, b) => a.p.cost - b.p.cost || a.order - b.order)[0];
  const balanced = cheapest(scored.filter((s) => s.p.tier === 'balanced'));
  const best = balanced ?? cheapest(scored);
  if (best === undefined) return undefined;
  return {
    vendor: best.c.vendor,
    model: best.c.model,
    effort: 'medium',
    why:
      balanced !== undefined
        ? 'start cheap: the cheapest balanced preset model'
        : 'start cheap: the cheapest preset model (none is balanced)',
  };
}

/** The preset nearest a pick outside them: the same tier first, then the same vendor, then the cost. */
function nearestPreset(
  pick: Pick<ModelPickTriple, 'vendor' | 'model'>,
  presets: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
): PresetModel | undefined {
  const want = profileOf(pick.vendor, pick.model, profiles);
  return presets
    .map((p, order) => ({ p, order, prof: profileOf(p.vendor, p.model, profiles) }))
    .sort(
      (a, b) =>
        Math.abs(TIER_RANK[a.prof.tier] - TIER_RANK[want.tier]) -
          Math.abs(TIER_RANK[b.prof.tier] - TIER_RANK[want.tier]) ||
        Number(a.p.vendor !== pick.vendor) - Number(b.p.vendor !== pick.vendor) ||
        Math.abs(a.prof.cost - want.cost) - Math.abs(b.prof.cost - want.cost) ||
        a.order - b.order,
    )[0]?.p;
}

/**
 * §4's precedence, whole:
 *
 * 1. an explicit pick wins, never clamped; outside the presets, a note says
 *    it runs as picked (D53, never as refused);
 * 2. the node's kept last pick (T464) holds;
 * 3. (T483: pinned rules);
 * 4. the mode: `inherit` copies the parent's current pick, `default`
 *    resolves as today, `choose` uses the rule fallback until T483's chooser;
 * 5. every routed pick is clamped into the presets and under the effort
 *    ceiling; a clamp that changed something says so.
 */
export function pickModel(input: PickModelInput): ModelPick {
  const { policy } = input;
  const profiles = input.profiles ?? DEFAULT_MODEL_PROFILES;
  const words = (p: Pick<ModelPickTriple, 'vendor' | 'model'> & { effort?: Effort }) =>
    pickWords(p, input.models);
  const { candidates, locked } = presetCandidates(policy, {
    installed: input.installed,
    ...(input.models !== undefined ? { models: input.models } : {}),
    prefer: input.fallback.vendor,
  });

  if (input.explicit !== undefined) {
    const e = input.explicit;
    const outside = policy.presets.length > 0 && !inPresets(e, policy.presets);
    return {
      ...e,
      how: 'explicit',
      why: 'your pick',
      ...(outside
        ? {
            note: `Running ${modelWords(e.vendor, e.model, input.models)}, as you picked. Routed picks here use ${
              input.inProject === true ? 'this project’s' : 'your'
            } preset models.`,
          }
        : {}),
    };
  }
  if (input.kept !== undefined) {
    return { ...input.kept, how: 'kept', why: 'kept from its last run' };
  }

  let base: { vendor: string; model: string; effort: Effort; why: string };
  let how: Exclude<PickHow, 'clamp' | 'explicit' | 'kept'>;
  let extra: string | undefined;
  if (policy.mode === 'inherit' && input.parent !== undefined) {
    const { title, ...parent } = input.parent;
    base = { ...parent, why: `inherited from ${title ?? 'its parent'}` };
    how = 'inherit';
  } else if (policy.mode === 'choose') {
    const ruled = ruleFallbackPick(policy, candidates, profiles);
    if (ruled !== undefined) {
      base = { ...ruled, why: `${ruled.why} (no chooser yet)` };
      how = 'rule';
    } else {
      base = { ...input.fallback, why: 'the Default setting (no model to choose from)' };
      how = 'default';
    }
  } else {
    base = { ...input.fallback, why: 'the Default setting' };
    how = 'default';
    if (policy.mode === 'inherit') extra = 'its parent has no model yet, so it used Default';
  }

  // 5. The clamp.
  const changes: string[] = [];
  let { vendor, model, effort } = base;
  if (locked && !inPresets({ vendor, model }, candidates)) {
    const near = nearestPreset({ vendor, model }, candidates, profiles);
    if (near !== undefined) {
      changes.push(`${words({ vendor, model })} isn’t a preset model, so ${words(near)} instead`);
      vendor = near.vendor;
      model = near.model;
    }
  }
  const capped = capEffort(effort, policy.effort_ceiling);
  if (capped !== effort && vendorTakesEffort(vendor)) {
    changes.push(`effort ${effort} is over the ceiling, so ${capped}`);
  }
  effort = capped;
  const notes = [extra, ...changes].filter((n): n is string => n !== undefined);
  const note = notes.length > 0 ? `${notes.join('; ')}.` : undefined;
  const why = note !== undefined ? note.charAt(0).toUpperCase() + note.slice(1) : undefined;
  if (changes.length > 0) {
    return {
      vendor,
      model,
      effort,
      how: 'clamp',
      base: how,
      why: `${base.why}, clamped`,
      ...(why !== undefined ? { note: why } : {}),
    };
  }
  return { vendor, model, effort, how, why: base.why, ...(why !== undefined ? { note: why } : {}) };
}

/** The thread line a routed start writes: "Model: Claude Sonnet 5.5 · medium — inherited from Billing". */
export function routedPickLine(pick: ModelPick, models?: PickModelInput['models']): string {
  const line = `Model: ${pickWords(pick, models)} — ${pick.why}`;
  return pick.note !== undefined ? `${line}. ${pick.note}` : line;
}
