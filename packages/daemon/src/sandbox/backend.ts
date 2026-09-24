/**
 * `detectBackend`: which tier-0 mechanism this machine can actually run,
 * reporting `none` honestly when neither works. Every check is injected,
 * so only the default dependencies shell out.
 */

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { type SandboxedSubprocessEnvOrTemp, sandboxedSubprocessEnvOrTemp } from '../subprocess-env';
import type { SandboxBackend } from './types';

export interface DetectBackendDeps {
  /** Defaults to `os.platform()`. */
  platform: () => NodeJS.Platform;
  /** `sandbox-exec` on `$PATH` (darwin only). */
  hasSandboxExec: () => boolean;
  /** A container runtime installed and its daemon reachable now (no daemon ⇒ `false`, never a throw). */
  hasContainerRuntime: () => boolean;
}

/**
 * `command -v`: presence only (unlike `--version`). Takes a built env so
 * one probe can serve several checks.
 */
function commandOnPath(bin: string, env: Record<string, string>): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** A one-shot presence probe with its own temp sandbox (nothing upstream has a repo root). */
function hasBinaryOnPath(bin: string): boolean {
  const probe = dockerProbeEnv(undefined);
  try {
    return commandOnPath(bin, probe.env);
  } finally {
    probe.cleanup();
  }
}

/** A probe's env plus `cleanup()` for anything created just for it. */
export type DockerProbeEnv = SandboxedSubprocessEnvOrTemp;

/**
 * The env probes spawn with: never the daemon's `$HOME` and never a
 * `process.cwd()` default (that once littered every test run's cwd). With
 * no repo root it is a fresh `mkdtempSync` dir per call, since a fixed
 * shared temp path could be pre-occupied by another process and silently
 * downgrade tier 0 to `none`.
 */
export function dockerProbeEnv(repoRoot: string | undefined, tempDirBase?: string): DockerProbeEnv {
  return sandboxedSubprocessEnvOrTemp(repoRoot, 'sandbox-detect', tempDirBase);
}

/**
 * Upper bound on one `docker` daemon probe. `docker info` against an
 * installed-but-slow or unresponsive daemon (e.g. a CI runner's docker, a
 * wedged Docker Desktop) can sit for seconds; detection must not block the
 * caller that long, so an unanswered probe counts as "unreachable".
 */
export const DOCKER_PROBE_TIMEOUT_MS = 1500;

/**
 * `docker version --format {{.Server.Version}}` in a sandboxed env: it needs
 * the daemon to answer (no daemon => non-zero exit) but, unlike `docker
 * info`, skips the CLI-plugin scan and full system report that make `info`
 * take seconds on a loaded host. (the docker CLI writes
 * `$HOME/.docker/config.json`). Building the env happens outside the
 * try/catch: a setup failure is a real error, not "docker unreachable".
 * One probe env serves both the presence check and the daemon query.
 */
export function dockerDaemonReachable(
  repoRoot?: string,
  tempDirBase?: string,
  timeoutMs: number = DOCKER_PROBE_TIMEOUT_MS,
): boolean {
  const probe = dockerProbeEnv(repoRoot, tempDirBase);
  try {
    if (!commandOnPath('docker', probe.env)) return false;
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: probe.env,
    });
    return true;
  } catch {
    return false;
  } finally {
    probe.cleanup();
  }
}

/** Real dependencies, used when `detectBackend()` gets no args. */
export const defaultDetectBackendDeps: DetectBackendDeps = {
  platform,
  hasSandboxExec: () => hasBinaryOnPath('sandbox-exec'),
  hasContainerRuntime: () => dockerDaemonReachable(),
};

/** Prefers macOS `sandbox-exec`, else a working container runtime, else `'none'`: never a guess. */
export function detectBackend(deps: DetectBackendDeps = defaultDetectBackendDeps): SandboxBackend {
  if (deps.platform() === 'darwin' && deps.hasSandboxExec()) return 'sandbox-exec';
  if (deps.hasContainerRuntime()) return 'container';
  return 'none';
}
