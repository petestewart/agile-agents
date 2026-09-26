import { describe, expect, test } from 'bun:test';
import { parseDiff } from './chat';
import { renderMarkdown } from './markdown';
import {
  MESSAGE_MAX,
  REVIEW_HEADING,
  ReviewStore,
  appendToDraft,
  codeSpan,
  formatReview,
  isOutdated,
  lineLabel,
  lineRef,
  newComment,
  orderComments,
  reviewSummary,
  roomAfter,
  rowKey,
  rowsBetween,
} from './review';

const PATCH = [
  'diff --git a/src/import.ts b/src/import.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/import.ts',
  '@@ -0,0 +1,4 @@',
  '+export function importCsv(text: string) {',
  "+  const rows = text.split('\\n');",
  '+  return rows.map((row) => row.split(`,`));',
  '+}',
  'diff --git a/src/ledger.ts b/src/ledger.ts',
  '--- a/src/ledger.ts',
  '+++ b/src/ledger.ts',
  '@@ -1,3 +1,3 @@',
  ' export interface Entry {',
  '-  amount: number;',
  '+  cents: number;',
  ' }',
  '@@ -10,2 +10,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
].join('\n');

const files = parseDiff(PATCH);
const importTs = files[0] as (typeof files)[number];
const ledgerTs = files[1] as (typeof files)[number];

describe('anchors', () => {
  test('a row key is its new line, a removed row its old line, a hunk none', () => {
    expect(ledgerTs.rows.map(rowKey)).toEqual([
      undefined,
      'n1',
      'o2',
      'n2',
      'n3',
      undefined,
      'n10',
      'o11',
      'n11',
    ]);
  });

  test('the rows between two keys, in either order, inside one hunk', () => {
    expect(rowsBetween(ledgerTs, 'n2', 'n1')?.map((r) => r.text)).toEqual([
      ' export interface Entry {',
      '-  amount: number;',
      '+  cents: number;',
    ]);
    expect(rowsBetween(ledgerTs, 'n3', 'n10')).toBeUndefined();
    expect(rowsBetween(ledgerTs, 'n1', 'n99')).toBeUndefined();
  });

  test('lines read on the new side; a run of removed lines on the old side', () => {
    expect(lineRef(rowsBetween(ledgerTs, 'n1', 'n2') ?? [])).toEqual({
      lines: '1–2',
      removed: false,
    });
    expect(lineRef(rowsBetween(ledgerTs, 'o2', 'o2') ?? [])).toEqual({
      lines: '2',
      removed: true,
    });
    expect(lineLabel({ lines: '4', removed: false })).toBe('Line 4');
    expect(lineLabel({ lines: '12–14', removed: false })).toBe('Lines 12–14');
    expect(lineLabel({ lines: '2', removed: true })).toBe('Removed line 2');
  });

  test('a new comment keeps its lines and their text; unknown lines give none', () => {
    const c = newComment(importTs, 'n3', 'n2', '  Use a real parser.  ', 'c1');
    expect(c).toEqual({
      id: 'c1',
      path: 'src/import.ts',
      start: 'n2',
      end: 'n3',
      quote: ["  const rows = text.split('\\n');", '  return rows.map((row) => row.split(`,`));'],
      lines: '2–3',
      removed: false,
      body: 'Use a real parser.',
    });
    expect(newComment(importTs, 'n40', 'n40', 'x', 'c2')).toBeUndefined();
  });
});

describe('outdated', () => {
  const c = newComment(ledgerTs, 'n11', 'n11', 'Why 3?', 'c1');
  if (!c) throw new Error('no comment');

  test('current while its lines read the same', () => {
    expect(isOutdated(c, files)).toBe(false);
  });

  test('outdated when the line reads differently, is gone, or its file left the diff', () => {
    const changed = parseDiff(PATCH.replace('+const b = 3;', '+const b = 4;'));
    expect(isOutdated(c, changed)).toBe(true);
    const shorter = parseDiff(PATCH.split('@@ -10,2')[0] as string);
    expect(isOutdated(c, shorter)).toBe(true);
    expect(isOutdated(c, [importTs])).toBe(true);
  });
});

