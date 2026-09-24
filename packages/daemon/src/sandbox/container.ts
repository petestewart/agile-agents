/**
 * The container backend: renders a `docker run` argv from a
 * `SandboxProfile` (pure; running it needs a live docker daemon). The
 * worktree is mounted rw or ro per `worktreeWritable`, login paths rw and
 * re-homed under the container's `$HOME`, the daemon socket and `AGILE_*`
 * env passed through so tier 1 still works. Network is `none` or `bridge`:
 * Docker can't allow-list hostnames, so `allowlist` here means reachable,
 * not restricted (which is why `wrap.ts` refuses it for an engineer who
 * requires a sandbox).
 */

import { join } from 'node:path';
import type { SandboxProfile } from './types';

export interface ContainerCommand {
  command: 'docker';
  args: string[];
}

/**
 * Placeholder base image with no vendor CLI of its own (`docker run
 * node:22-bookworm claude` fails). A real deployment passes an `image`
 * with the CLI baked in, or `hostBinaryPath`.
 */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm';

/** Default `$HOME` inside the container login paths are re-homed under. */
export const DEFAULT_CONTAINER_HOME = '/root';

/** Env names always forwarded by name (`-e NAME` reads them from the `docker` process's env). */
const ALWAYS_ENV_NAMES = ['AGILE_AGENT', 'AGILE_TICKET'] as const;

export interface ContainerCommandOptions {
  /** Overrides `DEFAULT_SANDBOX_IMAGE`. */
  image?: string;
  /** Extra env var names to forward. */
  extraEnvPassthroughNames?: readonly string[];
  /** Re-home login paths under this container `$HOME` instead of `DEFAULT_CONTAINER_HOME`. */
  containerHome?: string;
  /**
   * Host path to the vendor CLI, bind-mounted read-only at the same path
   * and exec'd instead of `cmd`. Best-effort: shared libraries or a
   * shebang interpreter the image lacks are not pulled in; a purpose-built
   * `image` is preferable.
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

  // The shared-git write access sandbox-exec grants, as mounts:
  // `commonGitDir` read-only, then the three subpaths a commit writes
  // (`objects`, `refs`, and the branch reflog under `logs`), then this
  // worktree's gitdir. Order matters: a later nested `-v` overrides.
  if (profile.role === 'engineer' && profile.gitPaths) {
    const { worktreeGitDir, commonGitDir } = profile.gitPaths;
    dockerArgs.push('-v', `${commonGitDir}:${commonGitDir}:ro`);
    dockerArgs.push('-v', `${join(commonGitDir, 'objects')}:${join(commonGitDir, 'objects')}:rw`);
    dockerArgs.push('-v', `${join(commonGitDir, 'refs')}:${join(commonGitDir, 'refs')}:rw`);
    dockerArgs.push('-v', `${join(commonGitDir, 'logs')}:${join(commonGitDir, 'logs')}:rw`);
    dockerArgs.push('-v', `${worktreeGitDir}:${worktreeGitDir}:rw`);
  }

  // Re-home under the container's own $HOME.
  for (const rel of profile.loginRelPaths) {
    dockerArgs.push('-v', `${join(profile.homeDir, rel)}:${join(containerHome, rel)}:rw`);
  }
  dockerArgs.push('-e', `HOME=${containerHome}`);

  // The daemon socket, at the same path the agent is told verbatim.
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

  // §14: `none` (reviewer) or `bridge` (engineer; see file header).
  dockerArgs.push('--network', profile.network === 'none' ? 'none' : 'bridge');

  if (opts.hostBinaryPath) {
    dockerArgs.push('-v', `${opts.hostBinaryPath}:${opts.hostBinaryPath}:ro`);
  }
  const execCmd = opts.hostBinaryPath ?? cmd;
  dockerArgs.push(image, execCmd, ...args);

  return { command: 'docker', args: dockerArgs };
}
