/**
 * Minimal real `state.*` RPC methods, wired into rpc.ts's method table
 * (T005 scope note: "wire real state.* RPC methods minimally only if
 * trivial ... otherwise leave stubs"). Only the two simplest read paths are
 * wired here — everything else under the `state.*` namespace still falls
 * through to T004's "not implemented yet" stub in rpc.ts until a later
 * ticket needs it wired for real (bus/hook/gate work, mutation endpoints
 * with proper param validation, etc.).
 */

import type { TicketId } from '@agile-agents/shared';
import { type RpcMethodHandler, RpcParamError } from '../rpc';
import type { StateStore } from './store';

/**
 * T136 (QA rough edge 1): `agile repo add <path>` used to accept any
 * existing directory and only fail much later, when a stream tried to cut a
 * branch in it. The registry's whole purpose is "a repo a stream can work
 * in", so the check belongs at this edge: a non-repository is the caller's
 * bad input, i.e. -32602 with the path in the message, not an internal
 * fault three tickets downstream.
 */
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
    // T111 — the repo registry (`repos.yaml` in the state home). One daemon,
    // many repos (D9); `agile repo add|list` is the only client today.
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
    'state.ticket_get': (params) => {
      const { id } = params as { id: string };
      return store.getTicket(id as TicketId);
    },
    'state.ticket_list': () => store.listTickets(),
  };
}
