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
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from './store';

export function buildStateRpcMethods(store: StateStore): Record<string, RpcMethodHandler> {
  return {
    // T111 — the repo registry (`repos.yaml` in the state home). One daemon,
    // many repos (D9); `agile repo add|list` is the only client today.
    'state.repo_list': () => store.getRepos(),
    'state.repo_add': async (params) => {
      const { name, ...entry } = params as { name?: string } & Record<string, unknown>;
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('state.repo_add: name is required');
      }
      return store.addRepo(name, entry);
    },
    'state.ticket_get': (params) => {
      const { id } = params as { id: string };
      return store.getTicket(id as TicketId);
    },
    'state.ticket_list': () => store.listTickets(),
  };
}
