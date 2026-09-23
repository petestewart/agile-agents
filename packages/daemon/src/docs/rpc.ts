/**
 * `docs.list` / `docs.search` over a `DocsService` (T134). Same contract as
 * `streams/rpc.ts`: params are validated at the boundary and rejected with
 * `RpcParamError` (-32602) rather than reaching the service as `undefined`.
 *
 * This edge serves the CLI and the UI, so every call is the human's
 * (cockpit design §2.2) — an agent reaches docs through T130's `search_docs`
 * verb, not through this table. Both methods are reads, so there is no
 * principal to stamp on a record; what §2.2 demands of a read edge is that
 * no principal is ever accepted from the params, and none is.
 */

import { RpcParamError, requireObject, requireStreamId } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { Doc, DocsService, SearchHit } from './service';

export function buildDocsRpcMethods(service: DocsService): Record<string, RpcMethodHandler> {
  return {
    'docs.list': (params: unknown): { docs: Doc[] } => {
      const stream = requireStreamId(requireObject(params).stream);
      return { docs: service.docsForStream(stream) };
    },

    'docs.search': async (params: unknown): Promise<{ hits: SearchHit[] }> => {
      const obj = requireObject(params);
      if (typeof obj.query !== 'string' || obj.query.length === 0) {
        throw new RpcParamError('invalid "query": must be a non-empty string', {
          query: obj.query,
        });
      }
      const ctx = obj.stream === undefined ? {} : { stream: requireStreamId(obj.stream) };
      return { hits: await service.search(obj.query, ctx) };
    },
  };
}
