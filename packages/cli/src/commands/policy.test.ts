import { describe, expect, test } from 'bun:test';
import { builtinModelPolicy } from '@agile-agents/shared';
import { parsePolicyValue, policyField, policyValueText } from './policy';

describe('agile policy (T482)', () => {
  test('field names take - or _', () => {
    expect(policyField('effort-ceiling')).toBe('effort_ceiling');
    expect(policyField('pinned_rules')).toBe('pinned_rules');
    expect(() => policyField('allowed')).toThrow(/unknown field/);
  });

  test('values parse per field; inherit clears', () => {
    expect(parsePolicyValue('mode', 'choose')).toBe('choose');
    expect(parsePolicyValue('mode', 'inherit')).toBeNull();
    expect(() => parsePolicyValue('mode', 'always')).toThrow(/not one of/);
    expect(parsePolicyValue('escalation', 'strongest-first')).toBe('strongest_first');
    expect(parsePolicyValue('quality', '70')).toBe(70);
    expect(() => parsePolicyValue('quality', '120')).toThrow(/0 \(speed/);
    expect(parsePolicyValue('presets', 'claude/claude-sonnet-5-5, codex/gpt-5.5')).toEqual([
      { vendor: 'claude', model: 'claude-sonnet-5-5' },
      { vendor: 'codex', model: 'gpt-5.5' },
    ]);
    expect(parsePolicyValue('presets', 'any')).toEqual([]);
    expect(() => parsePolicyValue('presets', 'sonnet')).toThrow(/vendor\/model/);
    expect(parsePolicyValue('weights', 'clarity=2,stakes=3')).toEqual({ clarity: 2, stakes: 3 });
    expect(parsePolicyValue('guidance', 'Prefer Codex for Rust.')).toBe('Prefer Codex for Rust.');
    expect(parsePolicyValue('pinned_rules', '[]')).toEqual([]);
  });

  test('values in words', () => {
    const p = builtinModelPolicy();
    expect(policyValueText('presets', p)).toBe('any installed model');
    expect(policyValueText('mode', p)).toBe('choose');
    expect(policyValueText('guidance', p)).toBe('(none)');
  });
});
