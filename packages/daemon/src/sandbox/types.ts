/**
 * Tier-0 sandbox types (agile-agents-design §6, §14). Tier 0 is the floor:
 * it can hard-deny a syscall but never explain why, so it sits under the
 * tiers that carry a reason back to the model. Pure data; nothing here
 * spawns a process.
 */

import type { PermissionRole } from '../permissions';

/** The backend that wrapped the command; `'none'` is an honest answer, never a silent no-op. */
export const SANDBOX_BACKENDS = ['sandbox-exec', 'container', 'none'] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

/** One read/write/network posture from role + worktree, independent of the backend. */
export interface SandboxProfile {
  role: PermissionRole;
  /** The worktree: the one directory besides login paths this profile may grant write into. */
  worktreePath: string;
  /** §14: an engineer writes its own worktree; every other role is read-only. */
  worktreeWritable: boolean;
  /** §14's network column: engineer gets package registries only, reviewer none. */
  network: 'none' | 'allowlist';
  /** Hostnames reachable when `network === 'allowlist'`. Ignored when `network === 'none'`. */
  allowedHosts: readonly string[];
  /**
   * Read-write regardless of `worktreeWritable`, so vendor CLIs keep their
   * login state (and can refresh tokens). Best-effort; see
   * `VENDOR_LOGIN_PATHS`.
   */
  loginPaths: readonly string[];
  /** Env var names preserved for auth (e.g. `ANTHROPIC_API_KEY`); names only, never values. */
  loginEnvPassthrough: readonly string[];
  /**
   * The host home `loginPaths` were resolved against, plus the relative
   * fragments, so the container backend can re-home them under its own
   * `$HOME` (a host path like `/Users/pete/.claude` is inert under `/root`).
   */
  homeDir: string;
  loginRelPaths: readonly string[];
  /**
   * The daemon socket (`AGILE_SOCKET_PATH`), granted for every role
   * whatever `network` says: without it tier 0 silently kills the tier-1
   * hook bridge. `undefined` when the caller has none (then the bridge
   * isn't guaranteed).
   */
  socketPath?: string;
  /**
   * Git paths an engineer must write to commit at all: a worktree's `.git`
   * points at `<repo>/.git/worktrees/<name>`, and objects/refs live in the
   * shared `<repo>/.git`. Ignored for read-only roles, and absent when
   * resolution fails (a real `.git` directory, not a gitfile).
   */
  gitPaths?: { worktreeGitDir: string; commonGitDir: string };
}

export interface SandboxProfileOptions {
  role: PermissionRole;
  worktreePath: string;
  vendor: string;
  /** Extra hosts on top of `DEFAULT_REGISTRY_ALLOWLIST`. */
  extraAllowedHosts?: readonly string[];
  /** Test seam; defaults to `os.homedir()`. */
  homeDir?: string;
  /** See `SandboxProfile.socketPath`. */
  socketPath?: string;
  /** See `SandboxProfile.gitPaths`. Only applied when `role === 'engineer'`. */
  gitPaths?: { worktreeGitDir: string; commonGitDir: string };
}

/** A command after tier-0 wrapping. Still just data. */
export interface WrappedCommand {
  backend: SandboxBackend;
  command: string;
  args: string[];
  /** Merged over the caller's env, never a full replacement. */
  envOverrides: Readonly<Record<string, string>>;
  /** `sandbox-exec` only: the rendered `.sb` profile text. */
  profileText?: string;
}
