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

/** Keeps every test pure — no real fs reads or `command -v` shell-outs. */
const noIoDeps = {
  gitPathsDeps: {
    readFileSync: () => {
      throw new Error('ENOENT');
    },
  },
  resolveHostBinaryPath: () => undefined,
};

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
      wrapAgentCommand(
        { ...baseInput, requiresSandbox: true },
        { detectBackendDeps: noneDeps(), ...noIoDeps },
      ),
    ).toThrow(SandboxRequiredError);
  });

  test('requiresSandbox + backend none: error names the vendor and role', () => {
    try {
      wrapAgentCommand(
        { ...baseInput, requiresSandbox: true },
        { detectBackendDeps: noneDeps(), ...noIoDeps },
      );
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
      { detectBackendDeps: noneDeps(), ...noIoDeps },
    );
    expect(result).toEqual({
      backend: 'none',
      command: 'npx',
      args: ['-y', 'x'],
      envOverrides: {},
    });
  });

  test('round 3 (QA round 2): enabled true + backend none fails closed, exactly like requiresSandbox — no silent passthrough', () => {
    expect(() =>
      wrapAgentCommand(
        { ...baseInput, vendor: 'claude', command: 'npx', args: ['-y', 'x'], enabled: true },
        { detectBackendDeps: noneDeps(), ...noIoDeps },
      ),
    ).toThrow(SandboxRequiredError);

    try {
      wrapAgentCommand(
        { ...baseInput, vendor: 'claude', command: 'npx', args: ['-y', 'x'], enabled: true },
        { detectBackendDeps: noneDeps(), ...noIoDeps },
      );
      throw new Error('expected wrapAgentCommand to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxRequiredError);
      expect((err as SandboxRequiredError).vendor).toBe('claude');
      // Not a spawn — no command/args ever escape this call on this path.
    }
  });

  test('requiresSandbox undefined behaves like false (default-safe)', () => {
    const result = wrapAgentCommand(
      { ...baseInput, vendor: 'claude', command: 'npx', args: [] },
      { detectBackendDeps: noneDeps(), ...noIoDeps },
    );
    expect(result.backend).toBe('none');
  });

  test('round 3 nit: detectBackend() is never probed at all when neither requiresSandbox nor enabled is set', () => {
    let probed = false;
    const spyDeps: DetectBackendDeps = {
      platform: () => {
        probed = true;
        return 'linux';
      },
      hasSandboxExec: () => {
        probed = true;
        return false;
      },
      hasContainerRuntime: () => {
        probed = true;
        return false;
      },
    };
    const result = wrapAgentCommand(
      { ...baseInput, vendor: 'claude', command: 'npx', args: [] },
      { detectBackendDeps: spyDeps, ...noIoDeps },
    );
    expect(probed).toBe(false);
    expect(result.backend).toBe('none');
  });

  test('round 2 B2: backend available but requiresSandbox unset and enabled unset -> pass through unchanged (no regression for existing Claude sessions on a Mac)', () => {
    const result = wrapAgentCommand(
      {
        ...baseInput,
        vendor: 'claude',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp'],
      },
      { detectBackendDeps: sandboxExecDeps(), ...noIoDeps },
    );
    expect(result).toEqual({
      backend: 'none',
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
      envOverrides: {},
    });
  });

  test('round 2 B2: backend available and enabled explicitly true -> wraps even though requiresSandbox is unset', () => {
    const result = wrapAgentCommand(
      { ...baseInput, vendor: 'claude', command: 'npx', args: [], enabled: true },
      { detectBackendDeps: sandboxExecDeps(), ...noIoDeps, writeProfileFile: () => '/tmp/p.sb' },
    );
    expect(result.backend).toBe('sandbox-exec');
  });

  test('round 3: backend container + requiresSandbox true + role engineer is insufficient -> throws (Docker cannot enforce the registry allow-list)', () => {
    try {
      wrapAgentCommand(
        { ...baseInput, requiresSandbox: true },
        { detectBackendDeps: containerDeps(), ...noIoDeps },
      );
      throw new Error('expected wrapAgentCommand to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxRequiredError);
      expect((err as Error).message).toContain('container');
      expect((err as Error).message).toContain('network allow-list');
    }
  });

  test('round 3: backend container + requiresSandbox true + role reviewer/qa is sufficient (no network posture to enforce beyond none) -> wraps under docker', () => {
    for (const role of ['reviewer', 'qa'] as const) {
      const result = wrapAgentCommand(
        { ...baseInput, role, requiresSandbox: true },
        { detectBackendDeps: containerDeps(), ...noIoDeps },
      );
      expect(result.backend).toBe('container');
      expect(result.command).toBe('docker');
      expect(result.args).toContain('grok');
    }
  });

  test('backend container: resolveHostBinaryPath is consulted and its result mounted+used when no explicit image is set (round 2 B5)', () => {
    const result = wrapAgentCommand(
      { ...baseInput, role: 'reviewer', requiresSandbox: true },
      {
        detectBackendDeps: containerDeps(),
        gitPathsDeps: noIoDeps.gitPathsDeps,
        resolveHostBinaryPath: (cmd) => (cmd === 'grok' ? '/usr/local/bin/grok' : undefined),
      },
    );
    expect(result.args).toEqual(expect.arrayContaining(['/usr/local/bin/grok']));
    expect(result.args).toEqual(
      expect.arrayContaining(['-v', '/usr/local/bin/grok:/usr/local/bin/grok:ro']),
    );
  });

  test('round 3 B7: resolveHostBinaryPath is never consulted once a non-default image is explicitly configured', () => {
    let called = false;
    const result = wrapAgentCommand(
      { ...baseInput, role: 'reviewer', requiresSandbox: true },
      {
        detectBackendDeps: containerDeps(),
        gitPathsDeps: noIoDeps.gitPathsDeps,
        resolveHostBinaryPath: () => {
          called = true;
          return '/usr/local/bin/grok';
        },
        containerOptions: { image: 'agile/grok-acp:1' },
      },
    );
    expect(called).toBe(false);
    expect(result.args).not.toContain('/usr/local/bin/grok');
    expect(result.args).toContain('agile/grok-acp:1');
  });

  test('round 2 B3: socketPath flows through into the rendered sandbox-exec profile', () => {
    const result = wrapAgentCommand(
      { ...baseInput, requiresSandbox: true, socketPath: '/repo/.agile-daemon.sock' },
      {
        detectBackendDeps: sandboxExecDeps(),
        ...noIoDeps,
        writeProfileFile: (contents) => {
          expect(contents).toContain('/repo/.agile-daemon.sock');
          return '/tmp/p.sb';
        },
      },
    );
    expect(result.backend).toBe('sandbox-exec');
  });

  test('backend sandbox-exec: writes the profile via the injected writer and wraps under sandbox-exec', () => {
    const written: string[] = [];
    const result = wrapAgentCommand(
      { ...baseInput, requiresSandbox: true },
      {
        detectBackendDeps: sandboxExecDeps(),
        ...noIoDeps,
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
