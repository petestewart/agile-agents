/**
 * T379: what a new session resolves to, as the cockpit shows it (New node's
 * "Starts with", the composer's model chip, the picker's prefill, Settings).
 * The same order as attach (`resolveSessionDefaults`, D17 and P5).
 *
 * T423: the one model picker's pure half — the models it lists by name,
 * grouped by vendor (`modelGroups`), the Model select's options in Settings
 * and New node (`modelSelectOptions`), when two choices run the same thing
 * (`sameSession`), and what the composer's chip says (`modelChip`).
 */

import {
  EFFORT_LEVELS,
  type Effort,
  type ProjectSessionDefaults,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
  resolveSessionDefaults,
  vendorTakesEffort,
} from '@agile-agents/shared';
import { agentLabel, modelLabel, vendorLabel } from './chat';

/**
 * What a stream in `repo` (or no repo) resolves to with nothing named.
 * T379: its project's own defaults (P5) come before the repo's, as in attach.
 */
export function resolvedFor(
  status: SessionDefaultsStatus,
  repo: string | undefined,
  project?: ProjectSessionDefaults,
): ResolvedSessionDefaults {
  const base = (repo !== undefined ? status.repos[repo]?.resolved : undefined) ?? status.resolved;
  if (
    project?.vendor === undefined &&
    project?.model === undefined &&
    project?.effort === undefined
  ) {
    return base;
  }
  const repoFields = repo !== undefined ? status.repos[repo] : undefined;
  return resolveSessionDefaults({
    project,
    ...(repoFields ? { repo: repoFields } : {}),
    home: {
      ...(status.home.vendor !== undefined ? { default_vendor: status.home.vendor } : {}),
      ...(status.home.model !== undefined ? { default_model: status.home.model } : {}),
      ...(status.home.effort !== undefined ? { default_effort: status.home.effort } : {}),
    },
  });
}

// ---------------------------------------------------------------- the model picker (T423)

/** A vendor/model pair; no model is the vendor's own default. */
export interface ModelRef {
  vendor: string;
  model?: string;
}

/** A model the picker lists: its vendor, its id (none for the vendor's own default), its name. */
export interface ModelOption extends ModelRef {
  label: string;
}

export interface ModelGroup {
  /** "Claude"; "Other agents" for the vendors listed by their default model alone. */
  label: string;
  options: ModelOption[];
}

/** "default", "" and none all mean the vendor's own default model. */
function normalModel(model: string | undefined): string | undefined {
  return model === undefined || model === '' || model === 'default' ? undefined : model;
}

/** `opus`, `sonnet`: a moving alias, not a model; listed only when something already uses it. */
function isAlias(id: string): boolean {
  return !/\d/.test(id);
}

/** Two refs name the same model. */
export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.vendor === b.vendor && normalModel(a.model) === normalModel(b.model);
}

/** Two choices run the same thing: the vendor, the model, and the effort where the vendor uses one. */
export function sameSession(a: ResolvedSessionDefaults, b: ResolvedSessionDefaults): boolean {
  return sameModel(a, b) && (!vendorTakesEffort(a.vendor) || a.effort === b.effort);
}

/** A session record (`model: 'default'` for the provider's own) as a choice. */
export function choiceOf(
  session: { vendor: string; model?: string; effort?: string },
  fallbackEffort: Effort,
): ResolvedSessionDefaults {
  const model = normalModel(session.model);
  const effort = (EFFORT_LEVELS as readonly string[]).includes(session.effort ?? '')
    ? (session.effort as Effort)
    : fallbackEffort;
  return { vendor: session.vendor, ...(model !== undefined ? { model } : {}), effort };
}

/**
 * The picker's list: each vendor with known models as a group of them by
 * name (aliases left out), then "Other agents", one row per vendor with no
 * list (its own default model). `extra` (the choice, the default, the live
 * agent) is added where the list lacks it, so what runs always shows.
 */
export function modelGroups(
  known: Readonly<Record<string, readonly string[]>>,
  vendors: readonly string[],
  extra: readonly ModelRef[] = [],
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const others: ModelOption[] = [];
  const option = (ref: ModelRef, byName = false): ModelOption => {
    const model = normalModel(ref.model);
    return {
      vendor: ref.vendor,
      ...(model !== undefined ? { model } : {}),
      // A hand-typed id names its vendor ("Codex · gpt-9"); a known one reads by name.
      label: byName ? modelLabel(ref.vendor, model) : agentLabel({ vendor: ref.vendor, model }),
    };
  };
  for (const vendor of vendors) {
    const ids = (known[vendor] ?? []).filter((id) => !isAlias(id));
    if (ids.length === 0) others.push(option({ vendor }, true));
    else
      groups.push({
        label: vendorLabel(vendor),
        options: ids.map((model) => option({ vendor, model }, true)),
      });
  }
  const all = (): ModelOption[] => [...groups.flatMap((g) => g.options), ...others];
  for (const ref of extra) {
    if (all().some((o) => sameModel(o, ref))) continue;
    const group = groups.find((g) => g.options[0]?.vendor === ref.vendor);
    if (group) {
      group.options.push(option(ref, true));
      continue;
    }
    // After that vendor's own rows, else at the end.
    let at = others.length;
    others.forEach((o, i) => {
      if (o.vendor === ref.vendor) at = i + 1;
    });
    others.splice(at, 0, option(ref));
  }
  if (others.length > 0) groups.push({ label: 'Other agents', options: others });
  return groups;
}

