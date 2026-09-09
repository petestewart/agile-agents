/**
 * Tier-0 sandbox types (T026 — design/agile-agents-design.md §6 "Enforcement
 * tiers": "0 · OS sandbox | read-only mounts, no-network, per-worktree
 * container / `sandbox-exec` profile | yes (hard) | no (tool errors) | fs +
 * network, vendor-neutral | all"; §14 "Permissions per role" for the
 * read/write/network matrix a profile renders).
 *
 * Tier 0 is the floor under every other tier: it can hard-deny (kill the
 * syscall) but never explains why (the agent just sees a tool error), which
 * is why §6 places it *under* tiers 1-3 rather than instead of them — those
 * carry the reason back to the model. This module only builds and wraps;
 * nothing here spawns a process.
 */

import type { PermissionRole } from '../permissions';

/** What tier-0 backend rendered/wrapped the command — `'none'` is a first-class, honest answer (ticket scope: "reports `none` honestly when neither works"), never a silent no-op. */
export const SANDBOX_BACKENDS = ['sandbox-exec', 'container', 'none'] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

/** One read/write/network posture, resolved from role + worktree — a pure data object, independent of which backend renders it. */
export interface SandboxProfile {
  role: PermissionRole;
  /** Absolute path to the ticket's worktree (or QA's fresh clone) — the one directory besides login paths this profile ever grants write into. */
  worktreePath: string;
  /** §14: engineer writes its own worktree; reviewer/QA get none beyond QA's own test files, which this v0 profile does not yet special-case (documented in the report). */
  worktreeWritable: boolean;
  /** §14 "Network" column: engineer gets package registries only; reviewer/architect/EM get none; QA gets its env base URL (out of this ticket's scope to plumb through — v0 leaves QA's `allowedHosts` at the registry allow-list too, see report). */
  network: 'none' | 'allowlist';
  /** Hostnames reachable when `network === 'allowlist'`. Ignored when `network === 'none'`. */
  allowedHosts: readonly string[];
  /**
   * Absolute paths that must stay read-write inside the sandbox regardless
   * of `worktreeWritable`, so vendor CLIs can read (and, where a vendor
   * refreshes tokens on use, write) their own login state — "vendor logins
   * must keep working inside the sandbox" (ticket scope). Best-effort list;
   * see `VENDOR_LOGIN_PATHS`'s doc comment for what is and isn't verified.
   */
  loginPaths: readonly string[];
  /** Env vars that must pass through unmodified for auth to keep working (e.g. `ANTHROPIC_API_KEY`) — not secrets rendered into the profile, just names to preserve. */
  loginEnvPassthrough: readonly string[];
}

export interface SandboxProfileOptions {
  role: PermissionRole;
  worktreePath: string;
  vendor: string;
  /** Extra hostnames allowed on top of `DEFAULT_REGISTRY_ALLOWLIST` (project-specific private registries etc). */
  extraAllowedHosts?: readonly string[];
  /** Override home-dir resolution for login-path rendering (test seam) — defaults to `os.homedir()`. */
  homeDir?: string;
}

/** A shell-ready command after tier-0 wrapping. Still just data — nothing here has spawned anything. */
export interface WrappedCommand {
  backend: SandboxBackend;
  command: string;
  args: string[];
  /** Env overrides to merge on top of the caller's own (login passthrough, container-specific vars). Never a full replacement — §6/§14 both assume the wrapped process still inherits its ambient env otherwise. */
  envOverrides: Readonly<Record<string, string>>;
  /** Present only for the `sandbox-exec` backend: the rendered `.sb` profile text the caller must write to disk before exec (kept out of this pure layer — see `sandbox-exec.ts`). */
  profileText?: string;
}
