/**
 * `wrapAgentCommand` — the one function `runner/session.ts` calls before
 * spawning an agent process (T026 ticket scope: "a small injectable seam in
 * `runner/session.ts` (how the agent process command is wrapped before
 * spawn)"). Combines `buildSandboxProfile` + `detectBackend` + the
 * per-backend renderer into one call, and is where the fail-closed routing
 * rule lives: "with backend `none` such a vendor must be refused for
 * routing, never silently run unsandboxed (fail-closed, same philosophy as
 * the hooks)".
 *
 * Round 2 (review round 1 B2): a backend being *available* is not itself a
 * reason to wrap. The manager's constraint is explicit — with
 * `requiresSandbox` unset, today's behaviour (an unwrapped spawn) must not
 * change just because a Mac happens to have `sandbox-exec` on `$PATH`.
 * Wrapping now only happens when `requiresSandbox` is set (mandatory,
 * fail-closed on `'none'`) or `enabled` is explicitly passed (an opt-in a
 * future config surface can set) — never merely because a backend exists.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRole } from '../permissions';
import { type DetectBackendDeps, defaultDetectBackendDeps, detectBackend } from './backend';
import { type ContainerCommandOptions, buildContainerCommand } from './container';
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
  /** From `VendorConfig.requires_sandbox` (`packages/shared/src/vendors.ts`) — `true` for vendors whose bridge has no gated exec (Codex, Grok per §6). Defaults `false` so a caller that hasn't loaded `vendors.yaml` yet (or a vendor the config omits) never accidentally trips the fail-closed refusal. Also the *only* thing that turns wrapping on by itself — see `enabled` below and this file's header (round 2 B2). */
  requiresSandbox?: boolean;
  /**
   * Explicit opt-in to wrap even when the vendor doesn't require it (a
   * future policy/config flag's seam) — round 2 B2: a backend merely being
   * *available* must never be enough on its own, or every Claude session on
   * a Mac starts silently running under an unverified SBPL profile the
   * moment this code ships. Defaults `false`.
   */
  enabled?: boolean;
  extraAllowedHosts?: readonly string[];
  /** `AGILE_SOCKET_PATH` for this session's hook bridge (`session.ts`'s own field of the same name) — round 2 B3: without it the rendered profile can't grant the daemon socket, and tier 1 silently breaks the moment tier 0 turns on. */
  socketPath?: string;
}

export type WrapAgentCommandFn = (input: WrapAgentCommandInput) => WrappedCommand;

export interface WrapAgentCommandDeps {
  detectBackendDeps?: DetectBackendDeps;
  /** Test seam for the `sandbox-exec` backend's temp profile write — defaults to a real `fs.writeFileSync` under `os.tmpdir()`. Returns the path written. */
  writeProfileFile?: (contents: string) => string;
  /** Test seam for round 2 B4's git-paths resolution — defaults to real `fs.readFileSync`. */
  gitPathsDeps?: GitPathsDeps;
  /** Test seam for round 2 B5's container `hostBinaryPath` resolution — defaults to a real `command -v` shell-out. Returns `undefined` when not found, never throws. */
  resolveHostBinaryPath?: (cmd: string) => string | undefined;
  /** Passed straight through to `buildContainerCommand` (image/containerHome overrides — round 2 B5). */
  containerOptions?: Omit<ContainerCommandOptions, 'hostBinaryPath'>;
}

function defaultWriteProfileFile(contents: string): string {
  const path = join(tmpdir(), `agile-sandbox-${process.pid}-${Date.now()}.sb`);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/** Best-effort `command -v <cmd>` on the daemon's own host — round 2 B5: `DEFAULT_SANDBOX_IMAGE` carries no vendor CLI, so mounting the host's own binary in is the documented workaround until a project supplies a purpose-built image. Never throws; a binary genuinely not found on this host just means no mount is added and `buildContainerCommand` falls back to relying on the image's own `$PATH` (round 2 B5's other, real fix: the caller can also pass `containerOptions.image`). */
function defaultResolveHostBinaryPath(cmd: string): string | undefined {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Thrown when a vendor that requires tier-0 gating is about to run with no
 * backend available. `runner.spawn` (out of this ticket's file ownership —
 * see the pipeline report's "wiring the manager needs to do") must catch
 * this and refuse the assignment rather than let it propagate into an
 * unsandboxed spawn.
 */
export class SandboxRequiredError extends Error {
  readonly vendor: string;
  readonly role: PermissionRole;
  constructor(vendor: string, role: PermissionRole) {
    super(
      `sandbox required: vendor '${vendor}' has ungated exec and no tier-0 backend is available on this host (detectBackend() -> 'none'); refusing to run '${role}' unsandboxed (design §6, fail-closed).`,
    );
    this.name = 'SandboxRequiredError';
    this.vendor = vendor;
    this.role = role;
  }
}

function passthrough(input: WrapAgentCommandInput): WrappedCommand {
  return { backend: 'none', command: input.command, args: [...input.args], envOverrides: {} };
}

/**
 * Builds this call's `SandboxProfile`, detects the backend, and returns the
 * wrapped command — or throws `SandboxRequiredError` (fail-closed) when
 * `requiresSandbox` is set and no backend is available.
 *
 * Wrapping itself only happens when `requiresSandbox` or `enabled` is set
 * (round 2 B2 — see this file's header); otherwise the command passes
 * through unchanged regardless of what `detectBackend()` reports, which is
 * what keeps an existing Claude/Pi session's behaviour unchanged on a Mac
 * that happens to have `sandbox-exec` on `$PATH`.
 */
export function wrapAgentCommand(
  input: WrapAgentCommandInput,
  deps: WrapAgentCommandDeps = {},
): WrappedCommand {
  const backend = detectBackend(deps.detectBackendDeps ?? defaultDetectBackendDeps);

  if (input.requiresSandbox && backend === 'none') {
    throw new SandboxRequiredError(input.vendor, input.role);
  }

  const shouldWrap =
    backend !== 'none' && (input.requiresSandbox === true || input.enabled === true);
  if (!shouldWrap) {
    return passthrough(input);
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

  // container
  const resolveHostBinaryPath = deps.resolveHostBinaryPath ?? defaultResolveHostBinaryPath;
  const hostBinaryPath = resolveHostBinaryPath(input.command);
  const wrapped = buildContainerCommand(profile, input.command, input.args, {
    ...deps.containerOptions,
    ...(hostBinaryPath ? { hostBinaryPath } : {}),
  });
  return { backend, command: wrapped.command, args: wrapped.args, envOverrides: {} };
}
