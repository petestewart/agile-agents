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
  SESSION_VENDORS,
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

/**
 * A pinned rule: *when* (a role, a label or a topic; at least one) → *pick*.
 * T483 applies them. T490: the pick may name only a vendor ("reviewer →
 * Codex"); the tier then comes from Jev or the rule, inside that vendor's
 * preset models.
 */
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
        model: z.string().trim().min(1).max(SESSION_MODEL_MAX_CHARS).optional(),
        effort: EffortSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type PinnedRule = z.infer<typeof PinnedRuleSchema>;

/**
 * T490 (D59): the vendors to prefer, in order, when two preset models tie on
 * the tier. Empty: no preference. A vendor may appear once.
 */
export const VendorOrderSchema = z
  .array(SessionVendorSchema)
  .max(SESSION_VENDORS.length)
  .refine((list) => new Set(list).size === list.length, {
    message: 'a vendor order names each vendor once',
  });
export type VendorOrder = z.infer<typeof VendorOrderSchema>;

/** T490 (D59): the roles that may have their own vendor order. */
export const VENDOR_ORDER_ROLES = ['worker', 'coordinator', 'conversation', 'reviewer'] as const;
export type VendorOrderRole = (typeof VENDOR_ORDER_ROLES)[number];

/**
 * T490 (D59): a role's own vendor order, over `vendor_order` for that role
 * ("reviews prefer Codex, code prefers Claude"). A role left out uses
 * `vendor_order`.
 */
export const VendorOrderByRoleSchema = z
  .object({
    worker: VendorOrderSchema.optional(),
    coordinator: VendorOrderSchema.optional(),
    conversation: VendorOrderSchema.optional(),
    reviewer: VendorOrderSchema.optional(),
  })
  .strict();
export type VendorOrderByRole = z.infer<typeof VendorOrderByRoleSchema>;

