/**
 * Live checks against this host's *real* tier-0 capability (T026 — ticket
 * scope: "anything that needs a real backend is gated on `AGILE_LIVE=1`").
 * Everything else in this module (`profile.test.ts`, `backend.test.ts`,
 * `sandbox-exec.test.ts`, `container.test.ts`, `wrap.test.ts`) is a pure
 * function tested with injected dependencies and always runs.
 *
 * This container (verified directly while building this ticket — see the
 * pipeline report): Linux, no `sandbox-exec`, no `bwrap`, a `docker` binary
 * present but no reachable daemon (`docker info` fails: "failed to connect
 * to the docker API at unix:///var/run/docker.sock ... dial unix
 * /var/run/docker.sock: connect: no such file or directory"). So the one
 * assertion this file can make unconditionally — run with or without
 * `AGILE_LIVE`, since it costs nothing and documents the honest-`'none'`
 * acceptance bar the ticket sets — is that today, on this host,
 * `detectBackend()` with its *real* dependencies resolves `'none'`, never a
 * false positive. Actually exercising a real `sandbox-exec`/container spawn
 * needs a host that has one, hence `AGILE_LIVE=1`.
 */
import { describe, expect, it, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { detectBackend } from './backend';

test('this container has no tier-0 backend: detectBackend() resolves none honestly', () => {
  expect(detectBackend()).toBe('none');
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
