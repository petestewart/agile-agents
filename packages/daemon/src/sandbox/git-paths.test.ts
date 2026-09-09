import { describe, expect, test } from 'bun:test';
import { resolveWorktreeGitPaths } from './git-paths';

function deps(files: Record<string, string>) {
  return {
    readFileSync: (path: string) => {
      if (!(path in files)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files[path] as string;
    },
  };
}

describe('resolveWorktreeGitPaths', () => {
  test('a real linked-worktree gitfile resolves both paths (reviewer round 1 B4 evidence)', () => {
    const paths = resolveWorktreeGitPaths(
      '/repo/.worktrees/T026-tier0-sandbox',
      deps({
        '/repo/.worktrees/T026-tier0-sandbox/.git':
          'gitdir: /repo/.git/worktrees/T026-tier0-sandbox\n',
        '/repo/.git/worktrees/T026-tier0-sandbox/commondir': '../..\n',
      }),
    );
    expect(paths).toEqual({
      worktreeGitDir: '/repo/.git/worktrees/T026-tier0-sandbox',
      commonGitDir: '/repo/.git',
    });
  });

  test('no commondir file: falls back to treating the worktree gitdir as the common dir', () => {
    const paths = resolveWorktreeGitPaths(
      '/repo/.worktrees/TKT-0001',
      deps({ '/repo/.worktrees/TKT-0001/.git': 'gitdir: /repo/.git/worktrees/TKT-0001\n' }),
    );
    expect(paths).toEqual({
      worktreeGitDir: '/repo/.git/worktrees/TKT-0001',
      commonGitDir: '/repo/.git/worktrees/TKT-0001',
    });
  });

  test('a real .git directory (QA fresh clone, EISDIR) resolves null, not a throw', () => {
    const paths = resolveWorktreeGitPaths('/repo/.worktrees/TKT-0001-qa', {
      readFileSync: () => {
        const err = new Error('EISDIR') as NodeJS.ErrnoException;
        err.code = 'EISDIR';
        throw err;
      },
    });
    expect(paths).toBeNull();
  });

  test('.git file present but malformed (no "gitdir:" line) resolves null', () => {
    const paths = resolveWorktreeGitPaths(
      '/repo/.worktrees/TKT-0001',
      deps({ '/repo/.worktrees/TKT-0001/.git': 'not a gitfile\n' }),
    );
    expect(paths).toBeNull();
  });

  test('a relative gitdir line resolves against the worktree path', () => {
    const paths = resolveWorktreeGitPaths(
      '/repo/.worktrees/TKT-0001',
      deps({
        '/repo/.worktrees/TKT-0001/.git': 'gitdir: ../../.git/worktrees/TKT-0001\n',
        '/repo/.git/worktrees/TKT-0001/commondir': '../..\n',
      }),
    );
    expect(paths).toEqual({
      worktreeGitDir: '/repo/.git/worktrees/TKT-0001',
      commonGitDir: '/repo/.git',
    });
  });
});
