/**
 * `quota.*` RPC methods (T023), same shape as `bus/rpc-methods.ts`'s
 * `buildBusRpcMethods` — for wiring into `rpc.ts`'s `extraMethods` table.
 * Not wired into `daemon.ts`/`index.ts` by this ticket (file-ownership
 * boundary); see the pipeline report for the exact wiring line.
 */

import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store/store';
import { QuotaService } from './records';
import { type RouteCandidatesOptions, routeCandidates } from './routing';

export interface QuotaRecord429Params {
  vendor: string;
  account: string;
  retryAfterSeconds?: number;
}

export interface QuotaRouteParams {
  role: string;
  tier: string;
  routing?: RouteCandidatesOptions['routing'];
  floor?: number;
}

export function buildQuotaRpcMethods(
  quota: QuotaService,
  store: StateStore,
): Record<string, RpcMethodHandler> {
  return {
    'quota.list': () => quota.list(),
    'quota.record_429': (params) => {
      const { vendor, account, retryAfterSeconds } = params as QuotaRecord429Params;
      return quota.record429(vendor, account, retryAfterSeconds);
    },
    'quota.route': (params) => {
      const { role, tier, routing, floor } = params as QuotaRouteParams;
      return routeCandidates(role, tier, {
        vendors: store.getVendors(),
        quotas: quota.list(),
        routing,
        floor,
      });
    },
  };
}
