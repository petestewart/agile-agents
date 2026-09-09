import { describe, expect, test } from 'bun:test';
import { DEFAULT_SANDBOX_IMAGE, buildContainerCommand } from './container';
import { buildSandboxProfile } from './profile';

describe('buildContainerCommand', () => {
  test('engineer: rw worktree mount, bridge network, login paths mounted, env names forwarded', () => {
    const profile = buildSandboxProfile({
      role: 'engineer',
      worktreePath: '/repo/.worktrees/TKT-0001',
      vendor: 'claude',
      homeDir: '/home/pete',
    });
    const cmd = buildContainerCommand(profile, 'npx', ['-y', 'thing']);
    expect(cmd.command).toBe('docker');
    expect(cmd.args).toContain('--rm');
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        '-v',
        '/repo/.worktrees/TKT-0001:/repo/.worktrees/TKT-0001:rw',
        '-v',
        '/home/pete/.claude:/home/pete/.claude:rw',
        '--network',
        'bridge',
        DEFAULT_SANDBOX_IMAGE,
        'npx',
        '-y',
        'thing',
      ]),
    );
    expect(cmd.args).toEqual(expect.arrayContaining(['-e', 'ANTHROPIC_API_KEY']));
  });

  test('reviewer: ro worktree mount, network none', () => {
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
});