/** "low" → "Low". */
export function effortWord(level: string): string {
  return level ? level[0]?.toUpperCase() + level.slice(1) : level;
}

/**
 * The Model select's options (Settings, New node): the empty value first
 * ("Inherits Claude Opus 5.5", or the vendor's default model), then the
 * vendor's known models by name, then the value itself if it is none of
 * those (an alias or an id typed by hand). The select adds "Other…".
 */
export function modelSelectOptions(
  known: Readonly<Record<string, readonly string[]>>,
  vendor: string,
  value: string,
  inherits?: string,
): Array<{ value: string; label: string }> {
  const options = [
    {
      value: '',
      label: inherits !== undefined ? `Inherits ${inherits}` : modelLabel(vendor, undefined),
    },
    ...(known[vendor] ?? [])
      .filter((id) => !isAlias(id))
      .map((id) => ({ value: id, label: modelLabel(vendor, id) })),
  ];
  const typed = value.trim();
  if (typed !== '' && !options.some((o) => o.value === typed)) {
    options.push({ value: typed, label: modelLabel(vendor, typed) });
  }
  return options;
}

/**
 * The model a changed vendor keeps: the same id when that vendor lists it,
 * else none (its default, or whatever it inherits). A Claude id never
 * rides along to Gemini (T402).
 */
export function modelForVendor(
  known: Readonly<Record<string, readonly string[]>>,
  vendor: string,
  model: string,
): string {
  return model !== '' && (known[vendor] ?? []).includes(model) ? model : '';
}

export interface ModelChipInput {
  /** What the node's live agent runs, if one does. */
  live?: ResolvedSessionDefaults;
  /** What a start runs with nothing picked (the resolved default). */
  fallback: ResolvedSessionDefaults;
  /** The chip's pick for the next message, if any. */
  chosen?: ResolvedSessionDefaults;
}

export interface ModelChipState {
  /** What the chip names. */
  shows: ResolvedSessionDefaults;
  label: string;
  /** `live`: the running agent; `chosen`: your pick for the next message; `default`: what a start runs. */
  state: 'live' | 'chosen' | 'default';
  /** The pick, when it differs from what would run anyway: the next message starts (or restarts) with it. */
  pending?: ResolvedSessionDefaults;
  /** The chip's tooltip: what it is, and that a pick lasts one message. */
  title: string;
}

/**
 * T423: the composer's model chip. It names the live agent's model, else
 * what a start would run; a pick that differs is "pending" until the next
 * message, which starts the agent with it (or restarts the live one), and
 * then the chip goes back to the default.
 */
export function modelChip(input: ModelChipInput): ModelChipState {
  const base = input.live ?? input.fallback;
  const pending =
    input.chosen !== undefined && !sameSession(input.chosen, base) ? input.chosen : undefined;
  if (pending !== undefined) {
    const label = agentLabel(pending);
    return {
      shows: pending,
      label,
      state: 'chosen',
      pending,
      title: input.live
        ? `Your next message restarts the agent with ${label}. The choice is for that message only.`
        : `Your next message starts the agent with ${label}. It resets to ${agentLabel(input.fallback)} after you send.`,
    };
  }
  const label = agentLabel(base);
  if (input.live) {
    return {
      shows: base,
      label,
      state: 'live',
      title: `Running ${label}. Pick another model and your next message restarts the agent with it.`,
    };
  }
  return {
    shows: base,
    label,
    state: 'default',
    title: `Your next message starts the agent with ${label}, the default here. Pick another model for that message; it resets to the default after you send.`,
  };
}

// ---------------------------------------------------------------- Settings → Agents

/** T436 (audit r6 #25): a repository that names nothing of its own: all three inherit. */
export function inheritsAll(fields: {
  vendor?: unknown;
  model?: unknown;
  effort?: unknown;
}): boolean {
  return fields.vendor === undefined && fields.model === undefined && fields.effort === undefined;
}

/**
 * T436: which repositories' cards fold into one row — the ones that set
 * nothing, when there are at least two (one card is no longer than the row).
 */
export function foldedRepos<T extends { vendor?: unknown; model?: unknown; effort?: unknown }>(
  repos: Record<string, T>,
): string[] {
  const names = Object.entries(repos)
    .filter(([, fields]) => inheritsAll(fields))
    .map(([name]) => name);
  return names.length >= 2 ? names : [];
}

/** "5 repositories use the global default". */
export function inheritingReposText(n: number): string {
  return `${n} ${n === 1 ? 'repository uses' : 'repositories use'} the global default`;
}
