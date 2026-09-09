/**
 * `qa.*` RPC methods over a `QaProtocol` (T017), same shape as
 * `bus/rpc-methods.ts`'s `buildBusRpcMethods`/`gates/rpc.ts`'s
 * `buildGateRpcMethods` — for wiring into `rpc.ts`'s `extraMethods` table.
 * Not wired into `daemon.ts` by this ticket (out of this ticket's file
 * ownership, see `.pipeline-report.md`): `daemon.ts` should splice
 * `...buildQaRpcMethods(qaProtocol)` into the same object literal that
 * already holds `...buildStateRpcMethods(store)`/`...buildBusRpcMethods(bus)`.
 */

import type { TicketId } from '@agile-agents/shared';
import { TicketIdSchema } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { QaProtocol } from './protocol';

const INVALID_PARAMS_CODE = -32602;

export class QaRpcParamError extends Error {
  readonly code = INVALID_PARAMS_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'QaRpcParamError';
  }
}

function requireTicketId(value: unknown): TicketId {
  const result = TicketIdSchema.safeParse(value);
  if (!result.success) {
    throw new QaRpcParamError('invalid "ticket": must look like TKT-0231');
  }
  return result.data;
}

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new QaRpcParamError('params must be an object');
  }
  return params as Record<string, unknown>;
}

export function buildQaRpcMethods(protocol: QaProtocol): Record<string, RpcMethodHandler> {
  return {
    'qa.status': (params) => {
      const p = requireObject(params);
      const ticket = requireTicketId(p.ticket);
      return protocol.status(ticket) ?? null;
    },
  };
}
