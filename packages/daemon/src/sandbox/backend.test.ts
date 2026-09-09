import { describe, expect, test } from 'bun:test';
import { type DetectBackendDeps, detectBackend } from './backend';

function deps(overrides: Partial<DetectBackendDeps>): DetectBackendDeps {
  return {
    platform: () => 'linux',
    hasSandboxExec: () => false,
    hasContainerRuntime: () => false,
    ...overrides,
  };
}

describe('detectBackend', () => {
  test('darwin + sandbox-exec present -> sandbox-exec', () => {
    expect(detectBackend(deps({ platform: () => 'darwin', hasSandboxExec: () => true }))).toBe(
      'sandbox-exec',
    );
  });

  test('darwin without sandbox-exec falls through to container', () => {
    expect(
      detectBackend(
        deps({
          platform: () => 'darwin',
          hasSandboxExec: () => false,
          hasContainerRuntime: () => true,
        }),
      ),
    ).toBe('container');
  });

  test('linux + reachable container runtime -> container', () => {
    expect(detectBackend(deps({ hasContainerRuntime: () => true }))).toBe('container');
  });

  test('linux, no sandbox-exec (platform-gated), no container daemon -> none', () => {
    expect(detectBackend(deps({}))).toBe('none');
  });

  test('a docker binary with no reachable daemon must resolve none, never throw', () => {
    const throwing = deps({
      hasContainerRuntime: () => {
        // Mirrors the real check: binary present, `docker info` fails ->
        // caught internally -> false. This test asserts the *contract*
        // (deps.hasContainerRuntime never lets an exception reach
        // detectBackend), not backend.ts's internal try/catch directly.
        return false;
      },
    });
    expect(() => detectBackend(throwing)).not.toThrow();
    expect(detectBackend(throwing)).toBe('none');
  });

  test('darwin with sandbox-exec is preferred even when a container runtime is also available', () => {
    expect(
      detectBackend(
        deps({
          platform: () => 'darwin',
          hasSandboxExec: () => true,
          hasContainerRuntime: () => true,
        }),
      ),
    ).toBe('sandbox-exec');
  });
});
