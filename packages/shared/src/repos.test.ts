import { describe, expect, test } from 'bun:test';
import { DEFAULT_PROTECTED_BRANCHES, validateRepoEntry, validateReposConfig } from './repos';

describe('RepoEntry (T111)', () => {
  test('protected_branches defaults to main + master (D8)', () => {
    expect(validateRepoEntry({ path: '/repos/ledger' })).toEqual({
      path: '/repos/ledger',
      protected_branches: [...DEFAULT_PROTECTED_BRANCHES],
    });
  });

  test('target_branch and vendor are optional and preserved', () => {
    const entry = validateRepoEntry({
      path: '/repos/ledger',
      protected_branches: ['main'],
      target_branch: 'integration',
      vendor: 'claude',
    });
    expect(entry.target_branch).toBe('integration');
    expect(entry.vendor).toBe('claude');
  });

  test('is .strict(): an unknown key is rejected', () => {
    expect(() => validateRepoEntry({ path: '/repos/ledger', branch: 'main' })).toThrow(
      /invalid repo entry/,
    );
  });

  test('auto_review is optional and boolean (T131, cockpit design §4.2)', () => {
    expect(validateRepoEntry({ path: '/a' }).auto_review).toBeUndefined();
    expect(validateRepoEntry({ path: '/a', auto_review: true }).auto_review).toBe(true);
    expect(() => validateRepoEntry({ path: '/a', auto_review: 'yes' })).toThrow(
      /invalid repo entry/,
    );
  });

  test('an empty path is rejected', () => {
    expect(() => validateRepoEntry({ path: '' })).toThrow(/invalid repo entry/);
  });

  test('the registry is a name -> entry map and validates every entry', () => {
    expect(validateReposConfig({})).toEqual({});
    const repos = validateReposConfig({ a: { path: '/a' }, b: { path: '/b' } });
    expect(Object.keys(repos).sort()).toEqual(['a', 'b']);
    expect(() => validateReposConfig({ a: { path: 7 } })).toThrow(/invalid repos.yaml/);
  });
});

describe('classifier default (T150, cockpit design §6.4)', () => {
  test('a repo entry may set the per-repo default', () => {
    expect(validateRepoEntry({ path: '/repo', classifier: 'off' }).classifier).toBe('off');
    expect(validateRepoEntry({ path: '/repo', classifier: 'on' }).classifier).toBe('on');
  });

  test('it is optional and only takes on/off', () => {
    expect(validateRepoEntry({ path: '/repo' }).classifier).toBeUndefined();
    expect(() => validateRepoEntry({ path: '/repo', classifier: true })).toThrow();
  });
});
