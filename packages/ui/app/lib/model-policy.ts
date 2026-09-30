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
  type Effort,
  type ModelEscalation,
  type ModelPickRecord,
  type ModelPolicyField,
  type ModelPolicyMode,
  type ModelPolicyPartial,
  type ModelProfile,
  type PickHow,
  type PresetModel,
  type ResolvedModelPolicy,
  favouriteKey,
  favouritesAsPresets,
  policySourceWords,
} from '@agile-agents/shared';
import type { FavouriteModel } from '@agile-agents/shared';
import { sessionLabel } from './chat';

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
    'The policy picks from the preset models. For now by a simple rule (below); picking with Jev comes next.',
};

export const ESCALATION_WORDS: Record<ModelEscalation, string> = {
  start_cheap: 'Start cheap',
  strongest_first: 'Strongest first',
};

export const ESCALATION_HINTS: Record<ModelEscalation, string> = {
  start_cheap: 'Begin on the cheapest balanced preset model, at medium effort.',
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