const fields = {
  mode: ModelPolicyModeSchema,
  quality: z.number().int().min(0).max(100),
  presets: z.array(PresetModelSchema).max(PRESET_MODELS_MAX),
  vendor_order: VendorOrderSchema,
  vendor_order_by_role: VendorOrderByRoleSchema,
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
  'vendor_order',
  'vendor_order_by_role',
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
    vendor_order: fields.vendor_order.nullable().optional(),
    vendor_order_by_role: fields.vendor_order_by_role.nullable().optional(),
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
  vendor_order: [],
  vendor_order_by_role: {},
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
    vendor_order: [],
    vendor_order_by_role: {},
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

// ---------------------------------------------------------------- the chooser's reading (T483)

/** §5's `topic` question: a pinned rule's topics, or none of them. */
export const CHOOSER_TOPICS = [...PINNED_RULE_TOPICS, 'none'] as const;
export const ChooserTopicSchema = z.enum(CHOOSER_TOPICS);
export type ChooserTopic = z.infer<typeof ChooserTopicSchema>;

/** One criterion's score: the probability-weighted mean of its options, 1–5. */
const ScoreSchema = z.number().min(1).max(5);

/** §5's five scores. */
export const ChooserScoresSchema = z
  .object({
    clarity: ScoreSchema,
    verifiability: ScoreSchema,
    horizon: ScoreSchema,
    stakes: ScoreSchema,
    volume: ScoreSchema,
  })
  .strict();
export type ChooserScores = z.infer<typeof ChooserScoresSchema>;

/** D52: Jev's choice (T490: its `tier`) decides from this confidence up; below it, the rule over the scores. */
export const CHOOSER_CONFIDENCE_MIN = 0.5;

/** What one chooser call read. `scores` and `tier` are absent on a topic-only call. */
export interface ChooserReading {
  scores?: ChooserScores;
  topic: ChooserTopic;
  /** T490 (D57): Jev's `tier` choice and its confidence, 0–1 (absent when it wasn't asked). */
  tier?: { tier: ModelTier; confidence: number };
  /** Jev's `effort` choice, when it was asked. */
  effort?: { level: Effort; confidence: number };
}

/** Why there is no reading: no key (or the tier is off), or the call failed (401, 429, timeout, a bad reply). */
export const CHOOSER_FAILURES = ['no_key', 'no_answer'] as const;
export type ChooserFailure = (typeof CHOOSER_FAILURES)[number];

/** The chat line's words for a failure (§5 "Without Jev"). */
export const CHOOSER_FAILURE_WORDS: Record<ChooserFailure, string> = {
  no_key: 'no classifier key',
  no_answer: 'Jev didn’t answer',
};

/** The chooser's outcome for one start: a reading, or why there is none. */
export type ChooserOutcome =
  | { ok: true; reading: ChooserReading }
  | { ok: false; reason: ChooserFailure; detail?: string };

/** The role a pinned rule matches: the node's agent's, or a reviewer's. */
export type PinnedRole = (typeof PINNED_RULE_ROLES)[number];

/** What the pinned rules look at, besides the chooser's topic. */
export interface PickTask {
  role?: PinnedRole;
  labels?: readonly string[];
}

function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A rule's role and label (not its topic) match the task. A rule naming `reviewer` matches only a reviewer. */
function staticMatch(rule: PinnedRule, task: PickTask): boolean {
  const { role, label } = rule.when;
  if (role !== undefined && role !== task.role) return false;
  if (role === undefined && task.role === 'reviewer') return false;
  if (label !== undefined && !(task.labels ?? []).some((l) => sameLabel(l, label))) return false;
  return true;
}

/**
 * T490: a rule that names only a vendor matches only where that vendor has
 * a model to pick (`vendors`: the vendors of the candidates). With no
 * `vendors` given, it is not checked.
 */
function vendorAvailable(rule: PinnedRule, vendors: readonly string[] | undefined): boolean {
  return (
    rule.pick.model !== undefined || vendors === undefined || vendors.includes(rule.pick.vendor)
  );
}

/**
 * §4 step 3: the first pinned rule that matches, in order. Every field a
 * rule's `when` names must match (a role, a label, the chooser's topic). A
 * topic rule needs the chooser's topic; with none it doesn't match. T490: a
 * rule naming only a vendor doesn't match when that vendor has no preset
 * model among `vendors`.
 */
export function matchPinnedRule(
  rules: readonly PinnedRule[],
  task: PickTask,
  topic?: ChooserTopic,
  vendors?: readonly string[],
): { rule: PinnedRule; index: number } | undefined {
  for (const [index, rule] of rules.entries()) {
    if (!staticMatch(rule, task)) continue;
    if (rule.when.topic !== undefined && rule.when.topic !== topic) continue;
    if (!vendorAvailable(rule, vendors)) continue;
    return { rule, index };
  }
  return undefined;
}

/** T490: the first vendor-only rule that would have matched but for its vendor having no preset model. */
function skippedVendorRule(
  rules: readonly PinnedRule[],
  task: PickTask,
  topic: ChooserTopic | undefined,
  vendors: readonly string[],
  before: number,
): PinnedRule | undefined {
  for (const [index, rule] of rules.entries()) {
    if (index >= before) break;
    if (!staticMatch(rule, task)) continue;
    if (rule.when.topic !== undefined && rule.when.topic !== topic) continue;
    if (!vendorAvailable(rule, vendors)) return rule;
  }
  return undefined;
}

/**
 * What a routed start needs from Jev: nothing (a role or label rule that
 * names a model decides first, or the mode isn't Choose and no rule names a
 * topic), only the `topic` (a topic rule under Inherit or Default), or the
 * whole reading. T490: a rule that names only a vendor needs the whole
 * reading (its tier comes from Jev), and a reviewer is routed like any
 * other start.
 */
export function chooserNeed(
  policy: Pick<ModelPolicy, 'mode' | 'pinned_rules'>,
  task: PickTask,
  vendors?: readonly string[],
): 'none' | 'topic' | 'full' {
  let topic = false;
  let vendorOnly = false;
  for (const rule of policy.pinned_rules) {
    if (!staticMatch(rule, task)) continue;
    if (!vendorAvailable(rule, vendors)) continue;
    const onlyVendor = rule.pick.model === undefined;
    if (rule.when.topic === undefined) {
      // This rule decides unless an earlier topic rule does.
      if (!topic) return onlyVendor ? 'full' : 'none';
      if (onlyVendor) vendorOnly = true;
      break;
    }
    topic = true;
    if (onlyVendor) vendorOnly = true;
  }
  if (policy.mode === 'choose' || vendorOnly) return 'full';
  return topic ? 'topic' : 'none';
}

/** A pinned rule's `when` in words: "coordinator", "label billing", "security work". */
export function pinnedWhenWords(when: PinnedRule['when']): string {
  const parts: string[] = [];
  if (when.role !== undefined) parts.push(when.role);
  if (when.label !== undefined) parts.push(`label ${when.label}`);
  if (when.topic !== undefined) parts.push(`${when.topic} work`);
  return parts.join(', ');
}

/** A vendor's name for a sentence: `claude` → "Claude", `codex` → "Codex". */
export function vendorWords(vendor: string): string {
  return vendor ? `${vendor[0]?.toUpperCase()}${vendor.slice(1)}` : 'Agent';
}

/** "Codex", "Codex and Gemini", "Codex, Gemini and Pi". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * T490 (D59): the vendor order for a role: the role's own when it has one,
 * else the policy's `vendor_order`. Empty: no preference.
 */
export function vendorOrderFor(
  policy: Partial<Pick<ModelPolicy, 'vendor_order' | 'vendor_order_by_role'>>,
  role?: PinnedRole,
): readonly string[] {
  const own = role !== undefined ? policy.vendor_order_by_role?.[role] : undefined;
  return own ?? policy.vendor_order ?? [];
}

/** A vendor order in words: "Claude, then Codex", or "no preference". */
export function vendorOrderWords(order: readonly string[]): string {
  return order.length === 0 ? 'no preference' : order.map(vendorWords).join(', then ');
}

/**
 * A criterion's score after its weight (§3, 0–3): the distance from the
 * middle (3) counts `weight` times, kept within 1–5. A weight of 0 leaves
 * the criterion out (`undefined`).
 */
export function weightedScore(score: number, weight: number): number | undefined {
  if (weight <= 0) return undefined;
  return Math.min(5, Math.max(1, 3 + (score - 3) * weight));
}

/** §5's bar for "well specified" and "checkable": 3 toward speed, 4 toward quality. */
export function scoreBar(quality: number): number {
  return 3 + Math.min(100, Math.max(0, quality)) / 100;
}

/** What the scores say, after the weights and the quality priority. */
export interface ScoreReading {
  tier: ModelTier;
  /** Long-horizon or high-stakes: effort goes one level up. */
  stepUp: boolean;
}

/**
 * §5's default rule over the scores: a balanced model when the task is well
 * specified and checkable (each at least the bar); the strongest when it's
 * ambiguous, high-stakes or long-horizon; the fastest when it's also one of
 * many similar parts. The bar moves with the quality priority.
 */
export function readScores(
  scores: ChooserScores,
  policy: Pick<ModelPolicy, 'quality' | 'weights'>,
): ScoreReading {
  const w = (c: RoutingCriterion) => weightedScore(scores[c], policy.weights[c]);
  const bar = scoreBar(policy.quality);
  const clarity = w('clarity');
  const verifiability = w('verifiability');
  const horizon = w('horizon');
  const stakes = w('stakes');
  const volume = w('volume');
  const high = (v: number | undefined) => v !== undefined && v >= 4;
  const stepUp = high(horizon) || high(stakes);
  const clear = clarity === undefined || clarity >= bar;
  const checkable = verifiability === undefined || verifiability >= bar;
  if (!clear || !checkable || stepUp) return { tier: 'strongest', stepUp };
  return { tier: high(volume) ? 'fast' : 'balanced', stepUp };
}

function oneUp(effort: Effort): Effort {
  return EFFORT_LEVELS[Math.min(EFFORT_LEVELS.length - 1, effortRank(effort) + 1)] ?? effort;
}

/** The scores' effort: medium, one level up for long-horizon or high-stakes work (the clamp caps it). */
export function scoresEffort(reading: ScoreReading): Effort {
  return reading.stepUp ? oneUp('medium') : 'medium';
}

const TIER_SEARCH: Record<ModelTier, readonly ModelTier[]> = {
  strongest: ['strongest', 'balanced', 'fast'],
  balanced: ['balanced', 'strongest', 'fast'],
  fast: ['fast', 'balanced', 'strongest'],
};

/** T490 (D59): what picked the model inside its tier. */
export const IN_TIER_BYS = ['only', 'vendor_order', 'cost', 'listed'] as const;
export type InTierBy = (typeof IN_TIER_BYS)[number];

/** T490 (D59): the model inside a tier, and why that one. */
export interface TierChoice {
  preset: PresetModel;
  /** The tier asked for. */
  wanted: ModelTier;
  /** The tier it landed in: the wanted one, else the nearest with a preset model. */
  tier: ModelTier;
  by: InTierBy;
  /** Why this model in the tier: "Claude before Codex", "the cheapest balanced preset model". */
  words?: string;
}

/**
 * T490 (D57, D59): the model inside a tier: the candidates in that tier by
 * the vendor order (a vendor it names first, in its order; the others after,
 * as equals), then the lowest cost (`costliest`: the highest, Strongest
 * first's "the strongest preset model"), then the order they're listed in.
 * A tier with no candidate falls back to the nearest tier that has one.
 * `undefined` with no candidates.
 */
export function modelForTier(
  tier: ModelTier,
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
  options: { vendorOrder?: readonly string[]; costliest?: boolean } = {},
): TierChoice | undefined {
  const order = options.vendorOrder ?? [];
  const rank = (vendor: string) => {
    const at = order.indexOf(vendor);
    return at < 0 ? order.length : at;
  };
  const rows = candidates.map((c, listed) => ({
    c,
    listed,
    rank: rank(c.vendor),
    p: profileOf(c.vendor, c.model, profiles),
  }));
  const byCost = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    options.costliest === true ? b.p.cost - a.p.cost : a.p.cost - b.p.cost;
  for (const want of TIER_SEARCH[tier]) {
    const inTier = rows.filter((r) => r.p.tier === want);
    const best = [...inTier].sort(
      (a, b) => a.rank - b.rank || byCost(a, b) || a.listed - b.listed,
    )[0];
    if (best === undefined) continue;
    const rivals = inTier.filter((r) => r !== best);
    const later = rivals.filter((r) => r.rank > best.rank).sort((a, b) => a.rank - b.rank);
    let by: InTierBy;
    let words: string | undefined;
    if (rivals.length === 0) {
      by = 'only';
    } else if (later.length > 0) {
      by = 'vendor_order';
      const others = [...new Set(later.map((r) => r.c.vendor))].map(vendorWords);
      words = `${vendorWords(best.c.vendor)} before ${andList(others)}`;
    } else if (rivals.some((r) => r.p.cost !== best.p.cost)) {
      by = 'cost';
      words =
        options.costliest === true
          ? `the most capable ${want} preset model`
          : `the cheapest ${want} preset model`;
    } else {
      by = 'listed';
      // Only worth saying when vendors tied: one vendor's equal models are just its list.
      if (new Set(inTier.map((r) => r.c.vendor)).size > 1) {
        words =
          order.length === 0
            ? 'no vendor preferred, so the one listed first'
            : 'the vendor order doesn’t tell them apart, so the one listed first';
      }
    }
    return {
      preset: best.c,
      wanted: tier,
      tier: want,
      by,
      ...(words !== undefined ? { words } : {}),
    };
  }
  return undefined;
}

/** T490: the tiers the candidates have, fast to strongest. */
export function tiersPresent(
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
): ModelTier[] {
  const have = new Set(candidates.map((c) => profileOf(c.vendor, c.model, profiles).tier));
  return MODEL_TIERS.filter((t) => have.has(t));
}

/** T490 (D57): the tier §5's rule gives from the scores (the tier first; the model inside it is `modelForTier`). */
export function scoresTier(
  scores: ChooserScores,
  policy: Pick<ModelPolicy, 'quality' | 'weights'>,
): ModelTier {
  return readScores(scores, policy).tier;
}

/**
 * §5 step 3, the rule fallback with scores: the tier the scores call for
 * (T490: first), the model inside it by the vendor order then cost, and the
 * scores' effort. `undefined` with no candidates.
 */
export function scoresRulePick(
  policy: ModelPolicy,
  scores: ChooserScores,
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
  vendorOrder: readonly string[] = [],
):
  | { vendor: string; model: string; effort: Effort; tier: ModelTier; choice: TierChoice }
  | undefined {
  const reading = readScores(scores, policy);
  const choice = modelForTier(reading.tier, candidates, profiles, { vendorOrder });
  if (choice === undefined) return undefined;
  return {
    vendor: choice.preset.vendor,
    model: choice.preset.model,
    effort: scoresEffort(reading),
    tier: reading.tier,
    choice,
  };
}

function band(score: number): 'low' | 'mid' | 'high' {
  if (score >= 3.75) return 'high';
  if (score <= 2.25) return 'low';
  return 'mid';
}

/**
 * The scores in words, never numbers or ids: "well specified and covered by
 * tests; short, low stakes". A topic other than none is named.
 */
export function scoresWords(scores: ChooserScores, topic?: ChooserTopic): string {
  const clarity = { high: 'well specified', mid: 'partly specified', low: 'open-ended' }[
    band(scores.clarity)
  ];
  const checks = {
    high: 'covered by tests',
    mid: 'partly checkable',
    low: 'hard to check',
  }[band(scores.verifiability)];
  const horizon = { low: 'short', mid: 'medium length', high: 'long' }[band(scores.horizon)];
  const stakes = { low: 'low stakes', mid: 'moderate stakes', high: 'high stakes' }[
    band(scores.stakes)
  ];
  const parts = [`${clarity} and ${checks}`, `${horizon}, ${stakes}`];
  if (band(scores.volume) === 'high') parts.push('one of many similar parts');
  if (topic !== undefined && topic !== 'none') parts.push(`touches ${topic}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------- the pick

/**
 * How a session's pick was made (`agent.pick.how`). T483: `pinned` (a
 * pinned rule), `jev` (the chooser's model choice, confident), `scores`
 * (Jev wasn't sure: the rule over its scores); `rule` is the rule with no
 * scores (no key, no answer) or Strongest first.
 */
export const PICK_HOWS = [
  'explicit',
  'kept',
  'inherit',
  'default',
  'rule',
  'clamp',
  'pinned',
  'jev',
  'scores',
  'escalation',
] as const;
export const PickHowSchema = z.enum(PICK_HOWS);
export type PickHow = z.infer<typeof PickHowSchema>;

export interface ModelPickTriple {
  vendor: string;
  model: string;
  effort: Effort;
}

/**
 * T490 (D57): how the tier was decided: Jev's `tier` choice (confident), the
 * rule over its scores (Jev wasn't sure), the rule with no scores (no key,
 * no answer, Strongest first), a pinned rule's model, or the only tier the
 * preset models have.
 */
export const TIER_BYS = ['jev', 'scores', 'rule', 'pinned', 'only'] as const;
export const TierBySchema = z.enum(TIER_BYS);
export type TierBy = z.infer<typeof TierBySchema>;

/** T490: why this model inside its tier (the vendor order, the cost), recorded with the pick. */
export const InTierSchema = z
  .object({
    by: z.enum(IN_TIER_BYS),
    words: z.string().min(1).max(200).optional(),
  })
  .strict();
export type InTier = z.infer<typeof InTierSchema>;

export interface ModelPick extends ModelPickTriple {
  how: PickHow;
  /** The route before a clamp changed it (`how: clamp` only). */
  base?: Exclude<PickHow, 'clamp' | 'explicit' | 'kept'>;
  /** How it was picked, in words ("inherited from Billing"). */
  why: string;
  /** What the operator should know: a clamp, or an explicit pick outside the presets. */
  note?: string;
  /**
   * T483: a preview only (`next_pick`): the start will ask Jev, so this is
   * the pick without it (no key, no answer), not the one that will run.
   */
  chooses?: true;
  /** T483: the chooser's scores and topic, when it read the task; T490: Jev's confidence in its tier. */
  scores?: ChooserScores;
  topic?: ChooserTopic;
  confidence?: number;
  /** T490 (D57): the tier decided, how, and why this model inside it (D59). */
  tier?: ModelTier;
  tier_by?: TierBy;
  in_tier?: InTier;
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
    /** T483: the chooser's reading: the five scores, the topic; T490: Jev's confidence in its tier. */
    scores: ChooserScoresSchema.optional(),
    topic: ChooserTopicSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** T490 (D57, D59): the tier decided, how it was decided, and why this model in it. */
    tier: ModelTierSchema.optional(),
    tier_by: TierBySchema.optional(),
    in_tier: InTierSchema.optional(),
    session: UlidSchema.optional(),
    at: z.string().min(1),
  })
  .strict();
export type ModelPickRecord = z.infer<typeof ModelPickRecordSchema>;

/** One model a vendor offers, as the pick sees it. */
export interface PickCatalogModel {
  value: string;
  name?: string;
  /** The vendor's own words for it (T467), for the chooser. */
  description?: string;
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
  /** T483: what the pinned rules look at (the role, the labels). */
  task?: PickTask;
  /**
   * T483: the chooser's outcome for this start (a reading, or why none).
   * Absent: no chooser was asked (a preview), and Choose reads as the rule.
   */
  chooser?: ChooserOutcome;
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

/** T490: a tier route's pick: the model, its effort, the words, and how the tier was decided. */
export interface TierPick {
  vendor: string;
  model: string;
  effort: Effort;
  why: string;
  how: 'jev' | 'scores' | 'rule';
  tier: ModelTier;
  tier_by: TierBy;
  in_tier: InTier;
}

function joined(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== '').join('; ');
}

/** The nearest-tier fallback in words, when the tier has no preset model. */
function nearestWords(choice: TierChoice): string | undefined {
  return choice.tier !== choice.wanted
    ? `no ${choice.wanted} preset model, so ${choice.tier}`
    : undefined;
}

export interface TierPickInput {
  policy: ModelPolicy;
  candidates: readonly PresetModel[];
  profiles: Readonly<Record<string, ModelProfile>>;
  /** The vendor order for the start's role (D59). */
  vendorOrder?: readonly string[];
  /** The chooser's outcome; absent: no chooser was asked (a preview). */
  chooser?: ChooserOutcome;
}

/**
 * T490 (D57, D59): Choose's pick, tier first. Strongest first: the highest
 * tier. Else, with Jev's reading: its `tier` when its confidence is at least
 * 0.5 (its effort too); the only tier when the presets have one; else the
 * rule over the scores. With no reading (no key, no answer): §5's "Without
 * Jev" rule as a tier (balanced, else the cheapest tier). Then the model
 * inside the tier by the vendor order, then cost (`modelForTier`).
 * `undefined` with no candidates.
 */
export function tierPick(input: TierPickInput): TierPick | undefined {
  const { policy, candidates, profiles } = input;
  const vendorOrder = input.vendorOrder ?? [];
  const present = tiersPresent(candidates, profiles);
  if (present.length === 0) return undefined;
  const reading = input.chooser?.ok === true ? input.chooser.reading : undefined;
  const scores = reading?.scores;
  const reason =
    input.chooser === undefined
      ? 'without Jev'
      : input.chooser.ok
        ? 'Jev didn’t score it'
        : CHOOSER_FAILURE_WORDS[input.chooser.reason];
  const effortSure =
    reading?.effort !== undefined && reading.effort.confidence >= CHOOSER_CONFIDENCE_MIN
      ? reading.effort.level
      : undefined;
  const result = (
    tier: ModelTier,
    choice: TierChoice,
    effort: Effort,
    head: string,
    how: TierPick['how'],
    tier_by: TierBy,
    inTierWords: string | undefined = choice.words,
  ): TierPick => ({
    vendor: choice.preset.vendor,
    model: choice.preset.model,
    effort,
    why: joined([head, nearestWords(choice), inTierWords]),
    how,
    tier,
    tier_by,
    in_tier: { by: choice.by, ...(choice.words !== undefined ? { words: choice.words } : {}) },
  });

  if (policy.escalation === 'strongest_first') {
    // §3: the strongest preset model; the vendor order first, then the most capable.
    const top = present.at(-1) as ModelTier;
    const choice = modelForTier(top, candidates, profiles, { vendorOrder, costliest: true });
    if (choice === undefined) return undefined;
    const head =
      scores !== undefined
        ? `strongest first: the strongest preset model; ${scoresWords(scores, reading?.topic)}`
        : `strongest first: the strongest preset model (${reason})`;
    return result(
      top,
      choice,
      scores !== undefined ? (effortSure ?? 'high') : 'high',
      head,
      'rule',
      'rule',
      choice.by === 'cost' ? undefined : choice.words,
    );
  }

  if (scores !== undefined) {
    const words = scoresWords(scores, reading?.topic);
    const byScores = readScores(scores, policy);
    const jev = reading?.tier;
    let tier: ModelTier;
    let head: string;
    let how: TierPick['how'];
    let tierBy: TierBy;
    let effort: Effort;
    if (jev !== undefined && jev.confidence >= CHOOSER_CONFIDENCE_MIN) {
      tier = jev.tier;
      head = `${tier} (Jev ${jev.confidence.toFixed(2)}): ${words}`;
      how = 'jev';
      tierBy = 'jev';
      effort = reading?.effort?.level ?? scoresEffort(byScores);
    } else if (jev === undefined && present.length === 1) {
      tier = present[0] as ModelTier;
      head = `${tier}, the only tier in the preset models: ${words}`;
      how = 'scores';
      tierBy = 'only';
      effort = effortSure ?? scoresEffort(byScores);
    } else {
      tier = byScores.tier;
      head =
        jev !== undefined
          ? `Jev wasn’t sure (${jev.confidence.toFixed(2)}), so ${tier} by the scores: ${words}`
          : `${tier} by the scores: ${words}`;
      how = 'scores';
      tierBy = 'scores';
      effort = scoresEffort(byScores);
    }
    const choice = modelForTier(tier, candidates, profiles, { vendorOrder });
    if (choice === undefined) return undefined;
    return result(tier, choice, effort, head, how, tierBy);
  }

  // §5 "Without Jev", as a tier: balanced, else the tier of the cheapest candidate.
  let tier: ModelTier = 'balanced';
  if (!present.includes('balanced')) {
    const cheapest = [...candidates]
      .map((c, listed) => ({ listed, p: profileOf(c.vendor, c.model, profiles) }))
      .sort((a, b) => a.p.cost - b.p.cost || a.listed - b.listed)[0];
    tier = cheapest?.p.tier ?? (present[0] as ModelTier);
  }
  const choice = modelForTier(tier, candidates, profiles, { vendorOrder });
  if (choice === undefined) return undefined;
  const head =
    tier === 'balanced'
      ? `start cheap: balanced (${reason})`
      : `start cheap: ${tier}, the cheapest tier, as none is balanced (${reason})`;
  return result(tier, choice, 'medium', head, 'rule', 'rule');
}

/**
 * §5 "Without Jev": under `start_cheap` a balanced preset at medium effort
 * (else one of the cheapest tier); under `strongest_first` the strongest
 * (highest tier, then the most capable) at high effort. T490: inside the
 * tier, the vendor order first, then cost. The chooser runs before this,
 * and falls back to it.
 */
export function ruleFallbackPick(
  policy: ModelPolicy,
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
  vendorOrder: readonly string[] = [],
): TierPick | undefined {
  return tierPick({ policy, candidates, profiles, vendorOrder });
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
 * 3. the pinned rules, in order (the role, the labels, the chooser's topic);
 *    (T490: a rule naming only a vendor takes the tier from Jev or the rule,
 *    inside that vendor's preset models; one whose vendor has none doesn't
 *    apply, and the note says so);
 * 4. the mode: `inherit` copies the parent's current pick, `default`
 *    resolves as today, `choose` is §5, tier first (T490, D57): Jev's tier
 *    when its confidence is at least 0.5 (its effort too), else the rule
 *    over its scores, else (no key, no answer) the rule without scores; the
 *    model inside the tier by the role's vendor order, then cost (D59);
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
  let tiered: Pick<ModelPick, 'tier' | 'tier_by' | 'in_tier'> = {};
  const reading = input.chooser?.ok === true ? input.chooser.reading : undefined;
  const read: Pick<ModelPick, 'scores' | 'topic' | 'confidence'> = {
    ...(reading?.scores !== undefined ? { scores: reading.scores } : {}),
    ...(reading !== undefined ? { topic: reading.topic } : {}),
    ...(reading?.tier !== undefined ? { confidence: reading.tier.confidence } : {}),
  };
  const task = input.task ?? {};
  // T490 (D59): the role's vendor order breaks ties inside a tier.
  const vendorOrder = vendorOrderFor(policy, task.role);
  const vendors = [...new Set(candidates.map((c) => c.vendor))];
  const pinned = matchPinnedRule(policy.pinned_rules, task, reading?.topic, vendors);
  const skipped = skippedVendorRule(
    policy.pinned_rules,
    task,
    reading?.topic,
    vendors,
    pinned?.index ?? policy.pinned_rules.length,
  );
  const notes: string[] = [];
  if (skipped !== undefined) {
    notes.push(
      `the pinned rule for ${pinnedWhenWords(skipped.when)} names ${vendorWords(
        skipped.pick.vendor,
      )}, which has no preset model here, so it didn’t apply`,
    );
  }
  const tierInfo = (t: TierPick): Pick<ModelPick, 'tier' | 'tier_by' | 'in_tier'> => ({
    tier: t.tier,
    tier_by: t.tier_by,
    in_tier: t.in_tier,
  });
  const pinnedModel = pinned?.rule.pick.model;
  const pinnedOwn =
    pinned !== undefined && pinnedModel === undefined
      ? tierPick({
          policy,
          candidates: candidates.filter((c) => c.vendor === pinned.rule.pick.vendor),
          profiles,
          vendorOrder: [pinned.rule.pick.vendor],
          ...(input.chooser !== undefined ? { chooser: input.chooser } : {}),
        })
      : undefined;
  if (pinned !== undefined && pinnedModel !== undefined) {
    const { vendor, effort } = pinned.rule.pick;
    base = {
      vendor,
      model: pinnedModel,
      effort: effort ?? 'medium',
      why: `pinned rule: ${pinnedWhenWords(pinned.rule.when)}`,
    };
    how = 'pinned';
    tiered = { tier: profileOf(vendor, pinnedModel, profiles).tier, tier_by: 'pinned' };
  } else if (pinned !== undefined && pinnedOwn !== undefined) {
    // T490: a rule naming only a vendor: the tier from Jev or the rule, in that vendor's models.
    base = {
      vendor: pinnedOwn.vendor,
      model: pinnedOwn.model,
      effort: pinned.rule.pick.effort ?? pinnedOwn.effort,
      why: `pinned rule: ${pinnedWhenWords(pinned.rule.when)} → ${vendorWords(
        pinned.rule.pick.vendor,
      )}; ${pinnedOwn.why}`,
    };
    how = 'pinned';
    tiered = tierInfo(pinnedOwn);
  } else if (policy.mode === 'inherit' && input.parent !== undefined) {
    const { title, ...parent } = input.parent;
    base = { ...parent, why: `inherited from ${title ?? 'its parent'}` };
    how = 'inherit';
  } else if (policy.mode === 'choose') {
    const picked = tierPick({
      policy,
      candidates,
      profiles,
      vendorOrder,
      ...(input.chooser !== undefined ? { chooser: input.chooser } : {}),
    });
    if (picked === undefined) {
      base = { ...input.fallback, why: 'the Default setting (no model to choose from)' };
      how = 'default';
    } else {
      base = { vendor: picked.vendor, model: picked.model, effort: picked.effort, why: picked.why };
      how = picked.how;
      tiered = tierInfo(picked);
    }
  } else {
    base = { ...input.fallback, why: 'the Default setting' };
    how = 'default';
    if (policy.mode === 'inherit') extra = 'its parent has no model yet, so it used Default';
  }
  if (extra !== undefined) notes.unshift(extra);

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
  notes.push(...changes);
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
      ...read,
      ...tiered,
    };
  }
  return {
    vendor,
    model,
    effort,
    how,
    why: base.why,
    ...(why !== undefined ? { note: why } : {}),
    ...read,
    ...tiered,
  };
}

/** `claude/claude-sonnet-5-5` → its vendor and model; `undefined` when it isn't one. */
export function splitModelKey(key: string): { vendor: string; model: string } | undefined {
  if (!MODEL_KEY_PATTERN.test(key)) return undefined;
  const at = key.indexOf('/');
  const vendor = key.slice(0, at);
  if (!isSessionVendor(vendor)) return undefined;
  return { vendor, model: key.slice(at + 1) };
}

/** The thread line a routed start writes: "Model: Claude Sonnet 5.5 · medium — inherited from Billing". */
export function routedPickLine(pick: ModelPick, models?: PickModelInput['models']): string {
  const line = `Model: ${pickWords(pick, models)} — ${pick.why}`;
  return pick.note !== undefined ? `${line}. ${pick.note}` : line;
}
