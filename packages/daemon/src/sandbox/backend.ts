/**
 * `detectBackend` — which tier-0 mechanism (if any) this machine can
 * actually run (T026 — ticket scope: "a `detectBackend()` that reports
 * `none` honestly when neither works").
 *
 * Every check is injected so the pure branch logic is unit-testable without
 * touching the real filesystem/network; only the *default* dependencies
 * (used when the daemon calls this for real) shell out. The container this
 * ticket was built in has neither (Linux, no `sandbox-exec`/`bwrap`, and a
 * `docker` binary with no reachable daemon) — verified directly, see the
 * pipeline report — so on this machine `detectBackend()` correctly and
 * honestly resolves to `'none'`.
 */

import { execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { sandboxedSubprocessEnv } from '../subprocess-env';
import type { SandboxBackend } from './types';

export interface DetectBackendDeps {
  /** Defaults to `os.platform()`. */
  platform: () => NodeJS.Platform;
  /** Whether `sandbox-exec` is on `$PATH` — only meaningful on `darwin`. */
  hasSandboxExec: () => boolean;
  /** Whether a container runtime is installed *and* its daemon is reachable right now (a `docker` binary with no running daemon must resolve `false`, not throw). */
  hasContainerRuntime: () => boolean;
}

function binaryOnPath(bin: string): boolean {
  try {
    // `command -v` is POSIX and doesn't require the binary to run cleanly
    // (unlike `--version`, which some CLIs don't support) — just presence.
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * The env `dockerDaemonReachable` spawns `docker info` with — pulled out
 * as its own pure function (T034 round 2 review) so a test can assert its
 * shape directly and deterministically, without needing a real `docker`
 * binary on the test host or depending on `execFileSync` actually running.
 *
 * `repoRoot` is never defaulted to `process.cwd()` (round 1 finding: that
 * made every plain `bun test` invocation materialize
 * `<cwd>/.agile-daemon-cache/` inside whatever directory happened to be the
 * working directory when the test process started — this repo checkout,
 * in CI). Callers that know their repo root must pass it; a caller that
 * doesn't (this module's own bare, no-args real-deps probe — nothing
 * upstream of `detectBackend()` threads a real repo root through today,
 * see the pipeline report's "still-unsandboxed" list) sandboxes under the
 * OS temp directory instead, which is always safe to write into and never
 * shows up in any repo's `git status`.
 */
export function dockerProbeEnv(repoRoot: string | undefined): Record<string, string> {
  return sandboxedSubprocessEnv(repoRoot ?? tmpdir(), 'sandbox-detect');
}

/**
 * T034: `docker info` must never run with the daemon's own inherited
 * `$HOME` — the docker CLI reads/writes `$HOME/.docker/config.json` (or
 * creates it) on every invocation, which is exactly the shape of leak this
 * ticket exists to close (T021 found the same thing for `npm test`'s debug
 * logger). See `dockerProbeEnv` for how `repoRoot` is resolved.
 */
export function dockerDaemonReachable(repoRoot?: string): boolean {
  if (!binaryOnPath('docker')) return false;
  try {
    // `docker info` fails fast (no daemon socket) rather than hanging when
    // the daemon isn't running — confirmed on this container: "failed to
    // connect to the docker API at unix:///var/run/docker.sock ...".
    execFileSync('docker', ['info'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      env: dockerProbeEnv(repoRoot),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real dependencies — what `detectBackend()` uses when called with no
 * args. `hasContainerRuntime` never has a repo root to pass (nothing
 * upstream threads one through — see `dockerProbeEnv`'s doc comment), so
 * every real-deps probe sandboxes under the OS temp dir.
 */
export const defaultDetectBackendDeps: DetectBackendDeps = {
  platform,
  hasSandboxExec: () => binaryOnPath('sandbox-exec'),
  hasContainerRuntime: () => dockerDaemonReachable(),
};

/**
 * `sandbox-exec` is macOS-only and preferred when present (ticket scope
 * ordering: "a macOS `sandbox-exec` backend ... a container backend
 * fallback"). Falls back to a working container runtime on any platform,
 * else `'none'` — never a guess, never a silent pass-through.
 */
export function detectBackend(deps: DetectBackendDeps = defaultDetectBackendDeps): SandboxBackend {
  if (deps.platform() === 'darwin' && deps.hasSandboxExec()) return 'sandbox-exec';
  if (deps.hasContainerRuntime()) return 'container';
  return 'none';
}
