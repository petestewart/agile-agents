import { describe, expect, test } from 'bun:test';
import type { ReposConfig } from '@agile-agents/shared';
import { canReadRepo, repoOfPath, visibilityDenyReason } from './visibility';

const SHOP = 'P-01J9SHOPSHOPSHOPSHOPSHOPSH';
const repos: ReposConfig = {
  api: {
    path: '/src/api',
    protected_branches: [],
    visibility: { mode: 'private' as const, projects: [SHOP] },
  },
  blog: { path: '/src/blog', protected_branches: [], visibility: { mode: 'public' as const } },
  nested: { path: '/src/api/vendor/lib', protected_branches: [] },
};

describe('repo visibility (T229, P13)', () => {
  test('a path belongs to the deepest registered repo root', () => {
    expect(repoOfPath(repos, '/src/api/x.ts')).toBe('api');
    expect(repoOfPath(repos, '/src/api/vendor/lib/y.ts')).toBe('nested');
    expect(repoOfPath(repos, '/src/apiary/x.ts')).toBeUndefined();
  });

  test('private repos are readable only by listed projects; public by all', () => {
    expect(canReadRepo(repos, 'api', SHOP)).toBe(true);
    expect(canReadRepo(repos, 'api', 'P-OTHER')).toBe(false);
    expect(canReadRepo(repos, 'api', undefined)).toBe(false);
    expect(canReadRepo(repos, 'blog', undefined)).toBe(true);
  });

  test('relative paths resolve against the worktree; own repo is always fine', () => {
    const ctx = { repos, ownRepo: 'api', worktreePath: '/src/api/.worktrees/n' };
    expect(visibilityDenyReason(ctx, ['a.ts'], true)).toBeUndefined();
    expect(visibilityDenyReason(ctx, ['../../../blog/a.ts'], false)).toBeUndefined();
    expect(visibilityDenyReason(ctx, ['../../../blog/a.ts'], true)).toContain('own repo (api)');
  });

  test('paths outside every registered repo are not this check’s business', () => {
    const ctx = { repos, ownRepo: 'blog', worktreePath: '/src/blog' };
    expect(visibilityDenyReason(ctx, ['/tmp/x'], true)).toBeUndefined();
  });
});
