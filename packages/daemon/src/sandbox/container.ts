/**
 * Container backend fallback (T026 — ticket scope: "a container backend
 * fallback"). Renders a `docker run` argv from a `SandboxProfile`; pure —
 * building the argv never touches a real container runtime, so it's
 * unit-tested on any platform. Only actually *running* it needs a live
 * daemon, gated behind `AGILE_LIVE=1` per the ticket (this container's own
 * `docker info` fails — see `backend.ts` — so that live test is skipped
 * here and left for a machine with a running daemon).
 *
 * Design choice: bind-mount the worktree read-write or read-only per
 * `worktreeWritable`, mount each login path read-write so vendor auth
 * survives, and `--network none` unless the profile needs the registry
 * allow-list — Docker's own network drivers don't do hostname-level
 * allow-listing, so an `allowlist` profile here means "reachable" (bridge
 * network + normal DNS/egress), not "restricted to exactly these hosts";
 * true per-host filtering under this backend needs an egress proxy/firewall
 * rule the daemon would own outside a single `docker run` invocation —
 * documented as a v0 gap in the pipeline report, not silently claimed.
 *
 * Round 2 fixes (review round 1 B3/B5): the daemon socket and `AGILE_*`
 * env vars are threaded through so tier 1 still works inside a container,
 * login paths are re-homed under the *container's* `$HOME` (mounting a
 * host path like `/Users/pete/.claude` is inert if the image's `$HOME` is
 * `/root`), and the base image's total lack of a vendor CLI is addressed
 * with an explicit, documented escape hatch (`hostBinaryPath`) rather than
 * silently shipping an image that can never run one.
 */

import { join } from 'node:path';
import type { SandboxProfile } from './types';

export interface ContainerCommand {
  command: 'docker';
  args: string[];
}

/**
 * Placeholder base image — a plain Debian + Node.js base for the build
 * tooling a vendor CLI's own dependencies need, but it carries **no vendor
 * CLI of its own**: `docker run node:22-bookworm claude` fails with
 * "executable file not found in $PATH" (round 2 B5, confirmed by reading
 * the image's contents — this container has no daemon to actually run
 * it against). A real deployment must either pass `image` pointing at one
 * built with the vendor CLI baked in, or `hostBinaryPath` to bind-mount
 * the host's own binary in (best-effort — see that option's doc comment).
 */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm';

/** Default `$HOME` inside the container login paths are re-homed under. */
export const DEFAULT_CONTAINER_HOME = '/root';

/** Env names always forwarded (by name, via `-e NAME`) regardless of vendor — `session.ts` sets these as literal values on the `docker` process's own env, and `-e NAME` (no `=value`) tells docker to read them from there. */
const ALWAYS_ENV_NAMES = ['AGILE_AGENT', 'AGILE_TICKET'] as const;

export interface ContainerCommandOptions {
  /** Overrides `DEFAULT_SANDBOX_IMAGE`. */
  image?: string;
  /** Extra env var *names* to forward on top of `AGILE_AGENT`/`AGILE_TICKET`/`AGILE_SOCKET_PATH` (when a socket path is set) and the profile's own `loginEnvPassthrough`. */
  extraEnvPassthroughNames?: readonly string[];
  /** Re-home login paths under this container `$HOME` instead of `DEFAULT_CONTAINER_HOME`. */
  containerHome?: string;
  /**
   * Absolute **host** path to the vendor CLI binary. When set, it's
   * bind-mounted read-only into the container at the same path and used as
   * the exec target instead of `cmd` — the documented workaround for
   * `DEFAULT_SANDBOX_IMAGE` carrying no vendor CLI. Best-effort: a plain
   * binary mount does not pull in shared libraries or a shebang
   * interpreter the image itself lacks (e.g. a Python/Node script relying
   * on the host's runtime) — sufficient for a self-contained binary,
   * documented as incomplete otherwise. Whoever wires a real per-vendor
   * container image (T027) should prefer a purpose-built `image` over
   * this.
   */
  hostBinaryPath?: string;
}

export function buildContainerCommand(
  profile: SandboxProfile,
  cmd: string,
  args: readonly string[],
  opts: ContainerCommandOptions = {},
): ContainerCommand {
  const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
  const containerHome = opts.containerHome ?? DEFAULT_CONTAINER_HOME;
  const dockerArgs: string[] = ['run', '--rm', '-i'];

  dockerArgs.push('-w', profile.worktreePath);
  dockerArgs.push(
    '-v',
    `${profile.worktreePath}:${profile.worktreePath}:${profile.worktreeWritable ? 'rw' : 'ro'}`,
  );

  // Round 2 B4: same shared-git write access sandbox-exec grants, mounted
  // instead of allow-ruled. `commonGitDir` first (read-only — config,
  // hooks, the main checkout's own HEAD stay untouched), then the two
  // subpaths git commit actually writes, then this worktree's own gitdir —
  // mount order matters here: each later `-v` on a path nested under an
  // earlier one overrides that subtree.
  if (profile.role === 'engineer' && profile.gitPaths) {
    const { worktreeGitDir, commonGitDir } = profile.gitPaths;
    dockerArgs.push('-v', `${commonGitDir}:${commonGitDir}:ro`);
    dockerArgs.push('-v', `${join(commonGitDir, 'objects')}:${join(commonGitDir, 'objects')}:rw`);
    dockerArgs.push('-v', `${join(commonGitDir, 'refs')}:${join(commonGitDir, 'refs')}:rw`);
    dockerArgs.push('-v', `${worktreeGitDir}:${worktreeGitDir}:rw`);
  }

  // Round 2 B5: re-home under the container's own $HOME, not the host's.
  for (const rel of profile.loginRelPaths) {
    dockerArgs.push('-v', `${join(profile.homeDir, rel)}:${join(containerHome, rel)}:rw`);
  }
  dockerArgs.push('-e', `HOME=${containerHome}`);

  // Round 2 B3: the daemon socket, mounted at the same path it's addressed
  // by (AGILE_SOCKET_PATH is a host-absolute path the agent process is
  // told verbatim — keeping the in-container path identical means no
  // rewriting is needed anywhere else).
  if (profile.socketPath) {
    dockerArgs.push('-v', `${profile.socketPath}:${profile.socketPath}:rw`);
  }

  const envNames = new Set<string>(ALWAYS_ENV_NAMES);
  if (profile.socketPath) envNames.add('AGILE_SOCKET_PATH');
  for (const name of profile.loginEnvPassthrough) envNames.add(name);
  for (const name of opts.extraEnvPassthroughNames ?? []) envNames.add(name);
  for (const name of envNames) {
    dockerArgs.push('-e', name);
  }

  // §14 "Network" column: no candidate profile needs unrestricted network,
  // so the only two postures a `docker run` can express directly are "none"
  // (reviewer/QA) and "bridge" (engineer — allow-listing narrows further
  // than Docker's own primitives support, see file header).
  dockerArgs.push('--network', profile.network === 'none' ? 'none' : 'bridge');

  if (opts.hostBinaryPath) {
    dockerArgs.push('-v', `${opts.hostBinaryPath}:${opts.hostBinaryPath}:ro`);
  }
  const execCmd = opts.hostBinaryPath ?? cmd;
  dockerArgs.push(image, execCmd, ...args);

  return { command: 'docker', args: dockerArgs };
}
