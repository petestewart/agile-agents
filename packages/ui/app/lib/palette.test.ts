/**
 * T368: the command palette's matching and ranking. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import {
  type PaletteEntry,
  flatResults,
  fuzzyScore,
  isMacPlatform,
  isPaletteKey,
  modKeyLabel,
  moveActive,
  paletteResults,
  parseRecent,
  pushRecent,
  recentNodes,
  scoreEntry,
} from './palette';

const node = (id: string, title: string, subtitle?: string): PaletteEntry => ({
  key: `node:${id}`,
  group: 'nodes',
  title,
  ...(subtitle !== undefined ? { subtitle } : {}),
});

const ENTRIES: PaletteEntry[] = [
  node('a', 'Add CSV import', 'Shop'),
  node('b', 'Fix rounding in totals', 'Shop'),
  node('c', 'api: add salePrice', 'Shop › Show sale prices'),
  node('d', 'Migrate docs to Astro', 'Blog'),
  { key: 'project:p', group: 'projects', title: 'Shop' },
  { key: 'view:inbox', group: 'views', title: 'Needs me', keywords: ['inbox'] },
  { key: 'view:rules', group: 'views', title: 'Knowledge', keywords: ['rules', 'standards'] },
  { key: 'view:running', group: 'views', title: 'Running' },
  { key: 'action:new-node', group: 'actions', title: 'New node' },
  { key: 'action:theme', group: 'actions', title: 'Switch to dark theme', keywords: ['theme'] },
];

describe('fuzzyScore', () => {
  test('an empty query matches everything', () => {
    expect(fuzzyScore('', 'anything')).toBeGreaterThan(0);
  });

  test('prefix > word start > substring > subsequence > none', () => {
    const prefix = fuzzyScore('add', 'Add CSV import');
    const word = fuzzyScore('csv', 'Add CSV import');
    const sub = fuzzyScore('sv', 'Add CSV import');
    const seq = fuzzyScore('adcsv', 'Add CSV import');
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThan(0);
    expect(fuzzyScore('zzz', 'Add CSV import')).toBe(0);
  });

  test('case does not matter', () => {
    expect(fuzzyScore('CSV', 'add csv import')).toBe(fuzzyScore('csv', 'Add CSV import'));
  });

  test('a later occurrence at a word start counts as a word start', () => {
    expect(fuzzyScore('sale', 'resale: show sale prices')).toBeGreaterThan(
      fuzzyScore('sale', 'resale prices'),
    );
  });

  test('a subsequence can be switched off (subtitles, keywords)', () => {
    expect(fuzzyScore('round', 'Repos, defaults, keys and trackers', false)).toBe(0);
    expect(fuzzyScore('keys', 'Repos, defaults, keys and trackers', false)).toBeGreaterThan(0);
  });

  test('a scattered two-letter match is noise', () => {
    expect(fuzzyScore('ae', 'Launch post outline')).toBe(0);
  });
});

describe('scoreEntry', () => {
  test('every word must match the title, subtitle or a keyword', () => {
    expect(scoreEntry('shop csv', ENTRIES[0] as PaletteEntry)).toBeGreaterThan(0);
    expect(scoreEntry('blog csv', ENTRIES[0] as PaletteEntry)).toBe(0);
  });

  test('a keyword finds a view by another name', () => {
    expect(scoreEntry('inbox', ENTRIES[5] as PaletteEntry)).toBeGreaterThan(0);
    expect(scoreEntry('rules', ENTRIES[6] as PaletteEntry)).toBeGreaterThan(0);
  });

  test('letters scattered through a subtitle do not match', () => {
    const settings: PaletteEntry = {
      key: 'view:settings',
      group: 'views',
      title: 'Settings',
      subtitle: 'Repos, defaults, keys and trackers',
    };
    expect(scoreEntry('round', settings)).toBe(0);
    expect(scoreEntry('trackers', settings)).toBeGreaterThan(0);
  });

  test('the title outranks the path', () => {
    expect(scoreEntry('shop', ENTRIES[4] as PaletteEntry)).toBeGreaterThan(
      scoreEntry('shop', ENTRIES[0] as PaletteEntry),
    );
  });
});

describe('paletteResults', () => {
  test('no query: recent nodes first (existing ones only), then views and actions', () => {
    const groups = paletteResults('', ENTRIES, ['d', 'gone', 'a']);
    expect(groups.map((g) => g.id)).toEqual(['recent', 'views', 'actions']);
    expect(groups[0]?.items.map((e) => e.key)).toEqual(['node:d', 'node:a']);
    expect(groups[0]?.label).toBe('Recent');
  });

  test('no query and nothing recent: views and actions', () => {
    expect(paletteResults('', ENTRIES).map((g) => g.id)).toEqual(['views', 'actions']);
  });

  test('part of a node title puts that node first', () => {
    const first = flatResults(paletteResults('rounding', ENTRIES))[0];
    expect(first?.key).toBe('node:b');
  });

  test('a view name puts the view first, above weaker node matches', () => {
    const groups = paletteResults('knowledge', ENTRIES);
    expect(groups[0]?.id).toBe('views');
    expect(flatResults(groups)[0]?.key).toBe('view:rules');
  });

  test('ties go to the more recent node', () => {
    const entries = [node('x', 'Deploy'), node('y', 'Deploy')];
    expect(flatResults(paletteResults('deploy', entries, ['y']))[0]?.key).toBe('node:y');
  });

  test('nothing matches: no groups', () => {
    expect(paletteResults('qqqqq', ENTRIES)).toEqual([]);
  });
});

describe('moveActive', () => {
  test('wraps at both ends', () => {
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(1, 1, 3)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(0);
  });
});

describe('recent nodes', () => {
  test('pushRecent moves an id to the front once and caps the list', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });

  test('parseRecent survives anything', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["a",2,"b"]')).toEqual(['a', 'b']);
  });
});

describe('keys', () => {
  test('⌘ on a Mac, Ctrl elsewhere', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(modKeyLabel('MacIntel')).toBe('⌘');
    expect(modKeyLabel('Linux x86_64')).toBe('Ctrl');
    expect(modKeyLabel('Win32')).toBe('Ctrl');
  });

  test('⌘K and Ctrl K open the palette; plain k or Ctrl Shift K do not', () => {
    const key = (k: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>>) => ({
      key: k,
      metaKey: mods.meta ?? false,
      ctrlKey: mods.ctrl ?? false,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
    });
    expect(isPaletteKey(key('k', { meta: true }))).toBe(true);
    expect(isPaletteKey(key('k', { ctrl: true }))).toBe(true);
    expect(isPaletteKey(key('K', { ctrl: true }))).toBe(true);
    expect(isPaletteKey(key('k', {}))).toBe(false);
    expect(isPaletteKey(key('k', { ctrl: true, shift: true }))).toBe(false);
    expect(isPaletteKey(key('j', { ctrl: true }))).toBe(false);
  });
});

describe('T416: This node, Needs me and the recent nodes', () => {
  const HERE: PaletteEntry[] = [
    { key: 'this:0', group: 'node', title: 'Merge' },
    { key: 'this:1', group: 'node', title: 'Open Changes' },
    { key: 'this:2', group: 'node', title: 'Copy branch name' },
  ];
  const NEEDS: PaletteEntry[] = Array.from({ length: 7 }, (_, i) => ({
    key: `needs:${i}`,
    group: 'needs' as const,
    title: i === 0 ? 'Answer: Should amounts be stored as cents?' : `Merge: node ${i}`,
    keywords: ['merge'],
  }));

  test('no query: this node first, then recent, what waits on you (five), views, actions', () => {
    const groups = paletteResults('', [...ENTRIES, ...HERE, ...NEEDS], ['a']);
    expect(groups.map((g) => g.id)).toEqual(['node', 'recent', 'needs', 'views', 'actions']);
    expect(groups[0]?.label).toBe('This node');
    expect(groups[0]?.items.map((e) => e.title)).toEqual([
      'Merge',
      'Open Changes',
      'Copy branch name',
    ]);
    expect(groups[2]?.label).toBe('Needs me');
    expect(groups[2]?.items).toHaveLength(5);
  });

  test('"merge" finds this node\'s Merge first', () => {
    const first = flatResults(paletteResults('merge', [...ENTRIES, ...HERE, ...NEEDS]))[0];
    expect(first?.key).toBe('this:0');
  });

  test('a Needs me item is found by its words', () => {
    const groups = paletteResults('amounts', [...ENTRIES, ...NEEDS]);
    expect(flatResults(groups)[0]?.key).toBe('needs:0');
  });

  test('recentNodes: the opened ones first, then what changed last; never the open node or a root', () => {
    const rows = [
      { id: 'a', role: 'work', updated_at: '2026-09-26T10:00:00Z' },
      { id: 'b', role: 'work', updated_at: '2026-09-26T12:00:00Z' },
      { id: 'c', role: 'conversation', updated_at: '2026-09-26T11:00:00Z' },
      { id: 'root', role: 'project', updated_at: '2026-09-26T13:00:00Z' },
      { id: 'd', role: 'work' },
    ];
    expect(recentNodes(['c', 'gone'], rows, 'b')).toEqual(['c', 'a']);
    expect(recentNodes([], rows, undefined)).toEqual(['b', 'c', 'a']);
    expect(recentNodes(['a', 'b', 'c'], rows, undefined, 2)).toEqual(['a', 'b']);
  });
});
