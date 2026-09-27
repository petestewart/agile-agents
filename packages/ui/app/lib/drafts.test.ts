/** T436 (audit r6 #11, #22): drafts kept per id in this tab's storage, across a reload. */

import { describe, expect, test } from 'bun:test';
import { KeptDrafts, type StorageLike, parseDraftText, parseProjectDraft } from './drafts';

/** A `sessionStorage` stand-in: one tab's, shared by the "page loads" made from it. */
function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('KeptDrafts', () => {
  test('a value set in one page load is there in the next (a reload)', () => {
    const storage = fakeStorage();
    const before = new KeptDrafts('k', parseDraftText, () => storage);
    before.set('N1', 'half a message');
    before.set('N2', 'another');
    const after = new KeptDrafts('k', parseDraftText, () => storage);
    expect(after.get('N1')).toBe('half a message');
    expect(after.ids().sort()).toEqual(['N1', 'N2']);
  });

  test('forgetting the last one removes the key; subscribers hear each change once', () => {
    const storage = fakeStorage();
    const kept = new KeptDrafts('k', parseDraftText, () => storage);
    let calls = 0;
    const off = kept.subscribe(() => {
      calls += 1;
    });
    kept.set('N1', 'x');
    kept.set('N1', 'x');
    kept.set('N1', undefined);
    kept.set('N1', undefined);
    expect(calls).toBe(2);
    expect(storage.data.has('k')).toBe(false);
    off();
    kept.set('N1', 'y');
    expect(calls).toBe(2);
  });

  test('what does not read right is dropped, entry by entry, never trusted', () => {
    const storage = fakeStorage();
    storage.setItem('k', JSON.stringify({ N1: 'kept', N2: 42, N3: '   ', N4: null }));
    const kept = new KeptDrafts('k', parseDraftText, () => storage);
    expect(kept.ids()).toEqual(['N1']);
    storage.setItem('bad', '{not json');
    expect(new KeptDrafts('bad', parseDraftText, () => storage).ids()).toEqual([]);
    storage.setItem('list', '["a"]');
    expect(new KeptDrafts('list', parseDraftText, () => storage).ids()).toEqual([]);
  });

  test('storage that throws, or none at all: kept in memory until the page reloads', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const kept = new KeptDrafts('k', parseDraftText, () => throwing);
    kept.set('N1', 'still here');
    expect(kept.get('N1')).toBe('still here');
    const none = new KeptDrafts('k', parseDraftText, () => undefined);
    none.set('N1', 'here too');
    expect(none.get('N1')).toBe('here too');
    const unreadable = new KeptDrafts('k', parseDraftText, () => {
      throw new Error('no storage');
    });
    unreadable.set('N1', 'and here');
    expect(unreadable.get('N1')).toBe('and here');
  });
});

describe('a project draft', () => {
  const draft = {
    base: 'web-app|null',
    repos: ['web-app', 'docs-site'],
    tracker: { system: 'jira', push: true, map: { in_progress: 'Doing', in_review: '', done: '' } },
  };

  test('reads back as it was', () => {
    expect(parseProjectDraft(JSON.parse(JSON.stringify(draft)))).toEqual(
      draft as ReturnType<typeof parseProjectDraft>,
    );
  });

  test('anything off is no draft', () => {
    expect(parseProjectDraft({ ...draft, base: 1 })).toBeUndefined();
    expect(parseProjectDraft({ ...draft, repos: ['a', 2] })).toBeUndefined();
    expect(parseProjectDraft({ ...draft, tracker: { ...draft.tracker, system: 'asana' } })).toBe(
      undefined,
    );
    expect(parseProjectDraft({ ...draft, tracker: { ...draft.tracker, map: {} } })).toBe(undefined);
    expect(parseProjectDraft({ ...draft, tracker: null })).toBeUndefined();
    expect(parseProjectDraft('x')).toBeUndefined();
  });
});
