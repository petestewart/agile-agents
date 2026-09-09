import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONTAINER_HOME, DEFAULT_SANDBOX_IMAGE, buildContainerCommand } from './container';
import { buildSandboxProfile } from './profile';

describe('buildContainerCommand', () => {
  test('engineer: rw worktree mount, bridge network, login re-homed under container $HOME, AGILE_* + login env forwarded', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      socketPath: '/repo/.agile-daemon.sock',
    });
    const cmd = buildContainerCommand(profile, 'npx', ['-y', 'thing']);
    expect(cmd.command).toBe('docker');
    expect(cmd.args).toContain('--rm');
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        '-v',
        '/repo/.worktrees/TKT-0001:/repo/.worktrees/TKT-0001:rw',
        '-v',
        `/home/pete/.claude:${DEFAULT_CONTAINER_HOME}/.claude:rw`,
        '-v',
        '/repo/.agile-daemon.sock:/repo/.agile-daemon.sock:rw',
        '-e',
        `HOME=${DEFAULT_CONTAINER_HOME}`,
        '--network',
        'bridge',
        DEFAULT_SANDBOX_IMAGE,
        'npx',
        '-y',
        'thing',
      ]),
    );
    expect(cmd.args).toEqual(expect.arrayContaining(['-e', 'ANTHROPIC_API_KEY']));
    expect(cmd.args).toEqual(expect.arrayContaining(['-e', 'AGILE_AGENT']));
    expect(cmd.args).toEqual(expect.arrayContaining(['-e', 'AGILE_TICKET']));
    expect(cmd.args).toEqual(expect.arrayContaining(['-e', 'AGILE_SOCKET_PATH']));
  });

  test('reviewer: ro worktree mount, network none, no shared-git mounts', () => {
    const profile = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const cmd = buildContainerCommand(profile, 'npx', []);
    expect(cmd.args).toContain('/repo/.worktrees/TKT-0001:/repo/.worktrees/TKT-0001:ro');
    const networkIdx = cmd.args.indexOf('--network');
    expect(cmd.args[networkIdx + 1]).toBe('none');
    expect(cmd.args.join(' ')).not.toContain('.git/worktrees');
  });

  test('engineer: shared-git mounts (round 2 B4) — common dir read-only, objects/refs/worktreeGitDir read-write', () => {
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
    const cmd = buildContainerCommand(profile, 'npx', []);
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        '-v',
        '/repo/.git:/repo/.git:ro',
        '-v',
        '/repo/.git/objects:/repo/.git/objects:rw',
        '-v',
        '/repo/.git/refs:/repo/.git/refs:rw',
        '-v',
        '/repo/.git/worktrees/TKT-0001:/repo/.git/worktrees/TKT-0001:rw',
      ]),
    );
  });

  test('reviewer: gitPaths on the input is ignored — never mounted for a non-engineer role', () => {
    const profile = buildSandboxProfile({
      role: 'reviewer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
      gitPaths: { worktreeGitDir: '/repo/.git/worktrees/TKT-0001', commonGitDir: '/repo/.git' },
    });
    const cmd = buildContainerCommand(profile, 'npx', []);
    expect(cmd.args.join(' ')).not.toContain('/repo/.git');
  });

  test('custom image overrides the default', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const cmd = buildContainerCommand(profile, 'npx', [], { image: 'custom:tag' });
    expect(cmd.args).toContain('custom:tag');
    expect(cmd.args).not.toContain(DEFAULT_SANDBOX_IMAGE);
  });

  test('hostBinaryPath (round 2 B5 escape hatch): mounted read-only and used as the exec target', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'grok',
      homeDir: '/home/pete',
    });
    const cmd = buildContainerCommand(profile, 'grok', ['agent', 'stdio'], {
      hostBinaryPath: '/usr/local/bin/grok',
    });
    expect(cmd.args).toEqual(
      expect.arrayContaining(['-v', '/usr/local/bin/grok:/usr/local/bin/grok:ro']),
    );
    const imageIdx = cmd.args.indexOf(DEFAULT_SANDBOX_IMAGE);
    expect(cmd.args[imageIdx + 1]).toBe('/usr/local/bin/grok');
    expect(cmd.args[imageIdx + 2]).toBe('agent');
  });
});
