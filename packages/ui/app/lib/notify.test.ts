import { describe, expect, test } from 'bun:test';
import type { InboxItem } from '@agile-agents/shared';
import {
  BODY_MAX_CHARS,
  NOTIFY_TAG,
  TITLE_MAX_CHARS,
  clip,
  diffInbox,
  itemHeadline,
  itemKey,
  itemLine,
  notificationFor,
  plainLine,
  stillWaiting,
} from './notify';

const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const NODE_B = '01ARZ3NDEKTSV4RRFFQ69G5FA2';

let n = 0;
function item(fields: Partial<InboxItem> & Pick<InboxItem, 'kind'>): InboxItem {
  n++;
  return {
    id: `Q-${String(n).padStart(4, '0')}`,
    stream: NODE,
    stream_path: ['Shop', 'Ledger export format'],
    ts: '2026-09-26T10:00:00.000Z',
    context: 'something',
    ...fields,
  } as InboxItem;
}

describe('diffInbox (T388): which items are new', () => {
  test('the first frame is seen, never new', () => {
    const a = item({ kind: 'question' });
    const b = item({ kind: 'gate', context: 'classifier_review: edit x — why' });
    const first = diffInbox(undefined, [a, b]);
    expect(first.fresh).toEqual([]);
    expect([...first.seen].sort()).toEqual([itemKey(a), itemKey(b)].sort());
  });

  test('an item not in the last frames is new; one already seen is not', () => {
    const a = item({ kind: 'question' });
    const b = item({ kind: 'question' });
    const c = item({ kind: 'done', id: NODE_B, stream: NODE_B });
    const first = diffInbox(undefined, [a]);
    const second = diffInbox(first.seen, [a, b, c]);
    expect(second.fresh).toEqual([b, c]);
    const third = diffInbox(second.seen, [a, b, c]);
    expect(third.fresh).toEqual([]);
  });

  test('an item that leaves and comes back is not new again', () => {
    const a = item({ kind: 'question' });
    const b = item({ kind: 'question' });
    const first = diffInbox(undefined, []);
    const raised = diffInbox(first.seen, [a, b]);
    expect(raised.fresh).toEqual([a, b]);
    const gone = diffInbox(raised.seen, [b]);
    expect(gone.fresh).toEqual([]);
    const back = diffInbox(gone.seen, [a, b]);
    expect(back.fresh).toEqual([]);
  });

  test('an empty first frame makes everything after it new', () => {
    const first = diffInbox(undefined, []);
    expect(first.seen.size).toBe(0);
    const a = item({ kind: 'question' });
    expect(diffInbox(first.seen, [a]).fresh).toEqual([a]);
  });

  test('T391: a node that finishes again after a reply is news again', () => {
    const done = item({ kind: 'done', id: NODE, ts: '2026-09-26T10:00:00.000Z' });
    const first = diffInbox(undefined, []);
    const finished = diffInbox(first.seen, [done]);
    expect(finished.fresh).toEqual([done]);
    // You replied: it works (the card leaves), then finishes again.
    const working = diffInbox(finished.seen, []);
    const again = { ...done, ts: '2026-09-26T10:20:00.000Z' };
    expect(diffInbox(working.seen, [again]).fresh).toEqual([again]);
  });

  test("a node's blocked and done items are different things", () => {
    const blocked = item({ kind: 'blocked', id: NODE });
    const done = item({ kind: 'done', id: NODE });
    const first = diffInbox(undefined, [blocked]);
    expect(diffInbox(first.seen, [done]).fresh).toEqual([done]);
  });

  test('never changes the set it was given', () => {
    const first = diffInbox(undefined, []);
    diffInbox(first.seen, [item({ kind: 'question' })]);
    expect(first.seen.size).toBe(0);
  });
});

describe('stillWaiting (T388): what arrived while you were away', () => {
  test('keeps the earlier ones still open, then adds the fresh ones', () => {
    const a = item({ kind: 'question' });
    const b = item({ kind: 'question' });
    const c = item({ kind: 'question' });
    expect(stillWaiting([a], [b], [a, b])).toEqual([a, b]);
    // `a` was answered elsewhere in the meantime.
    expect(stillWaiting([a, b], [c], [b, c])).toEqual([b, c]);
    expect(stillWaiting([a], [], [])).toEqual([]);
  });

  test('takes the frame’s current copy, and never lists one twice', () => {
    const a = item({ kind: 'done', id: NODE, context: 'old' });
    const now = { ...a, context: 'new' };
    expect(stillWaiting([a], [a], [now])).toEqual([now]);
  });
});

