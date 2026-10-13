/** T436 (audit r6 #11, #22): drafts kept per id in this tab's storage, across a reload. */

import { describe, expect, test } from 'bun:test';
import { HUMAN_LINE_MAX_CHARS } from '@agile-agents/shared';
import {
  KeptDrafts,
  type StorageLike,
  afterSend,
  answerDrafts,
  composerDrafts,
  parseDraftText,
  parseProjectDraft,
  sendableText,
  updateDraft,
} from './drafts';

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

describe("a question card's answer (T499)", () => {
  test('each question keeps its own half-written answer, across a reload', () => {
    const storage = fakeStorage();
    const before = new KeptDrafts('agile.answer-drafts', parseDraftText, () => storage);
    updateDraft(before, 'Q-1', 'semicolon, beca');
    updateDraft(before, 'Q-2', '> quote every field?\n\n');
    updateDraft(before, 'Q-2', (was) => `${was}only when needed`);
    const after = new KeptDrafts('agile.answer-drafts', parseDraftText, () => storage);
    expect(after.get('Q-1')).toBe('semicolon, beca');
    expect(after.get('Q-2')).toBe('> quote every field?\n\nonly when needed');
  });

  test('an emptied box keeps nothing; a space is a keystroke and stays', () => {
    const kept = new KeptDrafts('k', parseDraftText, () => fakeStorage());
    updateDraft(kept, 'Q-1', 'a ');
    expect(kept.get('Q-1')).toBe('a ');
    updateDraft(kept, 'Q-1', '');
    expect(kept.ids()).toEqual([]);
  });

  test('answers and the composer are kept apart', () => {
    expect(answerDrafts).not.toBe(composerDrafts);
    answerDrafts.set('N1', 'an answer');
    expect(composerDrafts.get('N1')).toBeUndefined();
    answerDrafts.set('N1', undefined);
  });
});

describe('T519: a send takes off what it sent, and nothing else', () => {
  test('what was typed after the sent text stays, less what parted them', () => {
    expect(afterSend('Fix the login bug', 'Fix the login bug')).toBe('');
    expect(afterSend('Fix the login bug\n\nalso check the tests', 'Fix the login bug')).toBe(
      'also check the tests',
    );
    expect(afterSend('Fix the login bug also the tests', 'Fix the login bug')).toBe(
      'also the tests',
    );
    // Its first line keeps its indent (a code line), and the lines after it stay as typed.
    expect(afterSend('Fix it\n\n    npm test\nthen push', 'Fix it')).toBe(
      '    npm test\nthen push',
    );
    // The draft held spaces around what was sent (the send trims): they go with it.
    expect(afterSend('  Fix it \n', 'Fix it')).toBe('');
    expect(afterSend('\nFix it\nmore', 'Fix it')).toBe('more');
  });

  test('a draft changed any other way stays as it is', () => {
    // Typed onto the sent text's last word: shown whole, so it reads in context.
    expect(afterSend('Fix the bugs', 'Fix the bug')).toBe('Fix the bugs');
    expect(afterSend('Fix the bug, and the tests', 'Fix the bug')).toBe(
      'Fix the bug, and the tests',
    );
    // Edited inside, written before it, cleared, replaced.
    expect(afterSend('Fix the login flow', 'Fix the login bug')).toBe('Fix the login flow');
    expect(afterSend('Urgent: Fix it', 'Fix it')).toBe('Urgent: Fix it');
    expect(afterSend('', 'Fix it')).toBe('');
    expect(afterSend('Something else', 'Fix it')).toBe('Something else');
    expect(afterSend('kept', '')).toBe('kept');
  });

  test('text typed while the request is held survives it; a failed one leaves the draft whole', async () => {
    const kept = new KeptDrafts('k', parseDraftText, () => fakeStorage());
    /** A request held until `release`, then resolved or refused. */
    const held = () => {
      let settle: (ok: boolean) => void = () => {};
      const request = new Promise<void>((resolve, reject) => {
        settle = (ok) => (ok ? resolve() : reject(new Error('refused')));
      });
      return { request, settle };
    };
    /** The page's send: the text it takes, the held request, then only what went comes off. */
    const send = async (request: Promise<void>): Promise<void> => {
      const text = sendableText(kept.get('N1') ?? '');
      if (text === undefined) return;
      try {
        await request;
        updateDraft(kept, 'N1', (now) => afterSend(now, text));
      } catch {
        // The draft stays as typed; Retry sends it again.
      }
    };

    updateDraft(kept, 'N1', 'Fix the login bug');
    const first = held();
    const sending = send(first.request);
    // Typed while the send is out (the box stays editable).
    updateDraft(kept, 'N1', (before) => `${before}\nalso check the tests`);
    first.settle(true);
    await sending;
    expect(kept.get('N1')).toBe('also check the tests');

    const second = held();
    const failing = send(second.request);
    updateDraft(kept, 'N1', (before) => `${before} first`);
    second.settle(false);
    await failing;
    expect(kept.get('N1')).toBe('also check the tests first');
  });

  test('the text a send takes is trimmed and within the cap, counted as the daemon counts it', () => {
    expect(sendableText('  hi \n')).toBe('hi');
    expect(sendableText(' \n ')).toBeUndefined();
    const full = 'x'.repeat(HUMAN_LINE_MAX_CHARS);
    expect(sendableText(`\n${full}  `)).toBe(full);
    expect(sendableText(`${full}y`)).toBeUndefined();
    // UTF-16 units, as zod's `.max` and `.length` count: an emoji is two.
    expect(sendableText('😀'.repeat(HUMAN_LINE_MAX_CHARS / 2))).toBeDefined();
    expect(sendableText(`😀${'x'.repeat(HUMAN_LINE_MAX_CHARS - 1)}`)).toBeUndefined();
    expect(sendableText('x'.repeat(3000))?.length).toBe(3000);
    expect(sendableText('abcd', 3)).toBeUndefined();
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
