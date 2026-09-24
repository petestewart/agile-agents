/**
 * `docs.list` / `docs.search` over a `DocsService`, validated at the
 * boundary (`RpcParamError`, -32602). Reads, and no principal is accepted
 * from params (§2.2); agents use the `search_docs` verb.
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
