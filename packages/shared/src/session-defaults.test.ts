import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_SESSION_DEFAULTS,
  SessionDefaultsPatchSchema,
  formatSessionDefaults,
  resolveSessionDefaults,
} from './session-defaults';

describe('T170 session defaults (D17)', () => {
  test('the order: flag → repo → home → built-in, field by field', () => {
    expect(resolveSessionDefaults()).toEqual({ ...BUILTIN_SESSION_DEFAULTS });
    const home = {
      default_vendor: 'claude',
      default_model: 'sonnet',
      default_effort: 'medium' as const,
    };
    expect(resolveSessionDefaults({ home })).toEqual({
      vendor: 'claude',
      model: 'sonnet',
      effort: 'medium',
    });
    expect(resolveSessionDefaults({ home, repo: { effort: 'high' } })).toMatchObject({
      model: 'sonnet',
      effort: 'high',
    });
    expect(
      resolveSessionDefaults({ home, repo: { effort: 'high' }, flags: { model: 'opus' } }),
    ).toEqual({ vendor: 'claude', model: 'opus', effort: 'high' });
  });

  test('the built-in model is a Claude id: another vendor falls to its own default', () => {
    const resolved = resolveSessionDefaults({ flags: { vendor: 'gemini' } });
    expect(resolved.model).toBeUndefined();
    expect(formatSessionDefaults(resolved)).toBe("gemini/gemini's own default model · low");
    expect(formatSessionDefaults(resolveSessionDefaults())).toBe('claude/claude-opus-5-5 · low');
  });

  test('the Settings patch is strict: known vendors, the effort enum, null clears', () => {
    expect(SessionDefaultsPatchSchema.safeParse({ vendor: null, model: 'x' }).success).toBe(true);
    expect(SessionDefaultsPatchSchema.safeParse({ vendor: 'hal9000' }).success).toBe(false);
    expect(SessionDefaultsPatchSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
    expect(SessionDefaultsPatchSchema.safeParse({ model: '  ' }).success).toBe(false);
    expect(SessionDefaultsPatchSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
