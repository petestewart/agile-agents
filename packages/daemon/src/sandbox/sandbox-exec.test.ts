import { describe, expect, test } from 'bun:test';
import { buildSandboxProfile } from './profile';
import { buildSandboxExecCommand, renderSandboxExecProfile } from './sandbox-exec';

describe('renderSandboxExecProfile', () => {
  test('engineer: default-deny, worktree write, allow-listed network hosts', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).toContain('(deny default)');
    expect(text).toContain('(allow file-write* (subpath "/repo/.worktrees/TKT-0001"))');
    expect(text).toContain('(allow network-outbound (remote tcp "registry.npmjs.org:*"))');
    expect(text).toContain('(allow file-read* file-write* (subpath "/home/pete/.claude"))');
  });

  test('reviewer: no worktree write rule, no network-outbound rule', () => {
    const profile = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).not.toContain('(allow file-write* (subpath "/repo/.worktrees/TKT-0001"))');
    expect(text).not.toContain('(allow network-outbound');
    // Login state must still work for the reviewer session.
    expect(text).toContain('(allow file-read* file-write* (subpath "/home/pete/.claude"))');
  });

  test('does not render the bogus DNS-over-UDP rule (round 2 nit fix)', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).not.toContain(':53');
  });

  test('round 2 B3: daemon socket path is allowed for every role, regardless of network posture', () => {
    for (const role of ['engineer', 'reviewer', 'qa'] as const) {
      const profile = buildSandboxProfile({
        role,
        worktreePath: '/repo/.worktrees/TKT-0001',
        vendor: 'claude',
        homeDir: '/home/pete',
        socketPath: '/repo/.agile-daemon.sock',
      });
      const text = renderSandboxExecProfile(profile);
      expect(text).toContain('(allow file-read* file-write* (literal "/repo/.agile-daemon.sock"))');
      expect(text).toContain('(allow network* (literal "/repo/.agile-daemon.sock"))');
    }
  });

  test('no socketPath given: no socket allow rule rendered (documented gap, not a guess)', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).not.toContain('.agile-daemon.sock');
  });

  test('round 2 B4: engineer gets write access to the shared git objects/refs and its own worktree gitdir', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      gitPaths: {
        worktreeGitDir: '/repo/.git/worktrees/TKT-0001',
        commonGitDir: '/repo/.git',
      },
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).toContain('(allow file-write* (subpath "/repo/.git/worktrees/TKT-0001"))');
    expect(text).toContain('(allow file-write* (subpath "/repo/.git/objects"))');
    expect(text).toContain('(allow file-write* (subpath "/repo/.git/refs"))');
    // Round 3 B6: the branch reflog lives under the *common* `.git/logs`,
    // not the per-worktree gitdir — missing this made every real commit
    // fail with "unable to append to .git/logs/refs/heads/<branch>".
    expect(text).toContain('(allow file-write* (subpath "/repo/.git/logs"))');
  });

  test('round 2 B4: reviewer never gets a shared-git write rule even if gitPaths were passed in', () => {
    const profile = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      gitPaths: { worktreeGitDir: '/repo/.git/worktrees/TKT-0001', commonGitDir: '/repo/.git' },
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).not.toContain('.git');
  });

  test('a stray quote in a path is escaped, not left to break the profile', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/weird"path',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const text = renderSandboxExecProfile(profile);
    expect(text).toContain('/repo/.worktrees/weird\\"path');
  });
});

describe('buildSandboxExecCommand', () => {
  test('wraps cmd/args behind sandbox-exec -f <profile> --', () => {
    const wrapped = buildSandboxExecCommand('/tmp/profile.sb', 'npx', ['-y', 'thing'], 'text');
    expect(wrapped.command).toBe('sandbox-exec');
    expect(wrapped.args).toEqual(['-f', '/tmp/profile.sb', '--', 'npx', '-y', 'thing']);
    expect(wrapped.profileText).toBe('text');
  });
});
