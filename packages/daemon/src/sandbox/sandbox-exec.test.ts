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