describe('reviewSummary', () => {
  test('counts comments and files, singular and plural', () => {
    const a = newComment(importTs, 'n1', 'n1', 'a', 'c1');
    const b = newComment(importTs, 'n2', 'n2', 'b', 'c2');
    const d = newComment(ledgerTs, 'n2', 'n2', 'd', 'c3');
    if (!a || !b || !d) throw new Error('no comment');
    expect(reviewSummary([a])).toBe('1 comment on 1 file');
    expect(reviewSummary([a, b, d])).toBe('3 comments on 2 files');
  });
});

describe('formatReview', () => {
  const one = (file: typeof importTs, start: string, end: string, body: string, id: string) => {
    const c = newComment(file, start, end, body, id);
    if (!c) throw new Error(`no comment at ${start}`);
    return c;
  };

  test('a heading, then one numbered item per comment in diff order: path:line, the line, the comment', () => {
    // Written out of order: the ledger first, then the import file bottom-up.
    const comments = [
      one(ledgerTs, 'n2', 'n2', 'Keep the old name for one release.', 'c1'),
      one(importTs, 'n4', 'n4', 'Trailing newline?', 'c2'),
      one(
        importTs,
        'n2',
        'n2',
        "Quoted fields can hold a newline;\n\nsplit('\\n') breaks them.",
        'c3',
      ),
    ];
    const { text, fits } = formatReview(comments, files);
    expect(fits).toBe(true);
    expect(text).toBe(
      [
        REVIEW_HEADING,
        '',
        '1. `src/import.ts:2`',
        "   `const rows = text.split('\\n');`",
        '   Quoted fields can hold a newline;',
        "   split('\\n') breaks them.",
        '2. `src/import.ts:4`',
        '   `}`',
        '   Trailing newline?',
        '3. `src/ledger.ts:2`',
        '   `cents: number;`',
        '   Keep the old name for one release.',
      ].join('\n'),
    );
    expect(text).not.toContain('c1');
  });

  test('a range reads path:12–14 and quotes its first and last line; removed lines say so', () => {
    const three = one(importTs, 'n1', 'n3', 'Three.', 'c0');
    expect(formatReview([three], files).text.split('\n').slice(2)).toEqual([
      '1. `src/import.ts:1–3`',
      '   `export function importCsv(text: string) {`',
      "   `const rows = text.split('\\n');`",
      '   `` return rows.map((row) => row.split(`,`)); ``',
      '   Three.',
    ]);
    const range = one(importTs, 'n1', 'n4', 'Split this up.', 'c1');
    const removed = one(ledgerTs, 'o2', 'o2', 'Callers still read amount.', 'c2');
    const { text } = formatReview([range, removed], files);
    expect(text).toContain(
      [
        '1. `src/import.ts:1–4`',
        '   `export function importCsv(text: string) {`',
        '   …',
        '   `}`',
        '   Split this up.',
      ].join('\n'),
    );
    expect(text).toContain(
      [
        '2. `src/ledger.ts:2` (removed)',
        '   `amount: number;`',
        '   Callers still read amount.',
      ].join('\n'),
    );
  });

  test('a line with backticks is quoted with a longer fence', () => {
    expect(codeSpan('a `b` c')).toBe('`` a `b` c ``');
    expect(codeSpan('plain')).toBe('`plain`');
    const c = one(importTs, 'n3', 'n3', 'Quoted commas?', 'c1');
    expect(formatReview([c], files).text).toContain(
      '   `` return rows.map((row) => row.split(`,`)); ``',
    );
  });

  test('a long line is clipped; an outdated comment says so and keeps its quote', () => {
    const long = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,1 +1,1 @@',
        `+const x = [${'1, '.repeat(60)}];`,
      ].join('\n'),
    );
    const c = one(long[0] as typeof importTs, 'n1', 'n1', 'Too long.', 'c1');
    const quoted = formatReview([c], long).text.split('\n')[3] as string;
    expect(quoted.length).toBeLessThanOrEqual(3 + 80 + 2);
    expect(quoted).toEndWith('…`');

    const gone = one(ledgerTs, 'n11', 'n11', 'Why 3?', 'c2');
    const after = parseDiff(PATCH.replace('+const b = 3;', '+const b = 4;'));
    expect(formatReview([gone], after).text).toContain(
      '1. `src/ledger.ts:11` (outdated)\n   `const b = 3;`\n   Why 3?',
    );
  });

  test('it fits the cap by shortening quotes, then dropping them; else fits is false', () => {
    const comments = Array.from({ length: 4 }, (_, i) =>
      one(importTs, `n${i + 1}`, `n${i + 1}`, `note ${i}`, `c${i}`),
    );
    const full = formatReview(comments, files).text;
    const tight = formatReview(comments, files, full.length - 1);
    expect(tight.fits).toBe(true);
    expect(tight.text.length).toBeLessThan(full.length);
    const bare = formatReview(comments, files, 150);
    expect(bare.fits).toBe(true);
    expect(bare.text).not.toContain('importCsv');
    expect(bare.text).toContain('1. `src/import.ts:1`\n   note 0');
    const none = formatReview(comments, files, 40);
    expect(none.fits).toBe(false);
    expect(formatReview(comments, files).text.length).toBeLessThanOrEqual(MESSAGE_MAX);
  });

  test('the cockpit renders it as one numbered list, each item with its quote and comment', () => {
    const comments = [
      one(importTs, 'n2', 'n2', 'First.', 'c1'),
      one(ledgerTs, 'n2', 'n2', 'Second.', 'c2'),
    ];
    const html = renderMarkdown(formatReview(comments, files).text);
    expect(html).toBe(
      [
        `<p>${REVIEW_HEADING}</p><ol>`,
        '<li><code>src/import.ts:2</code><br><code>const rows = text.split(&#39;\\n&#39;);</code><br>First.</li>',
        '<li><code>src/ledger.ts:2</code><br><code>cents: number;</code><br>Second.</li></ol>',
      ].join(''),
    );
  });

  test('comments on files no longer in the diff come last', () => {
    const a = one(ledgerTs, 'n1', 'n1', 'a', 'c1');
    const b = one(importTs, 'n1', 'n1', 'b', 'c2');
    expect(orderComments([a, b], [ledgerTs]).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(orderComments([a, b], files).map((c) => c.id)).toEqual(['c2', 'c1']);
  });
});

