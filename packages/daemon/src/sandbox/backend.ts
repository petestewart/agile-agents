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
import { platform } from 'node:os';
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
 * T034: `docker info` must never run with the daemon's own inherited
 * `$HOME` — the docker CLI reads/writes `$HOME/.docker/config.json` (or
 * creates it) on every invocation, which is exactly the shape of leak this
 * ticket exists to close (T021 found the same thing for `npm test`'s debug
 * logger). `repoRoot` defaults to `process.cwd()` — every other daemon
 * entry point that lacks an explicit repo root uses the same default (see
 * `config.ts`), and in production the daemon process's cwd *is* its repo
 * root. Callers with a real repo root handy should pass it explicitly.
 */
export function dockerDaemonReachable(repoRoot: string = process.cwd()): boolean {
  if (!binaryOnPath('docker')) return false;
  try {
    // `docker info` fails fast (no daemon socket) rather than hanging when
    // the daemon isn't running — confirmed on this container: "failed to
    // connect to the docker API at unix:///var/run/docker.sock ...".
    execFileSync('docker', ['info'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      env: sandboxedSubprocessEnv(repoRoot, 'sandbox-detect'),
    });
    return true;
  } catch {
    return false;
  }
}

/** Real dependencies — what `detectBackend()` uses when called with no args. */
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
