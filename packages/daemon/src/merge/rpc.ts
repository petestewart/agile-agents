/**
 * `merge.*` RPC methods over a `MergeOwner` (T019 — design/agile-agents-
 * design.md §18 "JSON-RPC over unix socket for hooks/adapters"). Not wired
 * into `rpc.ts`'s method table by this ticket (`rpc.ts` is out of this
 * ticket's file ownership) — `daemon.ts` should pass this object as part of
 * `RpcServerOptions.extraMethods` alongside the other `build*RpcMethods`
 * tables; see the pipeline report's wiring instructions for the manager.
 *
 * Param validation follows `gates/rpc.ts`'s pattern (T018 review fix):
 * every handler validates its params at the boundary with a shared zod
 * schema and throws a typed `RpcParamError` (-32602) rather than letting a
 * bare destructuring `TypeError` reach `dispatch()`. `RpcError`/
 * `RpcParamError` themselves are re-exported from the root `rpc.ts` (T019
 * review round 1 nit — that file granted an additive-only export for this;
 * `gates/rpc.ts` predates it and keeps its own identical copy, out of this
 * ticket's file ownership to change) rather than a second definition here.
 * Same KNOWN LIMITATION `rpc.ts`'s own doc comment on these classes names:
 * `dispatch()`'s catch-all currently reports every thrown error as
 * `-32603` regardless of `.code` — `.code`/`.data` are still attached here
 * for the moment that's fixed.
 *
 * `onTicketDone`'s own status guard (`TicketNotReadyForMergeError`, see
 * `owner.ts`) is what actually keeps `merge.ticket` from running on a
 * ticket that isn't `done`/`stale` — enforced once, in the owner, so a
 * direct (non-RPC) caller gets the same guarantee this RPC method does.
 */

import { TicketIdSchema } from '@agile-agents/shared';
import type { TicketId } from '@agile-agents/shared';
import { RpcParamError } from '../rpc';
import type { RpcMethodHandler } from '../rpc';
import type { MergeOwner } from './owner';

export { RpcError, RpcParamError } from '../rpc';

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  return params as Record<string, unknown>;
}

function requireTicketId(value: unknown): TicketId {
  const result = TicketIdSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "ticket": must look like TKT-0231', { ticket: value });
  }
  return result.data;
}

export function buildMergeRpcMethods(owner: MergeOwner): Record<string, RpcMethodHandler> {
  return {
    'merge.ticket': (params) => {
      const p = requireObject(params);
      const ticket = requireTicketId(p.ticket);
      return owner.onTicketDone(ticket);
    },
    'merge.integration_to_main': () => owner.mergeIntegrationToMain(),
    'merge.status': (params) => {
      const p = requireObject(params);
      const ticket = requireTicketId(p.ticket);
      return owner.status(ticket) ?? null;
    },
  };
}
