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
 */

import type { SandboxProfile } from './types';

export interface ContainerCommand {
  command: 'docker';
  args: string[];
}

/** Default image: a plain Debian base with common toolchains a vendor CLI + its build tools need (node/bun/git). Overridable so a project can pin its own. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm';

export interface ContainerCommandOptions {
  /** Overrides `DEFAULT_SANDBOX_IMAGE`. */
  image?: string;
  /** Extra env vars to pass through (e.g. `ANTHROPIC_API_KEY`) — values are the caller's responsibility; this function only forwards names via `-e NAME`, it never inlines a secret value into the argv. */
  envPassthroughNames?: readonly string[];
}

export function buildContainerCommand(
  profile: SandboxProfile,
  cmd: string,
  args: readonly string[],
  opts: ContainerCommandOptions = {},
): ContainerCommand {
  const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
  const dockerArgs: string[] = ['run', '--rm', '-i'];

  dockerArgs.push('-w', profile.worktreePath);
  dockerArgs.push(
    '-v',
    `${profile.worktreePath}:${profile.worktreePath}:${profile.worktreeWritable ? 'rw' : 'ro'}`,
  );

  for (const loginPath of profile.loginPaths) {
    dockerArgs.push('-v', `${loginPath}:${loginPath}:rw`);
  }

  for (const name of opts.envPassthroughNames ?? profile.loginEnvPassthrough) {
    dockerArgs.push('-e', name);
  }

  // §14 "Network" column: no candidate profile needs unrestricted network,
  // so the only two postures a `docker run` can express directly are "none"
  // (reviewer/QA) and "bridge" (engineer — allow-listing narrows further
  // than Docker's own primitives support, see file header).
  dockerArgs.push('--network', profile.network === 'none' ? 'none' : 'bridge');

  dockerArgs.push(image, cmd, ...args);

  return { command: 'docker', args: dockerArgs };
}
