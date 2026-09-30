/**
 * T482 (design/model-routing.md §3–§4): model choice in the cockpit, the
 * pure half. The words for each setting, where a value comes from, the
 * preset models as a set, and how a node's model was picked. The components
 * are in `components/ModelPolicy.tsx`.
 *
 * The set is always **preset models** (D53), never "allowed": an explicit
 * pick outside it runs.
 */

import {
  CHOOSER_CONFIDENCE_MIN,
  type ChooserScores,
  type Effort,
  type ModelEscalation,
  type ModelPickRecord,
  type ModelPolicyField,
  type ModelPolicyMode,
  type ModelPolicyPartial,
  type ModelProfile,
  type PickHow,
  type PinnedRule,
  type PresetModel,
  ROUTING_CRITERIA,
  type ResolvedModelPolicy,
  type RoutingCriterion,
  type SessionDefaultsStatus,
  type TierBy,
  type VendorOrderRole,
  favouriteKey,
  favouritesAsPresets,
  policySourceWords,
} from '@agile-agents/shared';
import type { FavouriteModel } from '@agile-agents/shared';
import { sessionLabel, vendorLabel } from './chat';

/** A layer's model choice as the daemon sends it: what it sets, and the whole resolved. */
export interface ModelPolicyView {
  policy: ModelPolicyPartial;
  resolved: ResolvedModelPolicy;
}

export type PolicyLayer = 'home' | 'project' | 'node';

export const MODE_WORDS: Record<ModelPolicyMode, string> = {
  default: 'Default',
  inherit: 'Inherit',
  choose: 'Choose',
};

/** One line each on what the mode does. */
export const MODE_HINTS: Record<ModelPolicyMode, string> = {
  default: 'A node starts on its project’s, repository’s or the global default model, as before.',
  inherit: 'A node starts on the model its parent node runs now.',
  choose:
    'Jev reads the task and picks a tier (fast, balanced or strongest) and an effort, with the scores behind them; the vendor order picks the preset model in that tier.',
};

export const ESCALATION_WORDS: Record<ModelEscalation, string> = {
  start_cheap: 'Start cheap',
  strongest_first: 'Strongest first',
};

export const ESCALATION_HINTS: Record<ModelEscalation, string> = {
  start_cheap:
    'Begin on a balanced preset model at medium effort, and step up when the work stalls.',
  strongest_first: 'Begin on the strongest preset model, at high effort, and stay there.',
};

export const EFFORT_WORDS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

/** The quality priority in words: 0 is "Favor speed & cost", 100 "Favor quality". */
export function qualityWords(quality: number): string {
  if (quality <= 20) return 'Favor speed & cost';
  if (quality < 45) return 'Lean to speed & cost';
  if (quality <= 55) return 'Balanced';
  if (quality < 80) return 'Lean to quality';
  return 'Favor quality';
}

/** Whether this layer sets `field` itself (else it inherits it). */
export function setHere(view: ModelPolicyView, field: ModelPolicyField): boolean {
  return view.policy[field] !== undefined;
}

/** "set here", "from Home", "from Billing", "built in". */
export function sourceWords(
  view: ModelPolicyView,
  field: ModelPolicyField,
  here: PolicyLayer,
): string {
  return policySourceWords(view.resolved.sources[field], here);
}

export function presetKey(p: { vendor: string; model?: string | undefined }): string {
  return favouriteKey(p);
}

/** Whether `ref` is one of the presets (`default` and no model are the same). */
export function isPreset(
  presets: readonly PresetModel[],
  ref: { vendor: string; model?: string | undefined },
): boolean {
  const key = presetKey(ref);
  return presets.some((p) => presetKey(p) === key);
}

/** The presets with `ref` added (at the end) or taken out. */
export function togglePreset(
  presets: readonly PresetModel[],
  ref: { vendor: PresetModel['vendor']; model?: string | undefined },
  on: boolean,
): PresetModel[] {
  const key = presetKey(ref);
  const others = presets.filter((p) => presetKey(p) !== key);
  if (!on) return others;
  if (others.length < presets.length) return [...presets];
  return [...presets, { vendor: ref.vendor, model: ref.model ?? 'default' }];
}

/** "My favourites" as the presets (T469). */
export function favouritePresets(favourites: readonly FavouriteModel[]): PresetModel[] {
  return favouritesAsPresets(favourites);
}

