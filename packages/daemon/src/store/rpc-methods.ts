/** The `state.*` RPC: the repo registry (`repos.yaml`, D9), used by `agile repo add|list`. */

import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from './store';

/** A repo a stream can't cut a branch in is caller input: -32602 at add time, not a fault later. */
function assertGitRepository(path: string): void {
  const probe = Bun.spawnSync(['git', 'rev-parse', '--git-dir'], {
    cwd: path,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (probe.exitCode !== 0) {
    throw new RpcParamError(`state.repo_add: ${path} is not a git repository`);
  }
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
      assertGitRepository(path);
      return store.addRepo(name, entry);
    },
  };
}
