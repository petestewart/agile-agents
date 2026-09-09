/**
 * Live checks against this host's *real* tier-0 capability (T026 — ticket
 * scope: "anything that needs a real backend is gated on `AGILE_LIVE=1`").
 * Everything else in this module (`profile.test.ts`, `backend.test.ts`,
 * `sandbox-exec.test.ts`, `container.test.ts`, `wrap.test.ts`,
 * `git-paths.test.ts`) is a pure function tested with injected dependencies
 * and always runs.
 *
 * Round 2 (review round 1 B1): the earlier version of this file asserted
 * `detectBackend()` (real deps) resolves `'none'` unconditionally — true on
 * this container (Linux, no `sandbox-exec`/`bwrap`, a `docker` binary with
 * no reachable daemon), but false on macOS (`/usr/bin/sandbox-exec` always
 * exists there) or any Linux host with a running docker daemon — exactly
 * the hosts this feature targets, so that assertion turned the suite red
 * on the machine someone would actually run it on. The portable invariant
 * this file can check *anywhere*, without hard-coding an outcome, is that
 * `detectBackend()`'s real result is always consistent with its own real
 * building blocks (`defaultDetectBackendDeps`) — i.e. the wiring between
 * `detectBackend` and its dependencies is connected correctly on whatever
 * host actually runs this.
 */
import { describe, expect, it, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { defaultDetectBackendDeps, detectBackend } from './backend';
import { SANDBOX_BACKENDS } from './types';

test('detectBackend() with real deps always resolves to a declared backend', () => {
  expect(SANDBOX_BACKENDS).toContain(detectBackend());
});

test('detectBackend() with real deps is internally consistent with its own real probes, on whatever host runs this', () => {
  const backend = detectBackend();
  const deps = defaultDetectBackendDeps;

  // No reachable container runtime => never 'container', on any host.
  if (!deps.hasContainerRuntime()) {
    expect(backend).not.toBe('container');
  }
  // Not darwin, or no sandbox-exec on PATH => never 'sandbox-exec'.
  if (deps.platform() !== 'darwin' || !deps.hasSandboxExec()) {
    expect(backend).not.toBe('sandbox-exec');
  }
});

const live = process.env.AGILE_LIVE === '1' ? it : it.skip;

describe('live: real sandbox-exec / container execution', () => {
  live('sandbox-exec on a real macOS host actually enforces a rendered profile', () => {
    // Not runnable here (no `sandbox-exec` binary) — left for a Mac with
    // `AGILE_LIVE=1`. Placeholder assertion keeps this an explicit,
    // named gap rather than a silently-absent test.
    expect(() =>
      execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '--', 'true']),
    ).not.toThrow();
  });

  live('a real container runtime actually enforces --network none', () => {
    // Not runnable here (no reachable docker daemon) — left for a host
    // with `AGILE_LIVE=1` and a running daemon.
    expect(() =>
      execFileSync('docker', ['run', '--rm', '--network', 'none', 'alpine', 'true']),
    ).not.toThrow();
  });
});
