import { describe, expect, test } from 'bun:test';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import {
  DEFAULT_VENDOR,
  UnknownVendorError,
  effortContribution,
  effortIgnoredLine,
  resolveSessionSettings,
} from './resolve';

const repo = { path: '/repo', protected_branches: ['main'], vendor: 'pi', model: 'pi-1', effort: 'high' } as const;
const home = { default_vendor: 'cursor', default_model: 'cursor-1', default_effort: 'low' } as const;

describe('resolveSessionSettings', () => {
  test('falls back to claude / the provider default model / medium', () => {
    const resolved = resolveSessionSettings();
    expect(resolved.vendor).toBe(DEFAULT_VENDOR);
    expect(resolved.model).toBe(ACP_PROVIDERS.claude.defaultModel);
    expect(resolved.effort).toBe('medium');
  });

  test('home config beats the provider default', () => {
    const resolved = resolveSessionSettings({ home });
    expect(resolved).toMatchObject({ vendor: 'cursor', model: 'cursor-1', effort: 'low' });
  });

  test('the repo entry beats the home config', () => {
    const resolved = resolveSessionSettings({ repo: { ...repo }, home });
    expect(resolved).toMatchObject({ vendor: 'pi', model: 'pi-1', effort: 'high' });
  });

  test('the flag beats everything, field by field', () => {
    const resolved = resolveSessionSettings({
      flags: { effort: 'max' },
      repo: { ...repo },
      home,
    });
    // vendor/model still come from the repo entry — resolution is per field.
    expect(resolved).toMatchObject({ vendor: 'pi', model: 'pi-1', effort: 'max' });
    expect(
      resolveSessionSettings({ flags: { vendor: 'claude', model: 'opus' }, repo: { ...repo } }),
    ).toMatchObject({ vendor: 'claude', model: 'opus', effort: 'high' });
  });

  test('an unknown vendor is a typed, named refusal', () => {
    expect(() => resolveSessionSettings({ flags: { vendor: 'hal9000' } })).toThrow(
      UnknownVendorError,
    );
  });

  test('an unknown effort names effort, not the config file', () => {
    expect(() => resolveSessionSettings({ flags: { effort: 'extreme' } })).toThrow(/Effort/);
  });
});

describe('effort mapping', () => {
  test('claude maps every level to a thinking budget', () => {
    const budgets = (['low', 'medium', 'high', 'max'] as const).map(
      (level) => effortContribution(ACP_PROVIDERS.claude, level)?.env?.MAX_THINKING_TOKENS,
    );
    expect(budgets).toEqual(['0', '4000', '10000', '31999']);
  });

  test('an unmapped vendor contributes nothing and gets a thread line instead', () => {
    expect(effortContribution(ACP_PROVIDERS.gemini, 'high')).toBeUndefined();
    expect(effortIgnoredLine('gemini', 'high')).toBe('effort high ignored by gemini');
  });

  test('claude maps a named model to ANTHROPIC_MODEL, and its own default to nothing', () => {
    expect(ACP_PROVIDERS.claude.model?.('sonnet')).toEqual({ env: { ANTHROPIC_MODEL: 'sonnet' } });
    expect(ACP_PROVIDERS.claude.model?.('default')).toEqual({});
  });
});
