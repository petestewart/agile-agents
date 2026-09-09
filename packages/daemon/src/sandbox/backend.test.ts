import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DetectBackendDeps,
  detectBackend,
  dockerDaemonReachable,
  dockerProbeEnv,
} from './backend';

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

describe('dockerProbeEnv (T034 round 2)', () => {
  // Pure and deterministic — no `docker` binary or real spawn needed, so
  // this runs identically on every host (round 1 review: the previous
  // version of this test only asserted anything when `docker` happened to
  // be on `$PATH`, i.e. it could silently assert nothing at all).
  test('with a repoRoot, HOME/npm_config_cache/XDG_* are sandboxed under <repoRoot>/.agile-daemon-cache/sandbox-detect/', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'agile-sandbox-detect-'));
    try {
      const env = dockerProbeEnv(repoRoot);
      const cacheRoot = join(repoRoot, '.agile-daemon-cache', 'sandbox-detect');
      expect(env.HOME).toBe(join(cacheRoot, 'home'));
      expect(env.npm_config_cache).toBe(join(cacheRoot, 'npm-cache'));
      expect(env.XDG_CACHE_HOME).toBe(join(cacheRoot, 'xdg-cache'));
      expect(env.HOME).not.toBe(process.env.HOME);
      // Directories are created eagerly, same contract as `sandboxedSubprocessEnv`.
      expect(existsSync(env.HOME as string)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('without a repoRoot (a bare, no-args real-deps probe), falls back to the OS temp dir — never process.cwd()', () => {
    const cwdMarker = process.cwd();
    const env = dockerProbeEnv(undefined);
    // Never rooted under the current working directory (round 1 finding:
    // this used to default to `process.cwd()`, which materialized
    // `.agile-daemon-cache/` inside whatever repo `bun test` happened to
    // run from).
    expect(env.HOME?.startsWith(cwdMarker)).toBe(false);
    expect(env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(existsSync(env.HOME as string)).toBe(true);
    rmSync(env.HOME as string, { recursive: true, force: true });
  });
});

describe('dockerDaemonReachable (T034)', () => {
  test('never throws, and (if it probes at all) uses the given repoRoot, never process.cwd()', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'agile-sandbox-detect-'));
    try {
      expect(() => dockerDaemonReachable(repoRoot)).not.toThrow();
      // Whether or not a real `docker` binary/daemon is present on this
      // host, this repo checkout's own `process.cwd()` must never end up
      // with a `.agile-daemon-cache/` from this call (round 1 finding).
      expect(existsSync(join(process.cwd(), '.agile-daemon-cache', 'sandbox-detect'))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
