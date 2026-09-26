/**
 * T321: `node.link` — `{id, key|null, system?}` links (or unlinks) a node to a tracker issue.
 * T323: `node.import_children` — `{id}` creates one linked child per issue in the node's epic.
 */

import { TrackerSystemSchema, UlidSchema } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import type { TrackerLinks } from './link';
import { TrackerError } from './port';

export function buildTrackerRpcMethods(links: TrackerLinks): Record<string, RpcMethodHandler> {
  return {
    'node.import_children': async (params) => {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        throw new RpcParamError('params must be an object', { params });
      }
      const id = UlidSchema.safeParse((params as Record<string, unknown>).id);
      if (!id.success) throw new RpcParamError('invalid "id": must be a stream ULID', {});
      try {
        return await links.importChildren(id.data);
      } catch (err) {
        if (err instanceof TrackerError) throw new RpcParamError(err.message);
        throw err;
      }
    },
    'node.link': async (params) => {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        throw new RpcParamError('params must be an object', { params });
      }
      const p = params as Record<string, unknown>;
      const id = UlidSchema.safeParse(p.id);
      if (!id.success) throw new RpcParamError('invalid "id": must be a stream ULID', { id: p.id });
      if (p.key !== null && (typeof p.key !== 'string' || p.key.trim() === '')) {
        throw new RpcParamError('invalid "key": an issue key (SHOP-11) or null', {});
      }
      const system = p.system === undefined ? undefined : TrackerSystemSchema.safeParse(p.system);
      if (system !== undefined && !system.success) {
        throw new RpcParamError('invalid "system": jira or linear', {});
      }
      try {
        return await links.link(
          id.data,
          p.key as string | null,
          system ? { system: system.data } : {},
        );
      } catch (err) {
        // A tracker error is the caller's to fix (key, config); its message never carries a token.
        if (err instanceof TrackerError) throw new RpcParamError(err.message);
        throw err;
      }
    },
  };
}
