import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODEL_PROFILES, resolveModelPolicy } from '@agile-agents/shared';
import {
  confidenceWords,
  isPreset,
  moveRule,
  pickLine,
  pickSourceWords,
  pinnedRuleWords,
  presetsWords,
  profileRows,
  qualityWords,
  scoreRows,
  setHere,
  sourceWords,
  togglePreset,
} from './model-policy';

describe('model choice words (T482)', () => {
  test('quality priority in words', () => {
    expect(qualityWords(0)).toBe('Favor speed & cost');
    expect(qualityWords(50)).toBe('Balanced');
    expect(qualityWords(100)).toBe('Favor quality');
  });

  test('where a field comes from: set here, or inherited', () => {
    const view = {
      policy: { mode: 'inherit' as const },
      resolved: resolveModelPolicy({
        node: { mode: 'inherit' },
        project: { name: 'shop', policy: { quality: 70 } },
      }),
    };
    expect(setHere(view, 'mode')).toBe(true);
    expect(sourceWords(view, 'mode', 'node')).toBe('set here');
    expect(setHere(view, 'quality')).toBe(false);
    expect(sourceWords(view, 'quality', 'node')).toBe('from the project (shop)');
    expect(sourceWords(view, 'escalation', 'node')).toBe('from Home');
    expect(sourceWords(view, 'escalation', 'home')).toBe('built in');
  });

  test('preset models as a set; never "allowed"', () => {
    const one = togglePreset([], { vendor: 'claude', model: 'claude-sonnet-5-5' }, true);
    expect(one).toEqual([{ vendor: 'claude', model: 'claude-sonnet-5-5' }]);
    expect(togglePreset(one, { vendor: 'claude', model: 'claude-sonnet-5-5' }, true)).toEqual(one);
    const two = togglePreset(one, { vendor: 'gemini' }, true);
    expect(two.at(-1)).toEqual({ vendor: 'gemini', model: 'default' });
    expect(isPreset(two, { vendor: 'gemini', model: 'default' })).toBe(true);
    expect(togglePreset(two, { vendor: 'claude', model: 'claude-sonnet-5-5' }, false)).toEqual([
      { vendor: 'gemini', model: 'default' },
    ]);
    expect(presetsWords([])).toBe('Any installed model');
    expect(presetsWords(one)).toBe('Claude Sonnet 5.5');
    expect(presetsWords(two)).not.toMatch(/allowed/i);
  });

  test('how the model was picked', () => {
    expect(
      pickLine({
        vendor: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        how: 'rule',
        why: 'start cheap: the cheapest balanced preset model (no classifier key)',
        at: 'now',
      }),
    ).toBe(
      'Claude Sonnet 5.5 · medium — start cheap: the cheapest balanced preset model (no classifier key)',
    );
    expect(
      pickLine({ vendor: 'codex', model: 'gpt-5.5', how: 'explicit', why: 'your pick', at: 'now' }),
    ).toBe('gpt-5.5 — your pick');
  });

  test('profiles sort by vendor, then strongest first', () => {
    const rows = profileRows(DEFAULT_MODEL_PROFILES, {
      'claude/sonnet': { tier: 'fast', cost: 1 },
    });
    expect(rows[0]?.vendor).toBe('claude');
    expect(rows[0]?.profile.tier).toBe('strongest');
    expect(rows.find((r) => r.key === 'claude/sonnet')?.own).toBe(true);
    expect(rows.at(-1)?.vendor).toBe('codex');
  });
});

describe('the chooser in words (T483)', () => {
  test('the five scores, one decimal each, in order', () => {
    const rows = scoreRows({ clarity: 4.62, verifiability: 4, horizon: 1.5, stakes: 2, volume: 5 });
    expect(rows.map((r) => `${r.label} ${r.value}`)).toEqual([
      'Clarity 4.6',
      'Verifiability 4.0',
      'Horizon 1.5',
      'Stakes 2.0',
      'Volume 5.0',
    ]);
  });

  test('confidence says whether it decided', () => {
    expect(confidenceWords(0.82)).toBe('0.82: sure enough to decide');
    expect(confidenceWords(0.41)).toBe('0.41: not sure, so the scores decided');
  });

  test('where a pick came from, a clamp naming its route', () => {
    expect(pickSourceWords({ how: 'jev' })).toBe('Jev');
    expect(pickSourceWords({ how: 'scores' })).toBe('the scores');
    expect(pickSourceWords({ how: 'clamp', base: 'jev' })).toBe(
      'Jev, then clamped into the preset models',
    );
  });

  test('a pinned rule in words, and reordering', () => {
    const rule = {
      when: { role: 'coordinator' as const, topic: 'security' as const },
      pick: { vendor: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' as const },
    };
    expect(pinnedRuleWords(rule)).toBe('coordinator + security work → Claude Opus 5.5 · high');
    expect(moveRule(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRule(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
