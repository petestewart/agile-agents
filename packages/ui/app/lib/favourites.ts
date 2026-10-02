/**
 * T469: favourite models in the model picker — the pure half.
 *
 * With any favourites set, the picker lists only those (and what runs),
 * grouped by vendor as `modelGroups` groups them, with a Show all switch
 * that opens every vendor's models. Each group folds; typing filters across
 * every model, favourite or not, and ignores the folds. With none set, the
 * picker lists everything, as before. The hooks (the latest favourites the
 * daemon sent, the folds kept per browser) are in `use-favourites.ts`.
 */

import { type FavouriteModel, favouriteKey } from '@agile-agents/shared';
import { vendorLabel } from './chat';
import {
  type ModelOption,
  type ModelRef,
  type VendorModelLists,
  modelGroups,
  sameModel,
} from './defaults';

/** The key a group folds under: its vendor, or `others` for "Other agents". */
export const OTHERS_GROUP = 'others';

/** One row of the picker: a model, whether it is starred, and why it may be stale. */
export interface PickerRow extends ModelOption {
  favourite: boolean;
  /** "Not in Cursor's list now": a favourite its vendor no longer lists (it can be unstarred). */
  unlisted?: string;
}

export interface PickerGroup {
  /** What its fold is kept under: the vendor, or `OTHERS_GROUP`. */
  key: string;
  label: string;
  /** The rows shown: none while it is folded. */
  rows: PickerRow[];
  /** How many rows it has unfolded. */
  count: number;
  folded: boolean;
}

export interface PickerView {
  groups: PickerGroup[];
  /** Any favourites set: the Show all switch shows. */
  hasFavourites: boolean;
  /** How many models Show all would add (0 when it is on, or with no favourites). */
  hidden: number;
  /** Something is typed: every model is searched, and the folds are ignored. */
  searching: boolean;
}

export interface PickerViewInput {
  known: Readonly<Record<string, readonly string[]>>;
  vendors: readonly string[];
  lists?: VendorModelLists;
  favourites: readonly FavouriteModel[];
  /** Always listed (the pick, what runs), favourite or not. */
  keep: readonly ModelRef[];
  /** Listed where the list lacks them, as `modelGroups`'s `extra` (the default too). */
  extra?: readonly ModelRef[];
  showAll: boolean;
  query: string;
  /** The folded groups' keys. */
  folded: readonly string[];
}

/** "Not in Cursor's list now", when `ref` is a model its vendor reported a list without. */
export function unlistedReason(ref: ModelRef, lists?: VendorModelLists): string | undefined {
  const model = ref.model === 'default' ? undefined : ref.model;
  if (model === undefined || model === '') return undefined;
  const reported = lists?.[ref.vendor];
  if (reported === undefined || reported.options.length === 0) return undefined;
  if (reported.options.some((o) => o.value === model) || reported.current === model) {
    return undefined;
  }
  return `Not in ${vendorLabel(ref.vendor)}'s list now`;
}

/** Whether `ref` is one of `favourites`. */
export function isFavourite(ref: ModelRef, favourites: readonly FavouriteModel[]): boolean {
  const key = favouriteKey(ref);
  return favourites.some((f) => favouriteKey(f) === key);
}

/** Every word typed appears in the row's name, its id or its vendor's name. */
export function matchesQuery(row: ModelOption, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${row.label} ${row.model ?? ''} ${vendorLabel(row.vendor)}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * What the picker shows: every model grouped by vendor (a favourite its
 * vendor dropped still listed, marked), then narrowed — to what matches
 * when something is typed, else to the favourites and `keep` when any
 * favourites are set and Show all is off. A folded group keeps its header.
 */
export function pickerView(input: PickerViewInput): PickerView {
  const favourites = input.favourites;
  const hasFavourites = favourites.length > 0;
  const groups = modelGroups(
    input.known,
    input.vendors,
    [...(input.extra ?? []), ...input.keep, ...favourites],
    input.lists,
  );
  const query = input.query.trim();
  const searching = query !== '';
  const narrow = !searching && hasFavourites && !input.showAll;
  let total = 0;
  let shown = 0;
  const out: PickerGroup[] = [];
  for (const group of groups) {
    const key = group.label === 'Other agents' ? OTHERS_GROUP : (group.options[0]?.vendor ?? '');
    const rows: PickerRow[] = group.options.map((option) => {
      const favourite = isFavourite(option, favourites);
      const unlisted = favourite ? unlistedReason(option, input.lists) : undefined;
      return { ...option, favourite, ...(unlisted !== undefined ? { unlisted } : {}) };
    });
    total += rows.length;
    const kept = rows.filter((row) =>
      searching
        ? matchesQuery(row, query)
        : !narrow || row.favourite || input.keep.some((ref) => sameModel(ref, row)),
    );
    shown += kept.length;
    if (kept.length === 0) continue;
    const folded = !searching && input.folded.includes(key);
    out.push({
      key,
      label: group.label,
      rows: folded ? [] : kept,
      count: kept.length,
      folded,
    });
  }
  return { groups: out, hasFavourites, hidden: narrow ? total - shown : 0, searching };
}

// ---------------------------------------------------------------- kept per browser

/** The picker's per-browser state: the folded groups and the Show all switch. */
export interface PickerPrefs {
  folded: string[];
  showAll: boolean;
}

export const NO_PICKER_PREFS: PickerPrefs = { folded: [], showAll: false };

/** Stored prefs read back, field by field; anything that doesn't read right is dropped. */
export function parsePickerPrefs(raw: string | null): PickerPrefs {
  if (raw === null) return NO_PICKER_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return NO_PICKER_PREFS;
    const { folded, showAll } = value as { folded?: unknown; showAll?: unknown };
    return {
      folded: Array.isArray(folded)
        ? folded.filter((k): k is string => typeof k === 'string').slice(0, 50)
        : [],
      showAll: showAll === true,
    };
  } catch {
    return NO_PICKER_PREFS;
  }
}

/** `key` folded if it was open, open if it was folded. */
export function toggleFold(prefs: PickerPrefs, key: string): PickerPrefs {
  return {
    ...prefs,
    folded: prefs.folded.includes(key)
      ? prefs.folded.filter((k) => k !== key)
      : [...prefs.folded, key],
  };
}
