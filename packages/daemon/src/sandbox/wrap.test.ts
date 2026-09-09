import { describe, expect, test } from 'bun:test';
import type { DetectBackendDeps } from './backend';
import { SandboxRequiredError, wrapAgentCommand } from './wrap';

function noneDeps(): DetectBackendDeps {
  return { platform: () => 'linux', hasSandboxExec: () => false, hasContainerRuntime: () => false };
}

function containerDeps(): DetectBackendDeps {
  return { platform: () => 'linux', hasSandboxExec: () => false, hasContainerRuntime: () => true };
}

function sandboxExecDeps(): DetectBackendDeps {
  return { platform: () => 'darwin', hasSandboxExec: () => true, hasContainerRuntime: () => false };
}

const baseInput = {
  role: 'engineer' as const,
  worktreePath: '/repo/.worktrees/TKT-0001',
  vendor: 'grok',
  command: 'grok',
  args: ['agent', 'stdio'],
};

describe('wrapAgentCommand', () => {
  test('fail-closed: requiresSandbox + backend none throws SandboxRequiredError', () => {
    expect(() =>
      wrapAgentCommand({ ...baseInput, requiresSandbox: true }, { detectBackendDeps: noneDeps() }),
    ).toThrow(SandboxRequiredError);
  });

  test('requiresSandbox + backend none: error names the vendor and role', () => {
    try {
      wrapAgentCommand({ ...baseInput, requiresSandbox: true }, { detectBackendDeps: noneDeps() });
      throw new Error('expected wrapAgentCommand to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxRequiredError);
      expect((err as SandboxRequiredError).vendor).toBe('grok');
      expect((err as SandboxRequiredError).role).toBe('engineer');
      expect((err as Error).message).toContain('grok');
    }
  });

  test('backend none + requiresSandbox false: passes the command through unchanged', () => {
    const result = wrapAgentCommand(
      { ...baseInput, requiresSandbox: false, vendor: 'claude', command: 'npx', args: ['-y', 'x'] },
      { detectBackendDeps: noneDeps() },
    );
    expect(result).toEqual({
      backend: 'none',
      command: 'npx',
      args: ['-y', 'x'],
      envOverrides: {},
    });
  });

  test('requiresSandbox undefined behaves like false (default-safe)', () => {
    const result = wrapAgentCommand(
      { ...baseInput, vendor: 'claude', command: 'npx', args: [] },
      { detectBackendDeps: noneDeps() },
    );
    expect(result.backend).toBe('none');
  });

  test('backend container + requiresSandbox true: wraps under docker instead of refusing', () => {
    const result = wrapAgentCommand(
      { ...baseInput, requiresSandbox: true },
      { detectBackendDeps: containerDeps() },
    );
    expect(result.backend).toBe('container');
    expect(result.command).toBe('docker');
    expect(result.args).toContain('grok');
  });

  test('backend sandbox-exec: writes the profile via the injected writer and wraps under sandbox-exec', () => {
    const written: string[] = [];
    const result = wrapAgentCommand(
      { ...baseInput, requiresSandbox: true },
      {
        detectBackendDeps: sandboxExecDeps(),
        writeProfileFile: (contents) => {
          written.push(contents);
          return '/tmp/fake-profile.sb';
        },
      },
    );
    expect(result.backend).toBe('sandbox-exec');
    expect(result.command).toBe('sandbox-exec');
    expect(result.args[0]).toBe('-f');
    expect(result.args[1]).toBe('/tmp/fake-profile.sb');
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('(deny default)');
    expect(result.profileText).toBe(written[0]);
  });
});
