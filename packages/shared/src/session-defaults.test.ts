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

describe('P5: the project step', () => {
  test('sits between the flag and the repo', () => {
    const r = resolveSessionDefaults({
      flags: { effort: 'max' },
      project: { model: 'claude-sonnet-4-6', effort: 'high' },
      repo: { model: 'claude-haiku-4-5', vendor: 'claude' },
      home: { default_effort: 'low' },
    });
    expect(r).toEqual({ vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'max' });
  });
});

describe('T402 (D40): a model belongs to its vendor', () => {
  const home = { default_model: 'claude-sonnet-4-6' };

  test("a repo set to another vendor doesn't take the home's Claude model", () => {
    expect(resolveSessionDefaults({ home, repo: { vendor: 'gemini' } })).toEqual({
      vendor: 'gemini',
      effort: 'low',
    });
    expect(
      resolveSessionDefaults({ home, repo: { vendor: 'gemini', model: 'gemini-2.5-pro' } }),
    ).toEqual({ vendor: 'gemini', model: 'gemini-2.5-pro', effort: 'low' });
    // The flag's vendor, likewise; and back to Claude, the home's model again.
    expect(resolveSessionDefaults({ home, flags: { vendor: 'codex' } }).model).toBeUndefined();
    expect(resolveSessionDefaults({ home, repo: { vendor: 'claude' } }).model).toBe(
      'claude-sonnet-4-6',
    );
  });

  test('a model named above the vendor runs on the vendor below it', () => {
    expect(
      resolveSessionDefaults({ flags: { model: 'gemini-2.5-flash' }, repo: { vendor: 'gemini' } }),
    ).toEqual({ vendor: 'gemini', model: 'gemini-2.5-flash', effort: 'low' });
    expect(
      resolveSessionDefaults({
        project: { model: 'gpt-9' },
        home: { default_vendor: 'codex', default_model: 'gpt-8' },
      }).model,
    ).toBe('gpt-9');
  });

  test("a repo's model for another vendor is skipped when a flag picks the vendor", () => {
    expect(
      resolveSessionDefaults({
        flags: { vendor: 'claude' },
        repo: { vendor: 'codex', model: 'gpt-9' },
      }),
    ).toEqual({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' });
  });
});
