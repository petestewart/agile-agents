/** `director.*` RPC over the `DirectorService` (T300): `agile director say`. */

import { RpcParamError, requireObject } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { DirectorService } from './service';

export function buildDirectorRpcMethods(
  service: DirectorService,
): Record<string, RpcMethodHandler> {
  return {
    'director.say': async (params) => {
      const { body } = requireObject(params);
      if (typeof body !== 'string' || body.trim() === '') {
        throw new RpcParamError('invalid "body": must be a non-empty string', { body });
      }
      return service.say(body);
    },
    'director.get': () => service.view(),
  };
}
