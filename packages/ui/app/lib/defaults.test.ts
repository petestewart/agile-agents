import { describe, expect, test } from 'bun:test';
import type { SessionDefaultsStatus } from '@agile-agents/shared';
import {
  choiceOf,
  effortWord,
  foldedRepos,
  inheritingReposText,
  modelChip,
  modelForVendor,
  modelGroups,
  modelSelectOptions,
  resolvedFor,
  sameSession,
} from './defaults';

const status: SessionDefaultsStatus = {
  builtin: { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' },
  home: { effort: 'medium' },
  resolved: { vendor: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  repos: {
    shop: {
      model: 'claude-sonnet-4-6',
      resolved: { vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'medium' },
    },
  },
  vendors: ['claude', 'gemini'],
  known_models: { claude: [], gemini: [], cursor: [], grok: [], pi: [], codex: [] },
};

describe('resolvedFor (T379)', () => {
  test('the repo, else the global default', () => {
    expect(resolvedFor(status, 'shop').model).toBe('claude-sonnet-4-6');
    expect(resolvedFor(status, undefined)).toEqual(status.resolved);
    expect(resolvedFor(status, 'unknown')).toEqual(status.resolved);
    expect(resolvedFor(status, 'shop', {}).model).toBe('claude-sonnet-4-6');
  });

  test("a project's own defaults come before the repo's, field by field", () => {
    expect(resolvedFor(status, 'shop', { effort: 'high' })).toEqual({
      vendor: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
    expect(resolvedFor(status, 'shop', { model: 'claude-haiku-4-5' })).toEqual({
      vendor: 'claude',
      model: 'claude-haiku-4-5',
      effort: 'medium',
    });
    expect(resolvedFor(status, undefined, { model: 'claude-haiku-4-5' }).effort).toBe('medium');
  });

  test("another vendor with no model named uses the provider's own default", () => {
    expect(resolvedFor(status, undefined, { vendor: 'gemini' })).toEqual({
      vendor: 'gemini',
      effort: 'medium',
    });
  });
});

describe('the model picker (T423)', () => {
  const known = {
    claude: ['claude-opus-5-5', 'claude-sonnet-4-6', 'opus', 'sonnet'],
    gemini: [],
    codex: [],
  };
  const vendors = ['claude', 'gemini', 'codex'];

  test('models by name, grouped by vendor; aliases left out; the others by their default', () => {
    expect(modelGroups(known, vendors)).toEqual([
      {
        label: 'Claude',
        options: [
          { vendor: 'claude', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
          { vendor: 'claude', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        ],
      },
      {
        label: 'Other agents',
        options: [
          { vendor: 'gemini', label: 'Gemini default model' },
          { vendor: 'codex', label: 'Codex default model' },
        ],
      },
    ]);
  });

  test('what runs or is picked always shows, even when the list lacks it', () => {
    const groups = modelGroups(known, vendors, [
      { vendor: 'claude', model: 'opus' },
      { vendor: 'codex', model: 'gpt-9' },
      { vendor: 'claude', model: 'claude-opus-5-5' },
      { vendor: 'gemini', model: 'default' },
    ]);
    expect(groups[0]?.options.map((o) => o.label)).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 4.6',
      'Claude Opus',
    ]);
    expect(groups[1]?.options.map((o) => o.label)).toEqual([
      'Gemini default model',
      'Codex default model',
      'Codex · gpt-9',
    ]);
  });

  test('sameSession: the effort counts only where the vendor uses it', () => {
    const opus = { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' } as const;
    expect(sameSession(opus, { ...opus })).toBe(true);
    expect(sameSession(opus, { ...opus, effort: 'high' })).toBe(false);
    expect(sameSession(opus, { ...opus, model: 'claude-sonnet-4-6' })).toBe(false);
    expect(
      sameSession({ vendor: 'gemini', effort: 'low' }, { vendor: 'gemini', effort: 'max' }),
    ).toBe(true);
    expect(
      sameSession({ vendor: 'gemini', effort: 'low' }, { vendor: 'codex', effort: 'low' }),
    ).toBe(false);
  });

  test("choiceOf reads a session record: 'default' is the vendor's own model", () => {
    expect(choiceOf({ vendor: 'gemini', model: 'default' }, 'low')).toEqual({
      vendor: 'gemini',
      effort: 'low',
    });
    expect(choiceOf({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'low')).toEqual(
      { vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    );
  });

  test('the Model select: what it inherits first, the known models by name, then the value', () => {
    expect(modelSelectOptions(known, 'claude', '', 'Claude Opus 5.5')).toEqual([
      { value: '', label: 'Inherits Claude Opus 5.5' },
      { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ]);
    expect(modelSelectOptions(known, 'gemini', 'gemini-3-pro').map((o) => o.label)).toEqual([
      'Gemini default model',
      'gemini-3-pro',
    ]);
    expect(modelSelectOptions(known, 'claude', 'sonnet').at(-1)).toEqual({
      value: 'sonnet',
      label: 'Claude Sonnet',
    });
  });

  test('a changed vendor keeps the model only when it lists it (T402)', () => {
    expect(modelForVendor(known, 'gemini', 'claude-opus-5-5')).toBe('');
    expect(modelForVendor(known, 'claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelForVendor(known, 'claude', '')).toBe('');
  });

  test('effort in words', () => {
    expect(effortWord('low')).toBe('Low');
    expect(effortWord('max')).toBe('Max');
  });

  describe('the composer chip', () => {
    const fallback = { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' } as const;
    const sonnet = { vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'high' } as const;

    test('with nothing picked it names the default, and says a pick lasts one message', () => {
      const chip = modelChip({ fallback });
      expect(chip).toMatchObject({ state: 'default', label: 'Claude Opus 5.5 · low' });
      expect(chip.pending).toBeUndefined();
      expect(chip.title).toContain('resets to the default after you send');
    });

    test('a pick is pending until the next message; picking the default again is no pick', () => {
      const chip = modelChip({ fallback, chosen: sonnet });
      expect(chip).toMatchObject({
        state: 'chosen',
        label: 'Claude Sonnet 4.6 · high',
        pending: sonnet,
      });
      expect(chip.title).toBe(
        'Your next message starts the agent with Claude Sonnet 4.6 · high. It resets to Claude Opus 5.5 · low after you send.',
      );
      expect(modelChip({ fallback, chosen: { ...fallback } }).state).toBe('default');
    });

    test('with a live agent it names what runs; another pick restarts it', () => {
      expect(modelChip({ fallback, live: sonnet })).toMatchObject({
        state: 'live',
        label: 'Claude Sonnet 4.6 · high',
      });
      expect(modelChip({ fallback, live: sonnet, chosen: { ...sonnet } }).state).toBe('live');
      const restart = modelChip({ fallback, live: sonnet, chosen: fallback });
      expect(restart).toMatchObject({ state: 'chosen', pending: fallback });
      expect(restart.title).toContain('restarts the agent with Claude Opus 5.5 · low');
    });
  });
});

describe('T436: Settings → Agents folds the repositories that set nothing', () => {
  test('two or more that inherit everything fold; one with a field of its own stays a card', () => {
    expect(
      foldedRepos({
        a: { resolved: status.resolved },
        b: { model: 'claude-sonnet-4-6', resolved: status.resolved },
        c: { resolved: status.resolved },
      }),
    ).toEqual(['a', 'c']);
    // One card is no longer than the row that would stand for it.
    expect(foldedRepos({ a: {}, b: { effort: 'high' } })).toEqual([]);
    expect(foldedRepos({})).toEqual([]);
  });

  test('the row says how many', () => {
    expect(inheritingReposText(5)).toBe('5 repositories use the global default');
    expect(inheritingReposText(1)).toBe('1 repository uses the global default');
  });
});
