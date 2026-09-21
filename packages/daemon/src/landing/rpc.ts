/**
 * `land.*` RPC over a `LandingService` (T132, design §8.2). Same contract
 * as `streams/rpc.ts`: params are validated at the boundary and a refusal
 * is `RpcParamError` (-32602), never a destructuring `TypeError` reaching
 * `dispatch()`.
 *
 * This is the human edge and the only way to land: §8.2's "human presses
 * Land (or `agile land <stream>`)". There is no agent-principal caller and
 * no `land` MCP verb — D8's protected branches are only ever merged into by
 * the human's own decision.
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
