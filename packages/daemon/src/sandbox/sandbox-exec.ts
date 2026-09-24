/**
 * The macOS `sandbox-exec` backend: renders the SBPL profile and wraps the
 * command. Unverified on a real Mac: the functions are pure and tested
 * for shape, not for what the kernel enforces. SBPL has no "resolve this
 * hostname" primitive; the literal `(remote tcp "host:*")` form mirrors
 * Apple's shipped profiles but needs live confirmation.
 *
 * The daemon socket (tier 1's hook bridge) and the engineer's shared-git
 * write paths are granted whatever the other postures say: without them
 * tier 0 would silently break the hooks and every commit.
 */

import { join } from 'node:path';
import type { SandboxProfile } from './types';

/** Renders the `.sb` text. Default-deny, so every capability below is additive. */
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
    // A worktree's `.git` points at `<repo>/.git/worktrees/<name>`; a commit
    // also writes objects, refs and the branch reflog (`logs/refs/heads/…`,
    // which lives in the common dir; missing it fails the commit with exit
    // 128) in the shared `<repo>/.git`. Read access is already global.
    // Only engineer profiles carry `gitPaths`.
    lines.push(
      '',
      "; engineer: shared git dir — commit needs to write new objects/refs/reflog, and this worktree's own HEAD/index/logs",
      `(allow file-write* (subpath "${escapeSbplString(profile.gitPaths.worktreeGitDir)}"))`,
      `(allow file-write* (subpath "${escapeSbplString(join(profile.gitPaths.commonGitDir, 'objects'))}"))`,
      `(allow file-write* (subpath "${escapeSbplString(join(profile.gitPaths.commonGitDir, 'refs'))}"))`,
      `(allow file-write* (subpath "${escapeSbplString(join(profile.gitPaths.commonGitDir, 'logs'))}"))`,
    );
  }

  if (profile.socketPath) {
    // The daemon socket, for every role: tier 1's bridge, not §14 network.
    // SBPL's exact predicate for an AF_UNIX connect is unconfirmed, so both
    // the file and the network form are granted.
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
    // DNS goes through mDNSResponder (the `mach-lookup` allow), never to
    // the target host, so no port-53 rule.
  } else {
    lines.push('', `; ${profile.role}: no network (§14) — no network-outbound allow rule`);
  }

  return `${lines.join('\n')}\n`;
}

/** Escapes `"` and `\` in an SBPL string literal. */
function escapeSbplString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface SandboxExecCommand {
  command: 'sandbox-exec';
  args: string[];
  profileText: string;
}

/** Wraps `cmd`/`args` to run under a profile the caller already wrote to disk. */
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
