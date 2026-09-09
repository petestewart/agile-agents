import { describe, expect, test } from 'bun:test';
import { DEFAULT_REGISTRY_ALLOWLIST, buildSandboxProfile } from './profile';

describe('buildSandboxProfile', () => {
  test('engineer: writable worktree, allow-listed network', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    expect(profile.worktreeWritable).toBe(true);
    expect(profile.network).toBe('allowlist');
    expect(profile.allowedHosts).toEqual(DEFAULT_REGISTRY_ALLOWLIST);
    expect(profile.loginPaths).toEqual(['/home/pete/.claude', '/home/pete/.config/claude']);
  });

  test('engineer: extraAllowedHosts append to the default registry list', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      extraAllowedHosts: ['registry.internal.example'],
    });
    expect(profile.allowedHosts).toEqual([
      ...DEFAULT_REGISTRY_ALLOWLIST,
      'registry.internal.example',
    ]);
  });

  test('reviewer: read-only checkout, no network', () => {
    const profile = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    expect(profile.worktreeWritable).toBe(false);
    expect(profile.network).toBe('none');
    expect(profile.allowedHosts).toEqual([]);
  });

  test('qa: read-only checkout, no network (v0 — env base URL not yet plumbed)', () => {
    const profile = buildSandboxProfile({
      role: 'qa',
      worktreePath: '/repo/.qa-clones/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    expect(profile.worktreeWritable).toBe(false);
    expect(profile.network).toBe('none');
  });

  test('unknown vendor: no login paths rather than throwing', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'some-future-vendor',
      homeDir: '/home/pete',
    });
    expect(profile.loginPaths).toEqual([]);
    expect(profile.loginEnvPassthrough).toEqual([]);
  });

  test('round 2: homeDir/loginRelPaths/socketPath are carried through for every role', () => {
    const engineer = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      socketPath: '/repo/.agile-daemon.sock',
    });
    expect(engineer.homeDir).toBe('/home/pete');
    expect(engineer.loginRelPaths).toEqual(['.claude', '.config/claude']);
    expect(engineer.socketPath).toBe('/repo/.agile-daemon.sock');

    const reviewer = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      socketPath: '/repo/.agile-daemon.sock',
    });
    expect(reviewer.socketPath).toBe('/repo/.agile-daemon.sock');
  });

  test('round 2 B4: gitPaths only ever lands on an engineer profile', () => {
    const gitPaths = {
      worktreeGitDir: '/repo/.git/worktrees/TKT-0001',
      commonGitDir: '/repo/.git',
    };
    const engineer = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      gitPaths,
    });
    expect(engineer.gitPaths).toEqual(gitPaths);

    const reviewer = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      gitPaths,
    });
    expect(reviewer.gitPaths).toBeUndefined();
  });

  test('grok: login paths and env passthrough resolved (ungated-exec vendor)', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'grok',
      homeDir: '/home/pete',
    });
    expect(profile.loginPaths).toEqual(['/home/pete/.grok', '/home/pete/.xai']);
    expect(profile.loginEnvPassthrough).toEqual(['XAI_API_KEY']);
  });
});
