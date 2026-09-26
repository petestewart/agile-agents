import { describe, expect, test } from 'bun:test';
import type { SessionDefaultsStatus } from '@agile-agents/shared';
import { resolvedFor } from './defaults';

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
