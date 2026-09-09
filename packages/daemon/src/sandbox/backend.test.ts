import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DetectBackendDeps, detectBackend, dockerDaemonReachable } from './backend';

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

describe('dockerDaemonReachable (T034)', () => {
  let repoRoot: string;

  test('runs `docker info` with a sandboxed HOME under <repoRoot>/.agile-daemon-cache/, never the real one', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'agile-sandbox-detect-'));
    try {
      // Never throws regardless of whether a real `docker` binary/daemon is
      // present on this host (mirrors the real-deps contract `backend.test.ts`
      // already asserts for `detectBackend()` above).
      expect(() => dockerDaemonReachable(repoRoot)).not.toThrow();
      // Whether or not a `docker` binary is on `$PATH` here, if it is, the
      // sandboxed cache directory the probe's env points `$HOME` at must
      // have been created — the observable proof `execFileSync` actually
      // received the sandboxed env, not the daemon's inherited one.
      const cacheHome = join(repoRoot, '.agile-daemon-cache', 'sandbox-detect', 'home');
      // Only asserted when a `docker` binary exists on this host — the
      // function short-circuits (never spawns anything, never builds the
      // env) when it doesn't, which is itself correct behaviour.
      if (Bun.which('docker')) {
        expect(existsSync(cacheHome)).toBe(true);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
