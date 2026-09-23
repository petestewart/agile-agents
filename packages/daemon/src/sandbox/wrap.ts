/**
 * `wrapAgentCommand`: the seam `runner/session.ts` calls before spawning an
 * agent (tier 0). Combines `buildSandboxProfile`, `detectBackend` and the
 * per-backend renderer, and holds the fail-closed rule: a requested
 * sandbox with no sufficient backend is refused, never run unsandboxed.
 *
 * A backend merely being available is never a reason to wrap: wrapping
 * happens only when `requiresSandbox` (mandatory) or `enabled` (explicit
 * opt-in) is set, and both fail closed. With neither set the command
 * passes through, so a Mac with `sandbox-exec` behaves as before.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRole } from '../permissions';
import { type DetectBackendDeps, defaultDetectBackendDeps, detectBackend } from './backend';
import {
  type ContainerCommandOptions,
  DEFAULT_SANDBOX_IMAGE,
  buildContainerCommand,
} from './container';
import { type GitPathsDeps, resolveWorktreeGitPaths } from './git-paths';
import { buildSandboxProfile } from './profile';
import { buildSandboxExecCommand, renderSandboxExecProfile } from './sandbox-exec';
import type { WrappedCommand } from './types';

export interface WrapAgentCommandInput {
  role: PermissionRole;
  worktreePath: string;
  /** ACP provider id (`ACP_PROVIDERS` key) — `claude`, `openai`, `cursor`, `gemini`, `grok`, ... */
  vendor: string;
  command: string;
  args: readonly string[];
  /** `VendorConfig.requires_sandbox`: `true` for vendors whose bridge has no gated exec (Codex, Grok). Default `false`. */
  requiresSandbox?: boolean;
  /** Explicit opt-in to wrap a vendor that doesn't require it. Default `false`. */
  enabled?: boolean;
  extraAllowedHosts?: readonly string[];
  /** `AGILE_SOCKET_PATH`: the profile must grant the daemon socket or the hooks break under tier 0. */
  socketPath?: string;
}

export type WrapAgentCommandFn = (input: WrapAgentCommandInput) => WrappedCommand;

export interface WrapAgentCommandDeps {
  detectBackendDeps?: DetectBackendDeps;
  /** Test seam: the `sandbox-exec` temp profile write. Returns the path written. */
  writeProfileFile?: (contents: string) => string;
  /** Test seam for git-paths resolution. */
  gitPathsDeps?: GitPathsDeps;
  /**
   * Resolves a host vendor binary to mount into the container. No default:
   * mounting the host's binary unconditionally once shadowed a custom
   * image's own CLI (a Mac binary on a Linux image). Only consulted with
   * the CLI-less `DEFAULT_SANDBOX_IMAGE`.
   */
  resolveHostBinaryPath?: (cmd: string) => string | undefined;
  /** Passed through to `buildContainerCommand`. */
  containerOptions?: Omit<ContainerCommandOptions, 'hostBinaryPath'>;
}

function defaultWriteProfileFile(contents: string): string {
  const path = join(tmpdir(), `agile-sandbox-${process.pid}-${Date.now()}.sb`);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/**
 * Tier 0 was requested (`requiresSandbox` or `enabled`) and no sufficient
 * backend exists. The caller must refuse the spawn, never run it
 * unsandboxed or under-sandboxed.
 */
export class SandboxRequiredError extends Error {
  readonly vendor: string;
  readonly role: PermissionRole;
  constructor(vendor: string, role: PermissionRole, reason?: string) {
    super(
      `sandbox required for vendor '${vendor}' but ${
        reason ?? "no tier-0 backend is available on this host (detectBackend() -> 'none')"
      }; refusing to run '${role}' unsandboxed (design §6, fail-closed).`,
    );
    this.name = 'SandboxRequiredError';
    this.vendor = vendor;
    this.role = role;
  }
}

/**
 * Docker has no per-host egress filter, so the container backend can
 * enforce "no network" (reviewer) but not "these registries only"
 * (engineer): for a `requiresSandbox` engineer, `container` is as
 * insufficient as `none`. A real allow-list would need an egress proxy.
 */
function backendInsufficientForRequiredSandbox(
  backend: 'sandbox-exec' | 'container',
  role: PermissionRole,
): boolean {
  return backend === 'container' && role === 'engineer';
}

function passthrough(input: WrapAgentCommandInput): WrappedCommand {
  return { backend: 'none', command: input.command, args: [...input.args], envOverrides: {} };
}

/**
 * Builds the `SandboxProfile`, detects the backend and returns the wrapped
 * command, or throws `SandboxRequiredError` when sandboxing was requested
 * and no backend (or, for `requiresSandbox`, no sufficient one) exists.
 */
export function wrapAgentCommand(
  input: WrapAgentCommandInput,
  deps: WrapAgentCommandDeps = {},
): WrappedCommand {
  // Neither flag: passthrough, without probing for a backend (the probe
  // shells out, `docker info` with a 5 s timeout, on every spawn).
  if (!input.requiresSandbox && !input.enabled) {
    return passthrough(input);
  }

  const backend = detectBackend(deps.detectBackendDeps ?? defaultDetectBackendDeps);

  if (backend === 'none') {
    // Sandboxing was requested: fail closed.
    throw new SandboxRequiredError(input.vendor, input.role);
  }

  if (input.requiresSandbox && backendInsufficientForRequiredSandbox(backend, input.role)) {
    throw new SandboxRequiredError(
      input.vendor,
      input.role,
      "the only available tier-0 backend is 'container', which cannot enforce an " +
        "engineer's package-registry network allow-list (Docker has no per-host " +
        "egress-filtering primitive — design §14's network column is unmet for this role)",
    );
  }

  const gitPaths =
    input.role === 'engineer'
      ? (resolveWorktreeGitPaths(input.worktreePath, deps.gitPathsDeps) ?? undefined)
      : undefined;

  const profile = buildSandboxProfile({
    role: input.role,
    worktreePath: input.worktreePath,
    vendor: input.vendor,
    extraAllowedHosts: input.extraAllowedHosts,
    socketPath: input.socketPath,
    gitPaths,
  });

  if (backend === 'sandbox-exec') {
    const profileText = renderSandboxExecProfile(profile);
    const writeProfileFile = deps.writeProfileFile ?? defaultWriteProfileFile;
    const profilePath = writeProfileFile(profileText);
    const wrapped = buildSandboxExecCommand(profilePath, input.command, input.args, profileText);
    return {
      backend,
      command: wrapped.command,
      args: wrapped.args,
      envOverrides: {},
      profileText: wrapped.profileText,
    };
  }

  // Container: consult `resolveHostBinaryPath` only for the CLI-less
  // default image; a configured image carries its own CLI.
  const configuredImage = deps.containerOptions?.image;
  const imageIsCliLessDefault =
    configuredImage === undefined || configuredImage === DEFAULT_SANDBOX_IMAGE;
  const hostBinaryPath =
    imageIsCliLessDefault && deps.resolveHostBinaryPath
      ? deps.resolveHostBinaryPath(input.command)
      : undefined;
  const wrapped = buildContainerCommand(profile, input.command, input.args, {
    ...deps.containerOptions,
    ...(hostBinaryPath ? { hostBinaryPath } : {}),
  });
  return { backend, command: wrapped.command, args: wrapped.args, envOverrides: {} };
}
