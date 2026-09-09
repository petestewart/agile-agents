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
import { mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A probe's env plus how to release whatever `dockerProbeEnv` had to create just for this one call — see its doc comment. */
export interface DockerProbeEnv {
  env: Record<string, string>;
  /** Removes the probe's own temp directory. A no-op when `repoRoot` was given: that cache directory belongs to the caller, not this probe, so it is left in place (same lifetime as every other `sandboxedSubprocessEnv` caller's cache). */
  cleanup: () => void;
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
 * see the pipeline report's "still-unsandboxed" list) used to sandbox under
 * a *fixed* `os.tmpdir()/.agile-daemon-cache/sandbox-detect/` path instead.
 *
 * Round 2 review (blocker 2): that fixed path is exactly as unsafe as the
 * `process.cwd()` default it replaced, just world-shared instead of
 * per-repo — any other process on the host (another user's daemon, a stray
 * script, an attacker) can occupy it first (a regular file, someone else's
 * directory, a symlink), and `mkdirSync` failing there was being folded
 * into "docker unreachable" by `dockerDaemonReachable`'s own try/catch,
 * silently downgrading the whole tier-0 sandbox to `'none'`. The no-repo-root
 * fallback now `mkdtempSync`s a fresh, uid/pid-unique directory per call —
 * nothing else on the host can already be occupying it — and hands back a
 * `cleanup()` to remove it once the one-shot probe is done with it.
 */
export function dockerProbeEnv(repoRoot: string | undefined): DockerProbeEnv {
  if (repoRoot !== undefined) {
    return { env: sandboxedSubprocessEnv(repoRoot, 'sandbox-detect'), cleanup: () => {} };
  }
  const tempBase = mkdtempSync(join(tmpdir(), 'agile-daemon-sandbox-detect-'));
  return {
    env: sandboxedSubprocessEnv(tempBase, 'sandbox-detect'),
    cleanup: () => {
      try {
        rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Best-effort — a leaked one-shot probe dir under the OS temp
        // directory is not a correctness bug.
      }
    },
  };
}

/**
 * T034: `docker info` must never run with the daemon's own inherited
 * `$HOME` — the docker CLI reads/writes `$HOME/.docker/config.json` (or
 * creates it) on every invocation, which is exactly the shape of leak this
 * ticket exists to close (T021 found the same thing for `npm test`'s debug
 * logger). See `dockerProbeEnv` for how `repoRoot` is resolved.
 *
 * Round 2 review (blocker 2): building the probe's env — which, for the
 * no-repo-root case, means `mkdtempSync`ing a directory — happens here,
 * *outside* the try/catch around the actual `docker info` spawn below. A
 * failure there (a full disk, a permissions problem) is a distinct,
 * real failure and is left to throw out of this function rather than being
 * folded into the same catch as "docker unreachable", which is precisely
 * the bug that let a probe-setup failure silently read as "no docker".
 */
export function dockerDaemonReachable(repoRoot?: string): boolean {
  if (!binaryOnPath('docker')) return false;
  const probe = dockerProbeEnv(repoRoot);
  try {
    // `docker info` fails fast (no daemon socket) rather than hanging when
    // the daemon isn't running — confirmed on this container: "failed to
    // connect to the docker API at unix:///var/run/docker.sock ...".
    execFileSync('docker', ['info'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      env: probe.env,
    });
    return true;
  } catch {
    return false;
  } finally {
    probe.cleanup();
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