describe('plainLine and clip (T388)', () => {
  test('the first line that says something, without Markdown', () => {
    expect(plainLine('\n\n## Which **date** format?\nISO or local')).toBe('Which date format?');
    expect(plainLine('- use `cents`, see [the doc](https://x.test/a)')).toBe(
      'use cents, see the doc',
    );
    expect(plainLine('> keep *it* short')).toBe('keep it short');
    expect(plainLine('rename snake_case_name now')).toBe('rename snake_case_name now');
    expect(plainLine('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(plainLine('   ')).toBe('');
  });

  test('clips at a word with an ellipsis', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('comma or semicolon for the dialect', 20)).toBe('comma or semicolon…');
    expect(clip('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
    expect(clip('one, two, three, four', 12).endsWith(',…')).toBe(false);
  });
});

describe('itemHeadline (T388): what it is and where, in words', () => {
  test('each kind', () => {
    expect(itemHeadline(item({ kind: 'question' }))).toBe('Question on Ledger export format');
    expect(itemHeadline(item({ kind: 'gate', context: 'classifier_review: edit x — why' }))).toBe(
      'Action to allow on Ledger export format',
    );
    expect(itemHeadline(item({ kind: 'gate', context: 'land: land stream/a into main' }))).toBe(
      'Merge to approve: Ledger export format',
    );
    expect(itemHeadline(item({ kind: 'rule_accept', knowledge_kind: 'decision' }))).toBe(
      'Decision proposed on Ledger export format',
    );
    expect(
      itemHeadline(
        item({
          kind: 'rule_accept',
          stream: undefined,
          stream_path: [],
          knowledge_kind: 'standard',
        }),
      ),
    ).toBe('Standard proposed');
    expect(
      itemHeadline(
        item({ kind: 'rule_batch', stream: undefined, stream_path: [], id: 'migration' }),
      ),
    ).toBe('Knowledge to review');
    expect(itemHeadline(item({ kind: 'plan_approve' }))).toBe(
      'Plan to approve: Ledger export format',
    );
    expect(itemHeadline(item({ kind: 'plan_waiting' }))).toBe(
      'Waiting for the plan: Ledger export format',
    );
    expect(
      itemHeadline(item({ kind: 'proposal', context: 'director proposes: start the api part' })),
    ).toBe('Director proposal on Ledger export format');
    expect(itemHeadline(item({ kind: 'done' }))).toBe('Ready to merge: Ledger export format');
    expect(itemHeadline(item({ kind: 'blocked' }))).toBe('Blocked: Ledger export format');
  });

  test("the node's title comes from the rows when known, else the path", () => {
    const lookup = (id: string) => (id === NODE ? { title: 'Add CSV import' } : undefined);
    expect(itemHeadline(item({ kind: 'done' }), lookup)).toBe('Ready to merge: Add CSV import');
    expect(itemHeadline(item({ kind: 'done', stream: NODE_B }), lookup)).toBe(
      'Ready to merge: Ledger export format',
    );
  });

  test('a finished node with nothing to merge says so (T380)', () => {
    const lookup = () => ({ title: 'Add CSV import', nothing_to_merge: true });
    expect(itemHeadline(item({ kind: 'done' }), lookup)).toBe(
      'Finished, no changes: Add CSV import',
    );
  });

  test('a long node title is clipped', () => {
    const long = 'a node whose title goes on and on well past what a notification title can hold';
    const headline = itemHeadline(item({ kind: 'question', stream_path: [long] }));
    expect(headline.startsWith('Question on a node whose')).toBe(true);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline.length).toBeLessThanOrEqual('Question on '.length + 56);
  });
});

describe('itemLine (T388): the first line of its text, plain, no ids', () => {
  test('a question: its stem, without the choices its text spells out', () => {
    expect(
      itemLine(
        item({
          kind: 'question',
          context: 'Which competitor should I start with? (A) Linear (B) Height',
        }),
      ),
    ).toBe('Which competitor should I start with?');
    expect(
      itemLine(
        item({
          kind: 'question',
          context: 'Which date format should the export use? ISO or local…',
          detail: 'Which date format should the export use?\nISO or local, and why.',
        }),
      ),
    ).toBe('Which date format should the export use?');
  });

  test('a routed call: the call and why; the rule id is gone', () => {
    expect(
      itemLine(
        item({
          kind: 'gate',
          context:
            'classifier_review: edit /tmp/wt/package.json — editing a dependency manifest is never automatic',
        }),
      ),
    ).toBe('edit /tmp/wt/package.json — editing a dependency manifest is never automatic');
    const line = itemLine(
      item({
        kind: 'gate',
        context:
          'classifier_review: bash: rm -rf dist — tests-with-src (K-01ARZ3NDEKTSV4RRFFQ69G5FAV): change tests with the source (probability 0.55)',
      }),
    );
    expect(line).toBe('bash: rm -rf dist — change tests with the source');
    expect(line).not.toContain('K-');
  });

  test('a merge to approve names the branch without its prefix', () => {
    expect(
      itemLine(
        item({
          kind: 'gate',
          context: 'land: land stream/01arz3ndektsv4rrffq69g5fa1-add-csv-import into main',
        }),
      ),
    ).toBe('Merge add-csv-import into main');
  });

  test('knowledge, a plan, a proposal, a finished and a blocked node', () => {
    expect(
      itemLine(
        item({
          kind: 'rule_accept',
          context: 'money-in-cents · global: Keep **money** in integer cents',
        }),
      ),
    ).toBe('Keep money in integer cents');
    expect(
      itemLine(
        item({
          kind: 'plan_approve',
          context:
            'Approve the plan for Sale prices: api owns `prices.ts`; web owns `shop.html`. Contracts: GET /price/:id',
        }),
      ),
    ).toBe('api owns prices.ts; web owns shop.html');
    expect(
      itemLine(item({ kind: 'proposal', context: 'coordinator proposes: start the api part' })),
    ).toBe('start the api part');
    expect(
      itemLine(item({ kind: 'done', context: 'Added the CSV importer.\n\nTests pass.' })),
    ).toBe('Added the CSV importer.');
    expect(itemLine(item({ kind: 'blocked', context: 'Needs a login to the bank API' }))).toBe(
      'Needs a login to the bank API',
    );
    expect(
      itemLine(
        item({
          kind: 'done',
          context:
            'The agent finished. Look over the changes, then merge — or close the node if you won’t.',
        }),
        () => ({ nothing_to_merge: true }),
      ),
    ).toBe(
      'The agent finished without committing anything, so there is nothing to merge. Close the node, or reply to ask for more.',
    );
  });

  test('a long text is clipped', () => {
    const line = itemLine(item({ kind: 'blocked', context: 'word '.repeat(60).trim() }));
    expect(line.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('notificationFor (T388): one notification', () => {
  test('nothing waiting, nothing to say', () => {
    expect(notificationFor([])).toBeUndefined();
  });

  test('one item: its headline, its line, and its node', () => {
    const q = item({ kind: 'question', context: 'Which date format should the export use?' });
    expect(notificationFor([q])).toEqual({
      title: 'Question on Ledger export format',
      body: 'Which date format should the export use?',
      tag: NOTIFY_TAG,
      node: NODE,
    });
  });

  test('knowledge on no node opens Needs me', () => {
    const batch = item({
      kind: 'rule_batch',
      id: 'migration',
      stream: undefined,
      stream_path: [],
      context: '12 proposed knowledge items imported from the old rules',
    });
    const content = notificationFor([batch]);
    expect(content?.title).toBe('Knowledge to review');
    expect(content?.body).toBe('12 proposed knowledge items imported from the old rules');
    expect(content?.node).toBeUndefined();
  });

  test('several: one notification with a count, the first headlines, and no node', () => {
    const lookup = (id: string) =>
      id === NODE_B ? { title: 'Add CSV import' } : { title: 'Ledger export format' };
    const q = item({ kind: 'question' });
    const done = item({ kind: 'done', id: NODE_B, stream: NODE_B });
    const gate = item({ kind: 'gate', context: 'classifier_review: edit x — why' });
    expect(notificationFor([q, done], lookup)).toEqual({
      title: '2 new things need you',
      body: 'Question on Ledger export format · Ready to merge: Add CSV import',
      tag: NOTIFY_TAG,
    });
    const three = notificationFor([q, done, gate], lookup);
    expect(three?.title).toBe('3 new things need you');
    expect(three?.body).toBe(
      'Question on Ledger export format · Ready to merge: Add CSV import · and 1 more',
    );
    expect(three?.node).toBeUndefined();
  });

  test('titles and bodies stay short, and "and N more" survives long headlines', () => {
    const long = 'x'.repeat(200);
    const one = notificationFor([item({ kind: 'question', stream_path: [long], context: long })]);
    expect(one?.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(one?.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    const many = notificationFor(
      [1, 2, 3, 4].map(() => item({ kind: 'question', stream_path: [long] })),
    );
    expect(many?.body.endsWith('and 2 more')).toBe(true);
    expect(many?.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
  });
});
