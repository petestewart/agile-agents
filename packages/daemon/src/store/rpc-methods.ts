/** The `state.*` RPC: the repo registry (`repos.yaml`, D9), used by `agile repo add|list` and Settings → Repos (T206). */

import { realpathSync } from 'node:fs';
import type { RepoEntry } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from './store';

function gitOut(args: string[], cwd: string): string | undefined {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : undefined;
}

/**
 * A repo a stream can't cut a branch in is caller input: -32602 at add time,
 * not a fault later. The path must be the repo's toplevel, not a subdirectory.
 */
function assertGitToplevel(path: string): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new RpcParamError(`state.repo_add: ${path} does not exist`);
  }
  const top = gitOut(['rev-parse', '--show-toplevel'], real);
  if (top === undefined) throw new RpcParamError(`state.repo_add: ${path} is not a git repository`);
  if (realpathSync(top) !== real) {
    throw new RpcParamError(`state.repo_add: ${path} is not the repo's toplevel (that is ${top})`);
  }
}

/**
 * The branch a repo's work delivers to (projects-design §14.8 `main_branch`,
 * set by the T202 migration or later): `main_branch`, else `target_branch`, else the remote's
 * default branch, else `main`/`master` if present, else `main`.
 */
export function resolveMainBranch(entry: RepoEntry): string {
  if (entry.main_branch) return entry.main_branch;
  if (entry.target_branch) return entry.target_branch;
  const remote = gitOut(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], entry.path);
  if (remote) return remote.replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if (gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], entry.path) !== undefined)
      return b;
  }
  return 'main';
}

export function buildStateRpcMethods(store: StateStore): Record<string, RpcMethodHandler> {
  return {
    'state.repo_list': () => store.getRepos(),
    'state.repo_add': async (params) => {
      const { name, ...entry } = params as { name?: string } & Record<string, unknown>;
      if (typeof name !== 'string' || name.length === 0) {
        throw new RpcParamError('state.repo_add: name is required');
      }
      const { path } = entry as { path?: unknown };
      if (typeof path !== 'string' || path.length === 0) {
        throw new RpcParamError('state.repo_add: path is required');
      }
      assertGitToplevel(path);
      return store.addRepo(name, { ...entry, path: realpathSync(path) });
    },
  };
}
