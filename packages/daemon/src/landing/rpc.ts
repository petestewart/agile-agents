/**
 * `land.*` RPC over a `LandingService` (§8.2), validated at the boundary
 * (`RpcParamError`, -32602). The human edge and the only way to land:
 * there is no agent caller and no `land` verb (D8).
 */

import { UlidSchema } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { type LandOutcome, LandRefusedError, type LandingService } from './service';

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

export function buildLandingRpcMethods(service: LandingService): Record<string, RpcMethodHandler> {
  return {
    'land.stream': async (params): Promise<LandOutcome> => {
      const stream = requireStreamId(params);
      try {
        return await service.land(stream);
      } catch (err) {
        if (err instanceof LandRefusedError) throw new RpcParamError(err.message);
        throw err;
      }
    },
  };
}