/** The presets in words: "Any installed model", or their names. */
export function presetsWords(presets: readonly PresetModel[]): string {
  if (presets.length === 0) return 'Any installed model';
  return presets.map((p) => sessionLabel({ vendor: p.vendor, model: p.model })).join(', ');
}

const HOW_WORDS: Record<PickHow, string> = {
  explicit: 'Your pick',
  kept: 'Kept from its last run',
  inherit: 'Inherited from its parent',
  default: 'The Default setting',
  rule: 'Chosen by the policy’s rule',
  clamp: 'Moved into the preset models',
  pinned: 'A pinned rule',
  jev: 'Chosen by Jev',
  scores: 'Chosen by the scores',
  escalation: 'Stepped up the ladder',
};

/** How the node's current model was picked, in a line: "Claude Sonnet 5.5 · medium — start cheap: …". */
export function pickLine(pick: ModelPickRecord): string {
  const label = sessionLabel({
    vendor: pick.vendor,
    model: pick.model,
    ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
  });
  return `${label} — ${pick.how === 'explicit' ? HOW_WORDS.explicit.toLowerCase() : pick.why}`;
}

/** The pick's route as a short tag ("Your pick", "Inherited from its parent"). */
export function pickHowWords(how: PickHow): string {
  return HOW_WORDS[how];
}

export const TIER_WORDS: Record<ModelProfile['tier'], string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  strongest: 'Strongest',
};

/** Profiles as rows, `vendor/model` sorted by vendor then tier (strongest first) then name. */
export function profileRows(
  profiles: Readonly<Record<string, ModelProfile>>,
  own: Readonly<Record<string, ModelProfile>>,
): Array<{ key: string; vendor: string; model: string; profile: ModelProfile; own: boolean }> {
  const rank = { strongest: 0, balanced: 1, fast: 2 } as const;
  return Object.entries(profiles)
    .map(([key, profile]) => {
      const at = key.indexOf('/');
      return {
        key,
        vendor: key.slice(0, at),
        model: key.slice(at + 1),
        profile,
        own: own[key] !== undefined,
      };
    })
    .sort(
      (a, b) =>
        a.vendor.localeCompare(b.vendor) ||
        rank[a.profile.tier] - rank[b.profile.tier] ||
        a.model.localeCompare(b.model),
    );
}

/** T483: the five criteria as Details and Try it name them. */
export const CRITERION_WORDS: Record<RoutingCriterion, string> = {
  clarity: 'Clarity',
  verifiability: 'Verifiability',
  horizon: 'Horizon',
  stakes: 'Stakes',
  volume: 'Volume',
};

/** T483: what each criterion's 1 and 5 mean, for its title. */
export const CRITERION_HINTS: Record<RoutingCriterion, string> = {
  clarity: '1 open-ended · 5 well defined with acceptance stated',
  verifiability: '1 only a person can tell · 5 a test, build or typecheck proves it',
  horizon: '1 a quick fix · 5 a multi-hour, many-step job',
  stakes: '1 easily undone · 5 security, a data migration, architecture or money',
  volume: '1 a one-off · 5 one of many similar parts starting at once',
};

/** T483: the five scores as rows, one decimal each. */
export function scoreRows(
  scores: ChooserScores,
): Array<{ criterion: RoutingCriterion; label: string; value: string; hint: string }> {
  return ROUTING_CRITERIA.map((criterion) => ({
    criterion,
    label: CRITERION_WORDS[criterion],
    value: scores[criterion].toFixed(1),
    hint: CRITERION_HINTS[criterion],
  }));
}

/** T483, T490: Jev's confidence in its tier: "0.82: sure enough to decide" / "0.41: not sure, …". */
export function confidenceWords(confidence: number): string {
  const n = confidence.toFixed(2);
  return confidence >= CHOOSER_CONFIDENCE_MIN
    ? `${n}: sure enough to decide`
    : `${n}: not sure, so the scores decided`;
}

