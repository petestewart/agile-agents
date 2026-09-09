/**
 * `wrapAgentCommand` — the one function `runner/session.ts` calls before
 * spawning an agent process (T026 ticket scope: "a small injectable seam in
 * `runner/session.ts` (how the agent process command is wrapped before
 * spawn)"). Combines `buildSandboxProfile` + `detectBackend` + the
 * per-backend renderer into one call, and is where the fail-closed routing
 * rule lives: "with backend `none` such a vendor must be refused for
 * routing, never silently run unsandboxed (fail-closed, same philosophy as
 * the hooks)".
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRole } from '../permissions';
import { type DetectBackendDeps, defaultDetectBackendDeps, detectBackend } from './backend';
import { buildContainerCommand } from './container';
import { buildSandboxProfile } from './profile';
import { buildSandboxExecCommand, renderSandboxExecProfile } from './sandbox-exec';
import type { SandboxBackend, WrappedCommand } from './types';

export interface WrapAgentCommandInput {
  role: PermissionRole;
  worktreePath: string;
  /** ACP provider id (`ACP_PROVIDERS` key) — `claude`, `openai`, `cursor`, `gemini`, `grok`, ... */
  vendor: string;
  command: string;
  args: readonly string[];
  /** From `VendorConfig.requires_sandbox` (`packages/shared/src/vendors.ts`) — `true` for vendors whose bridge has no gated exec (Codex, Grok per §6). Defaults `false` so a caller that hasn't loaded `vendors.yaml` yet (or a vendor the config omits) never accidentally trips the fail-closed refusal. */
  requiresSandbox?: boolean;
  extraAllowedHosts?: readonly string[];
}

export type WrapAgentCommandFn = (input: WrapAgentCommandInput) => WrappedCommand;

export interface WrapAgentCommandDeps {
  detectBackendDeps?: DetectBackendDeps;
  /** Test seam for the `sandbox-exec` backend's temp profile write — defaults to a real `fs.writeFileSync` under `os.tmpdir()`. Returns the path written. */
  writeProfileFile?: (contents: string) => string;
}

function defaultWriteProfileFile(contents: string): string {
  const path = join(tmpdir(), `agile-sandbox-${process.pid}-${Date.now()}.sb`);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
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

/**
 * Builds this call's `SandboxProfile`, detects the backend, and returns the
 * wrapped command — or throws `SandboxRequiredError` (fail-closed) when
 * `requiresSandbox` is set and no backend is available. When a backend
 * exists but `requiresSandbox` is false (the common Claude/Pi case today),
 * the vendor still runs inside whatever tier-0 backend is available; only
 * `backend === 'none'` for a `requiresSandbox` vendor is a hard refusal —
 * every other combination degrades gracefully (best available protection,
 * same as today with no tier 0 at all).
 */
export function wrapAgentCommand(
  input: WrapAgentCommandInput,
  deps: WrapAgentCommandDeps = {},
): WrappedCommand {
  const backend: SandboxBackend = detectBackend(deps.detectBackendDeps ?? defaultDetectBackendDeps);

  if (backend === 'none' && input.requiresSandbox) {
    throw new SandboxRequiredError(input.vendor, input.role);
  }

  if (backend === 'none') {
    // No tier-0 protection available and this vendor doesn't need it to be
    // routed safely (its own gating covers exec) — pass the command through
    // unchanged rather than fabricate a no-op wrapper.
    return { backend, command: input.command, args: [...input.args], envOverrides: {} };
  }

  const profile = buildSandboxProfile({
    role: input.role,
    worktreePath: input.worktreePath,
    vendor: input.vendor,
    extraAllowedHosts: input.extraAllowedHosts,
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
  const wrapped = buildContainerCommand(profile, input.command, input.args);
  return { backend, command: wrapped.command, args: wrapped.args, envOverrides: {} };
}
