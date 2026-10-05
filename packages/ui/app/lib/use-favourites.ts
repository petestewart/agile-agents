/**
 * T469: the favourite models the cockpit last heard from the daemon, and
 * the picker's folds (per browser). The rules are in `favourites.ts`.
 *
 *  - `noteFavourites`: `api.ts` calls it with every session-defaults reply
 *    (a read, or a star), so every open picker shows the newest list.
 *  - `useFavouriteModels(status)`: that list, else the one `status` carries.
 *  - `usePickerPrefs()`: the folded groups and Show all, kept in
 *    localStorage (a blocked storage keeps them until the page reloads).
 */

import type { FavouriteModel } from '@agile-agents/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { NO_PICKER_PREFS, type PickerPrefs, parsePickerPrefs } from './favourites';

let latest: readonly FavouriteModel[] | undefined;
const listeners = new Set<() => void>();

/** The daemon said this is the list (a session-defaults reply). */
export function noteFavourites(favourites: readonly FavouriteModel[] | undefined): void {
  const next = favourites ?? [];
  if (latest !== undefined && JSON.stringify(latest) === JSON.stringify(next)) return;
  latest = next;
  for (const listener of listeners) listener();
}

function subscribeFavourites(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The newest favourites heard, else `status`'s (an older daemon sends none: none). */
export function useFavouriteModels(status: {
  favourite_models?: readonly FavouriteModel[];
}): readonly FavouriteModel[] {
  const heard = useSyncExternalStore(
    subscribeFavourites,
    () => latest,
    () => latest,
  );
  return heard ?? status.favourite_models ?? [];
}

// ---------------------------------------------------------------- per browser

const PREFS_KEY = 'agile.model-picker';
let prefs: PickerPrefs | undefined;
const prefListeners = new Set<() => void>();

function loadPrefs(): PickerPrefs {
  if (prefs === undefined) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(PREFS_KEY);
    } catch {
      // Storage blocked: the folds last until the page reloads.
    }
    prefs = parsePickerPrefs(raw);
  }
  return prefs;
}

function subscribePrefs(listener: () => void): () => void {
  prefListeners.add(listener);
  return () => prefListeners.delete(listener);
}

/** The picker's folds and Show all, and a setter that keeps them for this browser. */
export function usePickerPrefs(): [PickerPrefs, (next: PickerPrefs) => void] {
  const value = useSyncExternalStore(subscribePrefs, loadPrefs, () => NO_PICKER_PREFS);
  const set = useCallback((next: PickerPrefs) => {
    prefs = next;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: kept in memory only.
    }
    for (const listener of prefListeners) listener();
  }, []);
  return [value, set];
}
