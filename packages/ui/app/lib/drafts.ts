/**
 * T436 (audit r6 #11, #22): what you typed and haven't sent or saved — a
 * node's composer draft, its review comments, a project's unsaved
 * repositories — kept per id in this tab's `sessionStorage`, so a reload
 * (the "new version of the cockpit" Reload too) or a trip elsewhere in the
 * cockpit doesn't drop it.
 *
 * A per-viewer convenience, never state the daemon holds: every storage
 * access is wrapped (a private window or blocked site data throws, a
 * preview has none), and without storage a draft lasts until the page
 * reloads. What comes back from storage is parsed again, entry by entry;
 * anything that doesn't read right is dropped, never trusted.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** The part of `Storage` a kept draft uses (a fake in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** This tab's `sessionStorage`, or `undefined` where there is none or reading it throws. */
export function sessionStore(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Values per id, kept under one storage key as one JSON object. `parse`
 * keeps a stored entry only when it still reads as a `T`. Subscribable, so
 * every place that shows a draft reads the same one; `get` returns the same
 * object until it changes (a `useSyncExternalStore` snapshot).
 */
export class KeptDrafts<T> {
  private values: Map<string, T> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly key: string,
    private readonly parse: (value: unknown) => T | undefined,
    private readonly storage: () => StorageLike | undefined = sessionStore,
  ) {}

  private load(): Map<string, T> {
    if (this.values !== undefined) return this.values;
    const values = new Map<string, T>();
    let raw: string | null = null;
    try {
      raw = this.storage()?.getItem(this.key) ?? null;
    } catch {
      // Storage blocked: start empty.
    }
    if (raw !== null) {
      try {
        const stored: unknown = JSON.parse(raw);
        if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
          for (const [id, value] of Object.entries(stored)) {
            const parsed = this.parse(value);
            if (parsed !== undefined) values.set(id, parsed);
          }
        }
      } catch {
        // Not JSON: nothing kept.
      }
    }
    this.values = values;
    return values;
  }

  private save(): void {
    const values = this.load();
    try {
      const storage = this.storage();
      if (storage === undefined) return;
      if (values.size === 0) storage.removeItem(this.key);
      else storage.setItem(this.key, JSON.stringify(Object.fromEntries(values)));
    } catch {
      // Full or blocked: kept in memory only, until the page reloads.
    }
  }

  get(id: string): T | undefined {
    return this.load().get(id);
  }

  /** Every id with something kept. */
  ids(): string[] {
    return [...this.load().keys()];
  }

  /** `undefined` forgets it. */
  set(id: string, value: T | undefined): void {
    const values = this.load();
    if (value === undefined) {
      if (!values.has(id)) return;
      values.delete(id);
    } else {
      if (values.get(id) === value) return;
      values.set(id, value);
    }
    this.save();
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

// ---------------------------------------------------------------- the composer

/** A stored draft is text with something in it (a reload doesn't bring back a box of spaces). */
export function parseDraftText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Each node's composer draft (T436 #11). */
export const composerDrafts = new KeptDrafts<string>('agile.drafts', parseDraftText);

export type DraftUpdate = string | ((before: string) => string);

/**
 * One id's text draft after an edit: `next` as typed, or worked out from
 * what is kept. Kept as typed (a space is a keystroke too); only an empty
 * box keeps nothing.
 */
export function updateDraft(kept: KeptDrafts<string>, id: string, next: DraftUpdate): void {
  const value = typeof next === 'function' ? next(kept.get(id) ?? '') : next;
  kept.set(id, value === '' ? undefined : value);
}

/** One id's text draft in `kept`, read again whenever it changes. */
function useKeptText(kept: KeptDrafts<string>, id: string): string {
  return useSyncExternalStore(
    kept.subscribe,
    () => kept.get(id) ?? '',
    () => kept.get(id) ?? '',
  );
}

/**
 * A node's composer draft and its setter. The setter stays bound to the
 * node it was made for, so a send that finishes after you moved on clears
 * that node's draft, not the one now on screen.
 */
export function useComposerDraft(node: string): [string, (next: DraftUpdate) => void] {
  return [useKeptText(composerDrafts, node), useDraftSetter(node)];
}

/**
 * T447 (audit r7 #15): the draft's setter alone. A page that writes the
 * draft (a review joins it, Send clears it) but doesn't show it takes this,
 * so a keystroke re-renders only the composer that shows it.
 */
export function useDraftSetter(node: string): (next: DraftUpdate) => void {
  return useCallback((next: DraftUpdate) => updateDraft(composerDrafts, node, next), [node]);
}

/** A node's draft, and a new one for it: for a message prepared off its page (a card's Add to message). */
export function draftOf(node: string): string {
  return composerDrafts.get(node) ?? '';
}

export function setDraftOf(node: string, text: string): void {
  composerDrafts.set(node, text === '' ? undefined : text);
}

// ---------------------------------------------------------------- a question's answer

/**
 * T499: each question card's half-written answer, by question id, kept as
 * the composer's draft is (across a re-render, a trip elsewhere in the
 * cockpit and a reload). Sending the answer clears it.
 */
export const answerDrafts = new KeptDrafts<string>('agile.answer-drafts', parseDraftText);

/** T499: a question's kept answer and its setter, bound to that question as the composer's is to its node. */
export function useAnswerDraft(question: string): [string, (next: DraftUpdate) => void] {
  const setter = useCallback(
    (next: DraftUpdate) => updateDraft(answerDrafts, question, next),
    [question],
  );
  return [useKeptText(answerDrafts, question), setter];
}

// ---------------------------------------------------------------- a project's settings

/** T436 (audit r6 #22): a root's Details → Project changes, not saved yet. */
export interface ProjectDraft {
  /** The saved settings it was made over: once they change, the draft is dropped. */
  base: string;
  repos: string[];
  tracker: {
    system: '' | 'jira' | 'linear';
    push: boolean;
    map: { in_progress: string; in_review: string; done: string };
  };
}

const SYSTEMS: ReadonlySet<unknown> = new Set(['', 'jira', 'linear']);

export function parseProjectDraft(value: unknown): ProjectDraft | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const t = d.tracker as Record<string, unknown> | null | undefined;
  const map = (t?.map ?? undefined) as Record<string, unknown> | undefined;
  if (typeof d.base !== 'string') return undefined;
  if (!Array.isArray(d.repos) || !d.repos.every((r) => typeof r === 'string')) return undefined;
  if (t === null || typeof t !== 'object' || !SYSTEMS.has(t.system)) return undefined;
  if (typeof t.push !== 'boolean' || map === null || typeof map !== 'object') return undefined;
  const keys = ['in_progress', 'in_review', 'done'] as const;
  if (!keys.every((k) => typeof map[k] === 'string')) return undefined;
  return {
    base: d.base,
    repos: [...(d.repos as string[])],
    tracker: {
      system: t.system as ProjectDraft['tracker']['system'],
      push: t.push,
      map: {
        in_progress: map.in_progress as string,
        in_review: map.in_review as string,
        done: map.done as string,
      },
    },
  };
}

/** Each project's unsaved Project changes, until saved or cancelled (or its saved settings change). */
export const projectDrafts = new KeptDrafts<ProjectDraft>(
  'agile.project-drafts',
  parseProjectDraft,
);
