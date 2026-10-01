import { describe, expect, test } from 'bun:test';
import { validateHomeConfig } from './home-config';
import { validateProjectUpdateInput } from './project';
import { validateRepoEntry } from './repos';
import {
  BUILTIN_SESSION_DEFAULTS,
  KNOWN_MODEL_IDS,
  SESSION_VENDORS,
  SessionDefaultsPatchSchema,
  SessionVendorSchema,
  VendorFailureSchema,
  type VendorFailureSettings,
  formatSessionDefaults,
  resolveSessionDefaults,
  resolveVendorFailure,
  uncheckedCommandsLine,
  uncheckedCommandsWarning,
  vendorHasHooks,
  vendorLoginHow,
  vendorRunsUnchecked,
  vendorTakesEffort,
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

describe('T456: what happens when an agent crashes (vendor_failure)', () => {
  test('field by field: project, then repo, then home, then the built-in', () => {
    expect(resolveVendorFailure()).toEqual({ retry: true, fallback: [], allow_hookless: false });
    const home = { retry: true, fallback: ['gemini' as const], allow_hookless: true };
    const repo = { fallback: ['cursor' as const, 'cursor' as const] };
    const project = { retry: false };
    expect(resolveVendorFailure(project, repo, home)).toEqual({
      retry: false,
      // A vendor named twice is tried once.
      fallback: ['cursor'],
      allow_hookless: true,
    });
    expect(resolveVendorFailure(undefined, undefined, home)).toEqual(home);
    // An empty list is a setting: nothing to fall back to, whatever the home says.
    expect(resolveVendorFailure({ fallback: [] }, undefined, home).fallback).toEqual([]);
  });

  test('strict, known vendors only, in the home, a repo, a project and a Settings write', () => {
    expect(VendorFailureSchema.safeParse({ retry: true, extra: 1 }).success).toBe(false);
    expect(VendorFailureSchema.safeParse({ fallback: ['hal9000'] }).success).toBe(false);
    const block: VendorFailureSettings = {
      retry: false,
      fallback: ['gemini', 'codex'],
      allow_hookless: true,
    };
    expect(validateHomeConfig({ vendor_failure: block }).vendor_failure).toEqual(block);
    expect(validateRepoEntry({ path: '/r', vendor_failure: block }).vendor_failure).toEqual(block);
    expect(SessionDefaultsPatchSchema.parse({ vendor_failure: null })).toEqual({
      vendor_failure: null,
    });
    expect(
      validateProjectUpdateInput({ vendor_failure: { fallback: ['cursor'] } }).vendor_failure,
    ).toEqual({ fallback: ['cursor'] });
  });

  test('Claude and Pi have pre-tool hooks; the others do not', () => {
    expect(SESSION_VENDORS.filter(vendorHasHooks)).toEqual(['claude', 'pi']);
  });

  test('T500: Antigravity is a session vendor beside Gemini, signed in with `agy`, no known models or effort', () => {
    expect(SESSION_VENDORS).toContain('antigravity');
    expect(SESSION_VENDORS).toContain('gemini');
    expect(SessionVendorSchema.parse('antigravity')).toBe('antigravity');
    expect(vendorLoginHow('antigravity', 'Antigravity')).toBe('run `agy` and sign in');
    expect(KNOWN_MODEL_IDS.antigravity).toEqual([]);
    expect(vendorTakesEffort('antigravity')).toBe(false);
    expect(vendorHasHooks('antigravity')).toBe(false);
  });

  test('T505: Grok, Codex and Antigravity run commands unchecked, in plain words', () => {
    expect(SESSION_VENDORS.filter(vendorRunsUnchecked)).toEqual(['grok', 'codex', 'antigravity']);
    expect(vendorRunsUnchecked('claude')).toBe(false);
    expect(vendorRunsUnchecked('nope')).toBe(false);
    // None of them has pre-tool hooks.
    expect(SESSION_VENDORS.filter((v) => vendorRunsUnchecked(v) && vendorHasHooks(v))).toEqual([]);
    expect(uncheckedCommandsWarning('Codex')).toBe(
      'Codex runs shell commands without asking, and nothing checks them yet. Use it on repos you trust.',
    );
    expect(uncheckedCommandsLine('Codex')).toBe('Codex runs commands unchecked');
  });
});
