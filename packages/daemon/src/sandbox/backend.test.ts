import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      const { env, cleanup } = dockerProbeEnv(repoRoot);
      const cacheRoot = join(repoRoot, '.agile-daemon-cache', 'sandbox-detect');
      expect(env.HOME).toBe(join(cacheRoot, 'home'));
      expect(env.npm_config_cache).toBe(join(cacheRoot, 'npm-cache'));
      expect(env.XDG_CACHE_HOME).toBe(join(cacheRoot, 'xdg-cache'));
      expect(env.HOME).not.toBe(process.env.HOME);
      // Directories are created eagerly, same contract as `sandboxedSubprocessEnv`.
      expect(existsSync(env.HOME as string)).toBe(true);
      // The repoRoot form has nothing of its own to clean up — the cache
      // dir belongs to the caller, same as every other `sandboxedSubprocessEnv`
      // call — so `cleanup()` must never remove the repoRoot's cache.
      cleanup();
      expect(existsSync(env.HOME as string)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('without a repoRoot (a bare, no-args real-deps probe), falls back to a fresh mkdtemp under the OS temp dir — never process.cwd(), never a fixed shared path', () => {
    const cwdMarker = process.cwd();
    const { env, cleanup } = dockerProbeEnv(undefined);
    // Never rooted under the current working directory (round 1 finding:
    // this used to default to `process.cwd()`, which materialized
    // `.agile-daemon-cache/` inside whatever repo `bun test` happened to
    // run from).
    expect(env.HOME?.startsWith(cwdMarker)).toBe(false);
    expect(env.HOME?.startsWith(tmpdir())).toBe(true);
    // Round 2 finding: a *fixed* `<tmpdir>/.agile-daemon-cache/sandbox-detect/`
    // is exactly as unsafe, just world-shared — every no-repo-root probe
    // must get its own, distinctly-named temp directory.
    expect(env.HOME).not.toBe(join(tmpdir(), '.agile-daemon-cache', 'sandbox-detect', 'home'));
    expect(existsSync(env.HOME as string)).toBe(true);
    cleanup();
  });

  test('two concurrent no-repoRoot probes never collide on the same directory', () => {
    const a = dockerProbeEnv(undefined);
    const b = dockerProbeEnv(undefined);
    try {
      expect(a.env.HOME).not.toBe(b.env.HOME);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('cleanup() removes the temp directory a no-repoRoot probe created', () => {
    const { env, cleanup } = dockerProbeEnv(undefined);
    // The temp base two levels above `HOME` (`<base>/sandbox-detect/home`).
    const tempBase = join(env.HOME as string, '..', '..');
    expect(existsSync(tempBase)).toBe(true);
    cleanup();
    expect(existsSync(tempBase)).toBe(false);
  });
});

describe('dockerProbeEnv (T034 round 3): no-repo-root fallback survives the old fixed path being occupied', () => {
  test('the old fixed <tmpdir>/.agile-daemon-cache/sandbox-detect/home path being a regular file does not stop a fresh probe', () => {
    const staleFixedRoot = join(tmpdir(), '.agile-daemon-cache', 'sandbox-detect');
    mkdirSync(join(tmpdir(), '.agile-daemon-cache'), { recursive: true });
    // A previous run (this repo's own round 1/2 regression, or any other
    // process) may have already left this path as a directory — clear
    // whatever is there first so this test deterministically starts from
    // "occupied by a regular file", the round 2 B2 scenario.
    rmSync(staleFixedRoot, { recursive: true, force: true });
    // Occupy the old fixed path's shape with a regular file, exactly as
    // round 2's B2 scenario describes ("a regular file, a symlink, another
    // uid's directory").
    writeFileSync(staleFixedRoot, 'occupied by something else');
    try {
      const { env, cleanup } = dockerProbeEnv(undefined);
      try {
        expect(existsSync(env.HOME as string)).toBe(true);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(staleFixedRoot, { force: true });
    }
  });
});

/**
 * A stub `docker` on `$PATH` that exits with `exitCode` and, when
 * `envLogPath` is given, writes its own received env (one `KEY=value` per
 * line) to that file before exiting — lets a test assert the *actual*
 * spawn env without needing a real docker daemon (round 1 review's
 * technique; round 1's version of this file dropped it, round 2 asked for
 * it back per N3).
 */
function installStubDocker(
  exitCode: 0 | 1,
  envLogPath?: string,
): { binDir: string; restore: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), 'agile-stub-docker-bin-'));
  const script = [
    '#!/bin/sh',
    envLogPath ? `env > ${JSON.stringify(envLogPath)}` : '',
    `exit ${exitCode}`,
    '',
  ].join('\n');
  const stubPath = join(binDir, 'docker');
  writeFileSync(stubPath, script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return {
    binDir,
    restore: () => {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

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

  test('N3: a stub docker on PATH actually receives the sandboxed HOME, not the operator’s real one', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'agile-sandbox-detect-'));
    const envLogPath = join(repoRoot, 'received-env.txt');
    const stub = installStubDocker(0, envLogPath);
    try {
      expect(dockerDaemonReachable(repoRoot)).toBe(true);
      const receivedEnv = readFileSync(envLogPath, 'utf8');
      const cacheRoot = join(repoRoot, '.agile-daemon-cache', 'sandbox-detect');
      expect(receivedEnv).toContain(`HOME=${join(cacheRoot, 'home')}`);
      expect(receivedEnv).not.toContain(`HOME=${process.env.HOME}\n`);
    } finally {
      stub.restore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('B2: a stub docker exiting 0, with the old fixed <tmpdir>/.agile-daemon-cache/sandbox-detect/ path occupied by a regular file, still resolves detectBackend() away from "none"', () => {
    const staleFixedRoot = join(tmpdir(), '.agile-daemon-cache', 'sandbox-detect');
    mkdirSync(join(tmpdir(), '.agile-daemon-cache'), { recursive: true });
    // A previous run (this repo's own round 1/2 regression, or any other
    // process) may have already left this path as a directory — clear
    // whatever is there first so this test deterministically starts from
    // "occupied by a regular file", the round 2 B2 scenario.
    rmSync(staleFixedRoot, { recursive: true, force: true });
    writeFileSync(staleFixedRoot, 'occupied by another process entirely');
    const stub = installStubDocker(0);
    try {
      // Exercised the way production actually calls it: no repo root at
      // all, through `defaultDetectBackendDeps.hasContainerRuntime`.
      expect(dockerDaemonReachable()).toBe(true);
      expect(
        detectBackend({
          platform: () => 'linux',
          hasSandboxExec: () => false,
          hasContainerRuntime: () => dockerDaemonReachable(),
        }),
      ).toBe('container');
    } finally {
      stub.restore();
      rmSync(staleFixedRoot, { force: true });
    }
  });
});
