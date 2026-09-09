/**
 * macOS `sandbox-exec` backend (T026 — ticket scope: "a macOS `sandbox-exec`
 * backend that emits the profile and wraps the command"; design §6 tier 0
 * row: "read-only mounts, no-network ... `sandbox-exec` profile").
 *
 * **Unverified on real macOS** (this container has no `sandbox-exec` — see
 * `backend.ts`'s header and the pipeline report): `renderSandboxExecProfile`
 * and `buildSandboxExecCommand` are pure functions, unit-tested for the
 * *shape* they produce, not for what the kernel actually enforces when fed
 * to the real `sandbox-exec` binary. SBPL (Apple's SandboxProfileLanguage)
 * has no first-class "resolve this hostname and allow only its IPs"
 * primitive; the literal-hostname `(remote tcp "host:*")` form used below
 * mirrors the syntax Apple's own shipped system profiles use (e.g.
 * `*.apple.com` filters in `/usr/share/sandbox/*.sb` on released macOS
 * versions), but neither this worker nor this container can confirm the
 * kernel actually resolves and enforces it that way — flagged for live
 * verification alongside the ticket's own "Live tests per role" validation
 * step, on a real Mac.
 */

import type { SandboxProfile } from './types';

/**
 * Renders the `.sb` profile text for one `SandboxProfile`. Default-deny
 * (`(deny default)`), so every capability below is additive — nothing here
 * needs a matching explicit `deny` line.
 */
export function renderSandboxExecProfile(profile: SandboxProfile): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '; T026 tier-0 profile — see packages/daemon/src/sandbox/sandbox-exec.ts',
    `; role: ${profile.role}`,
    '',
    '; --- process basics every vendor CLI needs to run at all ---',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target self))',
    '(allow mach-lookup)',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '',
    '; --- filesystem: read-only mount everywhere by default (§6/§14) ---',
    '(allow file-read*)',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/folders"))',
  ];

  if (profile.worktreeWritable) {
    lines.push('', '; engineer: write access to its own worktree only');
    lines.push(`(allow file-write* (subpath "${escapeSbplString(profile.worktreePath)}"))`);
  } else {
    lines.push('', `; ${profile.role}: no write access to the checkout (§14)`);
  }

  if (profile.loginPaths.length > 0) {
    lines.push('', '; vendor login state — must stay usable inside the sandbox');
    for (const p of profile.loginPaths) {
      lines.push(`(allow file-read* file-write* (subpath "${escapeSbplString(p)}"))`);
    }
  }

  if (profile.network === 'allowlist' && profile.allowedHosts.length > 0) {
    lines.push('', '; engineer: package registries only (§14 "Network" column)');
    for (const host of profile.allowedHosts) {
      lines.push(`(allow network-outbound (remote tcp "${escapeSbplString(host)}:*"))`);
      // DNS itself must resolve before the hostname filter above can match
      // anything — without this every allow-listed host is unreachable.
      lines.push(`(allow network-outbound (remote udp "${escapeSbplString(host)}:53"))`);
    }
  } else {
    lines.push('', `; ${profile.role}: no network (§14) — no network-outbound allow rule`);
  }

  return `${lines.join('\n')}\n`;
}

/** SBPL string literals are double-quoted with `\`-escapes for `"` and `\`; paths here are always absolute filesystem/hostnames, never user-controlled shell syntax, but this keeps a stray `"` from breaking the profile. */
function escapeSbplString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface SandboxExecCommand {
  command: 'sandbox-exec';
  args: string[];
  profileText: string;
}

/**
 * Wraps `cmd`/`args` to run under the rendered profile. Pure: takes the
 * profile *path* the caller already wrote to disk (writing a temp file is
 * the caller's IO seam — kept out of this module so `renderSandboxExecProfile`
 * and this function both stay trivially unit-testable).
 */
export function buildSandboxExecCommand(
  profilePath: string,
  cmd: string,
  args: readonly string[],
  profileText: string,
): SandboxExecCommand {
  return {
    command: 'sandbox-exec',
    args: ['-f', profilePath, '--', cmd, ...args],
    profileText,
  };
}