describe('the draft', () => {
  test('the review goes after the draft with a blank line, or alone', () => {
    expect(appendToDraft('', 'R')).toBe('R');
    expect(appendToDraft('  \n', 'R')).toBe('R');
    expect(appendToDraft('Also: rebase first.\n', 'R')).toBe('Also: rebase first.\n\nR');
  });

  test('the room left is the cap less the draft and its blank line', () => {
    expect(roomAfter('')).toBe(MESSAGE_MAX);
    expect(roomAfter('abc\n')).toBe(MESSAGE_MAX - 5);
  });
});

describe('ReviewStore', () => {
  test('keeps comments per node, tells subscribers, and forgets an emptied node', () => {
    const store = new ReviewStore();
    const c = newComment(importTs, 'n1', 'n1', 'a', store.nextId());
    if (!c) throw new Error('no comment');
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    expect(store.get('N1').comments).toEqual([]);
    store.update('N1', (r) => ({ ...r, comments: [...r.comments, c] }));
    expect(store.get('N1').comments).toEqual([c]);
    expect(store.get('N2').comments).toEqual([]);
    const before = store.get('N1');
    expect(store.get('N1')).toBe(before);
    store.set('N1', { comments: [] });
    expect(store.get('N1').comments).toEqual([]);
    expect(calls).toBe(2);
    off();
    store.set('N1', { comments: [c] });
    expect(calls).toBe(2);
    expect(store.nextId()).not.toBe(c.id);
  });
});
