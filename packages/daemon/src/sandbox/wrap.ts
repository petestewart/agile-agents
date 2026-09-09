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
 *
 * Round 3 (QA round 2): `enabled` fails closed too. An earlier version of
 * this fix let `enabled: true` on a `'none'` host quietly pass through
 * unwrapped, on the theory that only `requiresSandbox` is a *hard*
 * requirement — but an explicit opt-in is still a request for sandboxing,
 * and silently ignoring it is exactly the "looks protected, isn't"
 * failure mode tier 0 exists to avoid. Passthrough is now reserved solely
 * for the case where *neither* flag is set.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRole } from '../permissions';
import {
  type DetectBackendDeps,
  defaultDetectBackendDeps,
  detectBackend,
  dockerProbeEnv,
} from './backend';
import {
  type ContainerCommandOptions,
  DEFAULT_SANDBOX_IMAGE,
  buildContainerCommand,
} from './container';
import { type GitPathsDeps, resolveWorktreeGitPaths } from './git-paths';
import { buildSandboxProfile } from './profile';
import { buildSandboxExecCommand, renderSandboxExecProfile } from './sandbox-exec';
import type { WrappedCommand } from './types';

/**
 * T031: `role` grew a fourth member (`'architect'`) — every check below
 * that isn't `role === 'engineer'` already treats "not engineer" as
 * "read-only, no network" (`buildSandboxProfile`, `backendInsufficientFor
 * RequiredSandbox`), which is exactly §14's Architect row too, so nothing
 * in this module needed a new branch for it.
 */
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
  /**
   * Round 2 B5's container `hostBinaryPath` resolution seam — **no default**
   * as of round 3 (review round 2 B7): auto-resolving and mounting the
   * daemon host's own vendor binary used to fire unconditionally, which
   * silently shadowed a purpose-built `containerOptions.image`'s own CLI
   * (a Mac-built binary mounted over a Linux image's correct one ->
   * `exec format error`). Pass this explicitly — e.g.
   * `defaultResolveHostBinaryPath` exported below — only when you know the
   * configured image (or the default one) has no vendor CLI of its own.
   * Ignored entirely whenever `containerOptions.image` names anything other
   * than `DEFAULT_SANDBOX_IMAGE`, regardless of whether this is set, so a
   * deliberately-chosen custom image is never overridden by habit.
   */
  resolveHostBinaryPath?: (cmd: string) => string | undefined;
  /** Passed straight through to `buildContainerCommand` (image/containerHome overrides — round 2 B5). */
  containerOptions?: Omit<ContainerCommandOptions, 'hostBinaryPath'>;
}

function defaultWriteProfileFile(contents: string): string {
  const path = join(tmpdir(), `agile-sandbox-${process.pid}-${Date.now()}.sb`);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/**
 * Best-effort `command -v <cmd>` on the daemon's own host — round 2 B5:
 * `DEFAULT_SANDBOX_IMAGE` carries no vendor CLI, so mounting the host's own
 * binary in is the documented workaround until a project supplies a
 * purpose-built image. Never throws; a binary genuinely not found on this
 * host just means no mount is added and `buildContainerCommand` falls back
 * to relying on the image's own `$PATH`. Exported (round 3, review round 2
 * B7) rather than wired in as `wrapAgentCommand`'s default — a caller opts
 * into this explicitly, deliberately, when it knows the image in play has
 * no CLI of its own; see `WrapAgentCommandDeps.resolveHostBinaryPath`'s doc
 * comment for why automatic was the bug.
 */
export function defaultResolveHostBinaryPath(cmd: string): string | undefined {
  // No repo root reaches this seam (see `WrapAgentCommandDeps.resolveHostBinaryPath`'s
  // doc comment — a caller opts in explicitly, with no `repoRoot` of its
  // own to pass), so this falls back to a fresh per-call `mkdtempSync`,
  // same shape as `dockerProbeEnv`'s own no-repo-root case.
  const probe = dockerProbeEnv(undefined);
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: probe.env,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  } finally {
    probe.cleanup();
  }
}

