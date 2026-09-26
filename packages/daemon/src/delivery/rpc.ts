/**
 * `delivery.deliver` (alias `land.stream`) RPC over a `DeliveryService` (§8.2), validated at the boundary
 * (`RpcParamError`, -32602). The human edge and the only way to land:
 * there is no agent caller and no `land` verb (D8).
 */

import { UlidSchema } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { type DeliveryService, type LandOutcome, LandRefusedError } from './service';

function requireStreamId(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  const p = params as Record<string, unknown>;
  const result = UlidSchema.safeParse(p.stream);
  if (!result.success) {
    throw new RpcParamError('invalid "stream": must be a 26-character Crockford-base32 ULID', {
      stream: p.stream,
    });
  }
  return result.data;
}

export function buildDeliveryRpcMethods(
  service: DeliveryService,
): Record<string, RpcMethodHandler> {
  const deliver = async (params: unknown): Promise<LandOutcome> => {
    const stream = requireStreamId(params);
    try {
      return await service.land(stream);
    } catch (err) {
      if (err instanceof LandRefusedError) throw new RpcParamError(err.message);
      throw err;
    }
  };
  // §14.7: `delivery.deliver` is the name; `land.stream` stays as its alias.
  return { 'delivery.deliver': deliver, 'land.stream': deliver };
}
