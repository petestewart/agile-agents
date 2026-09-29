import { describe, expect, test } from 'bun:test';
import type { FavouriteModel } from '@agile-agents/shared';
import {
  NO_PICKER_PREFS,
  OTHERS_GROUP,
  type PickerView,
  type PickerViewInput,
  isFavourite,
  matchesQuery,
  parsePickerPrefs,
  pickerView,
  toggleFold,
  unlistedReason,
} from './favourites';

const known = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'opus'],
  gemini: [],
  codex: [],
  cursor: [],
};
const vendors = ['claude', 'gemini', 'codex', 'cursor'];
const lists = {
  codex: {
    options: [
      { value: 'gpt-5.5', name: 'GPT-5.5' },
      { value: 'gpt-5.5-mini', name: 'GPT-5.5 mini' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
    ],
    at: '2026-09-29T10:00:00.000Z',
  },
  cursor: {
    options: [
      { value: 'default[]', name: 'Auto' },
      { value: 'grok-4.7[context=256k,fast=true]', name: 'grok-4.7' },
    ],
    current: 'default[]',
    at: '2026-09-29T10:00:00.000Z',
  },
};

function view(over: Partial<PickerViewInput> = {}): PickerView {
  return pickerView({
    known,
    vendors,
    lists,
    favourites: [],
    keep: [],
    showAll: false,
    query: '',
    folded: [],
    ...over,
  });
}

/** Each group as `label: model, model`. */
function shown(v: PickerView): string[] {
  return v.groups.map(
    (g) =>
      `${g.label}${g.folded ? ` (folded, ${g.count})` : ''}: ${g.rows.map((r) => r.model ?? '-').join(', ')}`,
  );
}

const favourites: FavouriteModel[] = [
  { vendor: 'claude', model: 'claude-opus-5-5' },
  { vendor: 'claude', model: 'claude-sonnet-5-5' },
  { vendor: 'codex', model: 'gpt-5.5' },
  { vendor: 'codex', model: 'gpt-5.4' },
];

describe('the picker with favourites (T469)', () => {
  test('no favourites: every model, as before, and no Show all', () => {
    const v = view();
    expect(v.hasFavourites).toBe(false);
    expect(v.hidden).toBe(0);
    expect(shown(v)).toEqual([
      'Claude: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5',
      'Codex: gpt-5.5, gpt-5.5-mini, gpt-5.4',
      'Cursor: default[], grok-4.7[context=256k,fast=true]',
      'Other agents: -',
    ]);
    expect(v.groups.every((g) => g.rows.every((r) => !r.favourite))).toBe(true);
  });

  test('favourites: only those, grouped by vendor in the usual order, plus what runs', () => {
    const v = view({
      favourites,
      keep: [{ vendor: 'cursor', model: 'grok-4.7[context=256k,fast=true]' }],
    });
    expect(v.hasFavourites).toBe(true);
    expect(shown(v)).toEqual([
      'Claude: claude-opus-5-5, claude-sonnet-5-5',
      'Codex: gpt-5.5, gpt-5.4',
      'Cursor: grok-4.7[context=256k,fast=true]',
    ]);
    // Show all would add Haiku, GPT-5.5 mini, Cursor's Auto and Gemini's default.
    expect(v.hidden).toBe(4);
    expect(v.groups[0]?.rows.every((r) => r.favourite)).toBe(true);
    expect(v.groups[2]?.rows[0]?.favourite).toBe(false);
  });

  test("the pick is kept even when it isn't a favourite; the default alone is not", () => {
    const v = view({
      favourites,
      keep: [{ vendor: 'gemini' }],
      extra: [{ vendor: 'claude', model: 'claude-haiku-4-5' }],
    });
    expect(shown(v)).toEqual([
      'Claude: claude-opus-5-5, claude-sonnet-5-5',
      'Codex: gpt-5.5, gpt-5.4',
      'Other agents: -',
    ]);
  });

  test('Show all: every vendor, the stars still marked', () => {
    const v = view({ favourites, showAll: true });
    expect(v.hidden).toBe(0);
    expect(shown(v)).toEqual(shown(view()));
    const codex = v.groups.find((g) => g.key === 'codex');
    expect(codex?.rows.map((r) => r.favourite)).toEqual([true, false, true]);
  });

  test('a folded group keeps its header and count, with no rows', () => {
    const v = view({ favourites, folded: ['codex'] });
    expect(shown(v)).toEqual(['Claude: claude-opus-5-5, claude-sonnet-5-5', 'Codex (folded, 2): ']);
    const all = view({ showAll: true, folded: [OTHERS_GROUP, 'claude'] });
    expect(all.groups.map((g) => [g.key, g.folded])).toEqual([
      ['claude', true],
      ['codex', false],
      ['cursor', false],
      [OTHERS_GROUP, true],
    ]);
  });

  test('typing searches every model, favourite or not, and ignores the folds', () => {
    const v = view({ favourites, folded: ['codex'], query: 'GPT mini' });
    expect(v.searching).toBe(true);
    expect(v.hidden).toBe(0);
    expect(shown(v)).toEqual(['Codex: gpt-5.5-mini']);
    // By name, by id, by vendor; every word must match.
    expect(shown(view({ favourites, query: 'haiku' }))).toEqual(['Claude: claude-haiku-4-5']);
    expect(shown(view({ query: 'context=256k' }))).toEqual([
      'Cursor: grok-4.7[context=256k,fast=true]',
    ]);
    expect(shown(view({ query: 'cursor auto' }))).toEqual(['Cursor: default[]']);
    expect(shown(view({ query: 'gemini' }))).toEqual(['Other agents: -']);
    expect(view({ query: 'nothing like it' }).groups).toEqual([]);
    // Blank is not a search.
    expect(view({ favourites, query: '   ' }).searching).toBe(false);
  });

  test('a favourite its vendor no longer lists still shows, marked, so it can be unstarred', () => {
    const v = view({ favourites: [...favourites, { vendor: 'cursor', model: 'sonnet-4.5' }] });
    const cursor = v.groups.find((g) => g.key === 'cursor');
    expect(cursor?.rows).toEqual([
      {
        vendor: 'cursor',
        model: 'sonnet-4.5',
        label: 'sonnet-4.5',
        favourite: true,
        unlisted: "Not in Cursor's list now",
      },
    ]);
    // A vendor that never reported a list: a typed id is not "dropped".
    expect(unlistedReason({ vendor: 'gemini', model: 'gemini-3' }, lists)).toBeUndefined();
    expect(unlistedReason({ vendor: 'codex', model: 'gpt-5.5' }, lists)).toBeUndefined();
    expect(unlistedReason({ vendor: 'cursor' }, lists)).toBeUndefined();
    expect(unlistedReason({ vendor: 'codex', model: 'gpt-4' }, lists)).toBe(
      "Not in Codex's list now",
    );
  });

  test("a vendor's own default can be a favourite", () => {
    const v = view({ favourites: [{ vendor: 'gemini' }] });
    expect(shown(v)).toEqual(['Other agents: -']);
    expect(isFavourite({ vendor: 'gemini', model: 'default' }, [{ vendor: 'gemini' }])).toBe(true);
    expect(isFavourite({ vendor: 'codex' }, [{ vendor: 'gemini' }])).toBe(false);
  });

  test('matchesQuery reads the name, the id and the vendor, ignoring case', () => {
    const row = { vendor: 'claude', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' };
    expect(matchesQuery(row, 'OPUS')).toBe(true);
    expect(matchesQuery(row, 'opus 5.5')).toBe(true);
    expect(matchesQuery(row, 'opus-5-5')).toBe(true);
    expect(matchesQuery(row, 'sonnet')).toBe(false);
    expect(matchesQuery(row, '')).toBe(true);
  });
});

describe('the picker kept per browser (T469)', () => {
  test('stored prefs read back field by field; anything else is dropped', () => {
    expect(parsePickerPrefs(null)).toEqual(NO_PICKER_PREFS);
    expect(parsePickerPrefs('not json')).toEqual(NO_PICKER_PREFS);
    expect(parsePickerPrefs('null')).toEqual(NO_PICKER_PREFS);
    expect(parsePickerPrefs('{"folded":["codex",3],"showAll":true}')).toEqual({
      folded: ['codex'],
      showAll: true,
    });
    expect(parsePickerPrefs('{"folded":"codex","showAll":"yes"}')).toEqual(NO_PICKER_PREFS);
  });

  test('toggleFold folds an open group and opens a folded one', () => {
    const one = toggleFold(NO_PICKER_PREFS, 'codex');
    expect(one).toEqual({ folded: ['codex'], showAll: false });
    expect(toggleFold(one, 'claude').folded).toEqual(['codex', 'claude']);
    expect(toggleFold(one, 'codex').folded).toEqual([]);
  });
});