/** T483: where a pick came from, one word each (`how`, and `base` under a clamp). */
export function pickSourceWords(pick: Pick<ModelPickRecord, 'how' | 'base'>): string {
  const one: Record<PickHow, string> = {
    explicit: 'your pick',
    kept: 'kept',
    inherit: 'inherited',
    default: 'Default',
    rule: 'the rule',
    clamp: 'clamped',
    pinned: 'a pinned rule',
    jev: 'Jev',
    scores: 'the scores',
    escalation: 'a step up',
  };
  return pick.how === 'clamp' && pick.base !== undefined
    ? `${one[pick.base]}, then clamped into the preset models`
    : one[pick.how];
}

/** T483: a pinned rule in words: "coordinator → Claude Opus 5.5 · high". */
export function pinnedRuleWords(rule: PinnedRule): string {
  const when = [
    rule.when.role,
    rule.when.label !== undefined ? `label “${rule.when.label}”` : undefined,
    rule.when.topic !== undefined ? `${rule.when.topic} work` : undefined,
  ]
    .filter((w): w is string => w !== undefined)
    .join(' + ');
  // T490: a rule naming only a vendor lets the tier pick its model.
  const pick =
    rule.pick.model === undefined
      ? `any ${vendorLabel(rule.pick.vendor)} model${
          rule.pick.effort !== undefined ? ` · ${rule.pick.effort}` : ''
        }`
      : sessionLabel({
          vendor: rule.pick.vendor,
          model: rule.pick.model,
          ...(rule.pick.effort !== undefined ? { effort: rule.pick.effort } : {}),
        });
  return `${when} → ${pick}`;
}

/** T483: a list with one rule moved up (-1) or down (+1). */
export function moveRule<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

// ---------------------------------------------------------------- T490: tier first, the vendor order

/** T490 (D59): the roles that may have their own vendor order, as Settings names them. */
export const VENDOR_ORDER_ROLE_WORDS: Record<VendorOrderRole, string> = {
  worker: 'Code',
  coordinator: 'Coordinating',
  conversation: 'Conversations',
  reviewer: 'Reviews',
};

/** What each role is, for its row's title. */
export const VENDOR_ORDER_ROLE_HINTS: Record<VendorOrderRole, string> = {
  worker: 'A node’s agent writing code on its branch',
  coordinator: 'A coordinator planning the parts and starting their agents',
  conversation: 'A conversation: it talks and researches, with no repository',
  reviewer: 'A reviewer started without a model picked (Ask an agent to review)',
};

/** The vendors installed here, as Settings → Agents lists them (the daemon's order). */
export function installedVendors(
  status: Pick<SessionDefaultsStatus, 'vendors' | 'not_installed'>,
): string[] {
  return status.vendors.filter((v) => status.not_installed?.[v] === undefined);
}

/**
 * The order control's rows: the order's vendors first, in its order, then
 * the other installed vendors (a vendor the order leaves out comes after
 * those it names).
 */
export function vendorOrderRows(order: readonly string[], installed: readonly string[]): string[] {
  return [...order, ...installed.filter((v) => !order.includes(v))];
}

/** A vendor order in words: "Claude, then Codex", or "No preference". */
export function vendorOrderText(order: readonly string[]): string {
  return order.length === 0 ? 'No preference' : order.map(vendorLabel).join(', then ');
}

/** T490: how the tier was decided, in words. */
export const TIER_BY_WORDS: Record<TierBy, string> = {
  jev: 'Jev',
  scores: 'the scores (Jev wasn’t sure)',
  rule: 'the rule',
  pinned: 'a pinned rule',
  only: 'the only tier in the preset models',
};

/**
 * T490: the tier line for Details and Try it: "Balanced tier, by Jev
 * (0.82). In the tier: Claude before Codex." `undefined` with no tier.
 */
export function tierLine(pick: {
  tier?: ModelProfile['tier'] | undefined;
  tier_by?: TierBy | undefined;
  confidence?: number | undefined;
  in_tier?: { words?: string | undefined } | undefined;
}): string | undefined {
  if (pick.tier === undefined) return undefined;
  const by =
    pick.tier_by !== undefined
      ? `, by ${TIER_BY_WORDS[pick.tier_by]}${
          pick.confidence !== undefined && (pick.tier_by === 'jev' || pick.tier_by === 'scores')
            ? ` (${pick.confidence.toFixed(2)})`
            : ''
        }`
      : '';
  const inTier = pick.in_tier?.words !== undefined ? ` In the tier: ${pick.in_tier.words}.` : '';
  return `${TIER_WORDS[pick.tier]} tier${by}.${inTier}`;
}
