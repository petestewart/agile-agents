/**
 * `gate.*` RPC methods over a `GateService` (design §18 "JSON-RPC over unix
 * socket for hooks/adapters"; T018 scope: "CLI `approve`/`delegate`/`breaker
 * clear`; implement these as daemon RPC methods `gate.approve`,
 * `gate.delegate`, `gate.breaker_clear` (+ `gate.list`, `gate.resolve`); the
 * CLI verbs land with T008, not here."
 *
 * Not wired into `rpc.ts`'s method table by this ticket (rpc.ts is out of
 * scope for T018 — see the pipeline report's wiring instructions for the
 * manager): `daemon.ts` should pass this object as part of
 * `RpcServerOptions.extraMethods` alongside `buildStateRpcMethods`.
 */

import type { RpcMethodHandler } from '../rpc';
import type { GateService } from './service';
import type { BreakerSignal } from './types';

interface ApproveParams {
  id: string;
  by: string;
}

interface ResolveParams {
  id: string;
  decision: 'approve' | 'deny';
  by: string;
}

interface DelegateParams {
  id: string;
  to: 'em' | 'architect';
}

interface BreakerClearParams {
  signal: BreakerSignal;
}

export function buildGateRpcMethods(service: GateService): Record<string, RpcMethodHandler> {
  return {
    'gate.list': () => service.list(),
    'gate.approve': (params) => {
      const { id, by } = params as ApproveParams;
      return service.respond(id, 'approve', by);
    },
    'gate.resolve': (params) => {
      const { id, decision, by } = params as ResolveParams;
      return service.respond(id, decision, by);
    },
    'gate.delegate': (params) => {
      const { id, to } = params as DelegateParams;
      return service.delegateRequest(id, to);
    },
    'gate.breaker_clear': (params) => {
      const { signal } = params as BreakerClearParams;
      return service.clear(signal);
    },
  };
}