/**
 * Thrown when tier-0 gating was requested — either `requiresSandbox`
 * (mandatory, because the vendor has ungated exec) or an explicit `enabled`
 * opt-in (round 3, QA round 2: "an explicit `enabled` opt-in is a
 * sandboxing request and must fail closed exactly like `requiresSandbox`")
 * — and no *sufficient* backend is available. `runner.spawn` (out of this
 * ticket's file ownership — see the pipeline report's "wiring the manager
 * needs to do") must catch this and refuse the assignment rather than let
 * it propagate into an unsandboxed (or under-sandboxed) spawn.
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
 * Round 3 (review round 2 nit — container backend's `--network bridge` does
 * not meet AC2 "an engineer session cannot reach example.com"): Docker has
 * no per-host egress-filtering primitive (`container.ts`'s own file header),
 * so the container backend can enforce "no network" (reviewer/QA, already
 * `network: 'none'`) but not "these registries only" (engineer,
 * `network: 'allowlist'`). A `requiresSandbox` vendor as an **engineer**
 * therefore treats `'container'` the same as `'none'` — insufficient,
 * fail-closed — while reviewer/QA under `'container'` are unaffected (their
 * posture is fully enforceable there). A real per-host allow-list under
 * this backend needs an egress proxy or iptables sidecar the daemon would
 * own outside a single `docker run` — out of this ticket's scope, proposed
 * as a follow-up in the pipeline report rather than attempted here.
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
 * Builds this call's `SandboxProfile`, detects the backend, and returns the
 * wrapped command — or throws `SandboxRequiredError` (fail-closed) when
 * sandboxing was requested (`requiresSandbox` **or** `enabled` — round 3,
 * QA round 2: an explicit `enabled` opt-in is a request too, not a wish)
 * and no backend is available, or (for `requiresSandbox` specifically) the
 * only available backend can't actually cover the role's posture (`container`
 * for an engineer — see `backendInsufficientForRequiredSandbox`).
 *
 * Wrapping itself only happens when `requiresSandbox` or `enabled` is set
 * (round 2 B2 — see this file's header); with *neither* set the command
 * passes through unchanged regardless of what `detectBackend()` reports
 * (that case is handled before `detectBackend()` is even called), which is
 * what keeps an existing Claude/Pi session's behaviour unchanged on a Mac
 * that happens to have `sandbox-exec` on `$PATH`. Once either flag is set,
 * though, passthrough is no longer an option — a `'none'` backend fails
 * closed exactly the same way for both.
 */
export function wrapAgentCommand(
  input: WrapAgentCommandInput,
  deps: WrapAgentCommandDeps = {},
): WrappedCommand {
  // Round 3 (review round 2 nit): neither `requiresSandbox` nor `enabled`
  // set means the outcome is passthrough no matter what `detectBackend()`
  // would say, so skip probing for a backend at all on this path — the
  // common case for every existing Claude/Pi session today. Previously
  // this shelled out (`command -v sandbox-exec`, `docker info` with a 5s
  // timeout) on the daemon's event loop for every single spawn, wrapped or
  // not.
  if (!input.requiresSandbox && !input.enabled) {
    return passthrough(input);
  }

  const backend = detectBackend(deps.detectBackendDeps ?? defaultDetectBackendDeps);

  if (backend === 'none') {
    // Round 3 (QA round 2): reaching here means `requiresSandbox` or
    // `enabled` was set — either way, sandboxing was explicitly requested,
    // so a missing backend must fail closed, not quietly pass through.
    // Only the fully-unset case (handled above, before `detectBackend()`
    // even runs) is allowed to pass through unchanged.
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

  // container — round 3 B7: only ever consult `resolveHostBinaryPath` when
  // it was explicitly given *and* the image in play is the known-CLI-less
  // default (or unset, which resolves to that same default in
  // `buildContainerCommand`). Any other configured image is assumed to
  // carry its own CLI and must never have the host's binary mounted over
  // it, no matter what `resolveHostBinaryPath` was passed.
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
