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
 * bare destructuring `TypeError` reach `dispatch()`. Same KNOWN LIMITATION
 * as `gates/rpc.ts` documents: `dispatch()`'s catch-all currently reports
 * every thrown error as `-32603` regardless of `.code` — `.code`/`.data`
 * are still attached here for the moment that's fixed.
 */

import { TicketIdSchema } from '@agile-agents/shared';
import type { TicketId } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { MergeOwner } from './owner';

const INVALID_PARAMS_CODE = -32602;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcParamError extends RpcError {
  constructor(message: string, data?: unknown) {
    super(INVALID_PARAMS_CODE, message, data);
    this.name = 'RpcParamError';
  }
}

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
