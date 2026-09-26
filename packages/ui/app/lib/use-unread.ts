/**
 * T429: the read marks' store (per browser, localStorage) and the hooks
 * that read it. The rules are in `unread.ts`.
 *
 *  - `useUnreadReplies()`: the replies not read yet (Needs me, the sidebar).
 *  - `useReadOpenNode()`: mounted once in `App`; the node open in a visible
 *    tab is read as its row changes.
 *  - `useReplyNotifications()`: mounted once in `App`; a reply that lands
 *    while you're away raises one notification (when they're on, T388).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFeed } from './feed-context';
import type { CockpitStreamRow } from './feed-types';
import { clip } from './notify';
import { useShell } from './shell';
import { type SeenState, markAllSeen, markSeen, parseSeen, unreadReplies } from './unread';
import { notifyAccess, raiseNotification, readNotifyOn } from './use-notify';

const KEY = 'agile.seen';
const REPLY_TAG = 'agile-reply';

let state: SeenState | undefined;
const listeners = new Set<() => void>();

function load(): SeenState {
  if (state === undefined) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch {
      // Storage blocked: read marks last until the page reloads.
    }
    state = parseSeen(raw, new Date().toISOString());
    if (raw === null) save(state);
  }
  return state;
}

function save(next: SeenState): void {
  state = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: kept in memory only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab read something: pick it up.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== KEY) return;
    state = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** `id` read up to `at`. */
export function markRead(id: string, at: string): void {
  const current = load();
  const next = markSeen(current, id, at);
  if (next !== current) save(next);
}

/** Every one of `rows` read. */
export function markAllRead(rows: readonly CockpitStreamRow[]): void {
  const current = load();
  const next = markAllSeen(current, rows);
  if (next !== current) save(next);
}

function useSeen(): SeenState {
  return useSyncExternalStore(subscribe, load, load);
}

/** A visible tab: what is on screen is being read. */
function onScreen(): boolean {
  return document.visibilityState === 'visible';
}

/** The replies not read yet, newest first (the node open in a visible tab is being read). */
export function useUnreadReplies(): CockpitStreamRow[] {
  const { cockpit } = useFeed();
  const { selected } = useShell();
  const seen = useSeen();
  return useMemo(
    () => unreadReplies(cockpit?.streams ?? [], seen, onScreen() ? selected : undefined),
    [cockpit, seen, selected],
  );
}

/** Mounted once: the node open in a visible tab is read up to its row's last change. */
export function useReadOpenNode(): void {
  const { cockpit } = useFeed();
  const { selected } = useShell();
  const at = cockpit?.streams.find((row) => row.id === selected)?.updated_at;
  useEffect(() => {
    if (selected === undefined || at === undefined) return;
    const read = (): void => {
      if (onScreen()) markRead(selected, at);
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [selected, at]);
}

/** Mounted once: a reply that lands while you're away raises one notification (T388's setting). */
export function useReplyNotifications(): void {
  const replies = useUnreadReplies();
  const { select } = useShell();
  const told = useRef<Set<string>>();
  const go = useRef(select);
  go.current = select;
  useEffect(() => {
    const keys = new Set(replies.map((row) => `${row.id}:${row.updated_at}`));
    // The first look only learns what is already unread.
    if (told.current === undefined) {
      told.current = keys;
      return;
    }
    const fresh = replies.filter((row) => !told.current?.has(`${row.id}:${row.updated_at}`));
    for (const key of keys) told.current.add(key);
    const away = document.visibilityState === 'hidden' || !document.hasFocus();
    const first = fresh[0];
    if (!away || first === undefined || !readNotifyOn() || notifyAccess() !== 'granted') return;
    const title =
      fresh.length === 1 ? `Replied: ${clip(first.title, 80)}` : `${fresh.length} new replies`;
    const body =
      fresh.length === 1
        ? 'The agent answered. Open it to read the reply.'
        : clip(fresh.map((row) => row.title).join(' · '), 160);
    void raiseNotification({ title, body, tag: REPLY_TAG, node: first.id }, () =>
      go.current(first.id),
    );
  }, [replies]);
}
