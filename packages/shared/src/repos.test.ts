import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROTECTED_BRANCHES,
  RepoCloneInputSchema,
  resolveDelivery,
  validateRepoEntry,
  validateReposConfig,
} from './repos';

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

  test('T339: `checks` is an optional list of commands', () => {
    expect(validateRepoEntry({ path: '/a' }).checks).toBeUndefined();
    expect(validateRepoEntry({ path: '/a', checks: ['make check'] }).checks).toEqual([
      'make check',
    ]);
    expect(() => validateRepoEntry({ path: '/a', checks: [''] })).toThrow(/invalid repo entry/);
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

describe('resolveDelivery (T222, §14.8): repo, then project, then node', () => {
  const cases: Array<{
    name: string;
    repo?: { delivery?: 'direct' | 'pr'; auto_merge?: boolean };
    project?: { mode?: 'direct' | 'pr'; auto_merge?: boolean };
    node?: { mode?: 'direct' | 'pr'; auto_merge?: boolean };
    want: { mode: 'direct' | 'pr'; auto_merge: boolean };
  }> = [
    { name: 'nothing set: direct, off', want: { mode: 'direct', auto_merge: false } },
    { name: 'repo pr', repo: { delivery: 'pr' }, want: { mode: 'pr', auto_merge: false } },
    {
      name: 'repo pr + auto-merge',
      repo: { delivery: 'pr', auto_merge: true },
      want: { mode: 'pr', auto_merge: true },
    },
    {
      name: 'project overrides repo mode',
      repo: { delivery: 'pr' },
      project: { mode: 'direct' },
      want: { mode: 'direct', auto_merge: false },
    },
    {
      name: 'node overrides project',
      repo: { delivery: 'direct' },
      project: { mode: 'direct' },
      node: { mode: 'pr' },
      want: { mode: 'pr', auto_merge: false },
    },
    {
      name: 'fields resolve independently: node mode, project auto-merge',
      repo: { delivery: 'direct', auto_merge: false },
      project: { auto_merge: true },
      node: { mode: 'pr' },
      want: { mode: 'pr', auto_merge: true },
    },
    {
      name: 'node turns auto-merge off over the repo',
      repo: { delivery: 'pr', auto_merge: true },
      node: { auto_merge: false },
      want: { mode: 'pr', auto_merge: false },
    },
    {
      name: 'auto-merge is pr only',
      repo: { delivery: 'pr', auto_merge: true },
      project: { mode: 'direct' },
      want: { mode: 'direct', auto_merge: false },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(
        resolveDelivery(
          c.repo,
          c.project ? { delivery: c.project } : undefined,
          c.node ? { delivery: c.node } : undefined,
        ),
      ).toEqual(c.want);
    });
  }

  test('the new §14.8 fields validate; github must have owner and repo', () => {
    const entry = validateRepoEntry({
      path: '/r',
      delivery: 'pr',
      auto_merge: true,
      remote: 'upstream',
      github: { owner: 'o', repo: 'r' },
    });
    expect(entry.github).toEqual({ owner: 'o', repo: 'r' });
    expect(() => validateRepoEntry({ path: '/r', github: { owner: 'o' } })).toThrow();
  });
});

describe('RepoCloneInput (T362)', () => {
  test('url is required and trimmed; dest and name are optional; unknown keys are refused', () => {
    expect(RepoCloneInputSchema.parse({ url: ' acme/shop ' })).toEqual({ url: 'acme/shop' });
    expect(
      RepoCloneInputSchema.parse({ url: 'git@github.com:a/b.git', dest: '~/x', name: 'b' }),
    ).toEqual({ url: 'git@github.com:a/b.git', dest: '~/x', name: 'b' });
    expect(RepoCloneInputSchema.safeParse({}).success).toBe(false);
    expect(RepoCloneInputSchema.safeParse({ url: '  ' }).success).toBe(false);
    expect(RepoCloneInputSchema.safeParse({ url: 'a/b', path: '/x' }).success).toBe(false);
  });
});
