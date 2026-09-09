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
 *
 * Round 2 (review round 1 B3/B4): the daemon's Unix-domain socket
 * (`AGILE_SOCKET_PATH`, tier 1's hook bridge — `hook/settings.ts`) and the
 * engineer's shared-git write paths (`git-paths.ts`) are granted here too,
 * for every role and independent of the `network`/`worktreeWritable`
 * postures above — without them, turning on tier 0 silently breaks tier 1
 * (every hook fails open) and an engineer can never produce a commit.
 */

import { join } from 'node:path';
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
    '(allow file-ioctl)',
    '(allow signal (target children))',
    '(allow process-info* (target self))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
    '(allow file-read* file-write-data file-ioctl (literal "/dev/tty"))',
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

  if (profile.role === 'engineer' && profile.gitPaths) {
    // Round 2 B4: a worktree's `.git` is a gitfile pointing at
    // `<repo>/.git/worktrees/<name>` (this worktree's own HEAD/index/logs);
    // `git commit` also needs to write new objects/refs into the *shared*
    // `<repo>/.git`. `(allow file-read*)` above already covers reading the
    // rest of it (rules, other branches) — only these two subpaths need
    // write. Reviewer/QA never reach this branch (`gitPaths` is only ever
    // set on an engineer profile — see `profile.ts`), so they stay
    // read-only across all of `<repo>/.git` as §14 requires.
    lines.push(
      '',
      "; engineer: shared git dir — commit needs to write new objects/refs, and this worktree's own HEAD/index/logs",
      `(allow file-write* (subpath "${escapeSbplString(profile.gitPaths.worktreeGitDir)}"))`,
      `(allow file-write* (subpath "${escapeSbplString(join(profile.gitPaths.commonGitDir, 'objects'))}"))`,
      `(allow file-write* (subpath "${escapeSbplString(join(profile.gitPaths.commonGitDir, 'refs'))}"))`,
    );
  }

  if (profile.socketPath) {
    // Round 2 B3: the daemon's Unix-domain socket, for every role — this is
    // tier 1's own bridge (`agile hook ...` -> the daemon), not a role's
    // §14 "Network" posture. Both a `network-outbound` and a plain
    // file-read/write form are granted: SBPL's exact predicate for an
    // AF_UNIX `connect(2)` isn't independently confirmed on this container
    // (same unverified-on-real-macOS caveat as the hostname rules below),
    // so this errs toward "definitely covers it" rather than guessing one
    // form and silently breaking the hook bridge again.
    lines.push(
      '',
      '; daemon socket bridge (tier 1) — must work regardless of role/network posture',
      `(allow file-read* file-write* (literal "${escapeSbplString(profile.socketPath)}"))`,
      `(allow network* (literal "${escapeSbplString(profile.socketPath)}"))`,
    );
  }

  if (profile.network === 'allowlist' && profile.allowedHosts.length > 0) {
    lines.push('', '; engineer: package registries only (§14 "Network" column)');
    for (const host of profile.allowedHosts) {
      lines.push(`(allow network-outbound (remote tcp "${escapeSbplString(host)}:*"))`);
    }
    // DNS resolution itself happens out-of-process via mDNSResponder on
    // macOS (covered by the `mach-lookup` allow above, not a `network*`
    // rule against the target host — round 2 nit fix: the earlier
    // `(remote udp "<host>:53")` form was a category error, since port 53
    // traffic goes to the *resolver's* address, never the target host).
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
