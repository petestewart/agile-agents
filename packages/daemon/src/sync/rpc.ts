/**
 * `sync.*` RPC methods over a `JiraSync` (T045 — design §18 "JSON-RPC over
 * unix socket for hooks/adapters"). Param validation follows `merge/rpc.ts`:
 * validate at the boundary, throw `RpcParamError` (-32602) rather than
 * letting a bare destructuring `TypeError` reach `dispatch()`.
 *
 * Backs both `agile sync jira link|unlink|status` (the CLI is a thin client
 * over this socket) and the control room's `POST /api/sync/jira/link` —
 * `http.ts` calls the same `JiraSync` object, so a link made from either
 * surface is the same write.
 */

import { RpcParamError } from '../rpc';
import type { RpcMethodHandler } from '../rpc';
import type { JiraSync } from './jira';

/** Jira project keys are uppercase alphanumeric, 2-10 chars, starting with a letter. */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,9}$/;

export function requireProjectKey(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_KEY_PATTERN.test(value)) {
    throw new RpcParamError('invalid "project": must look like a Jira project key, e.g. LED', {
      project: value,
    });
  }
  return value;
}

export function buildSyncRpcMethods(sync: JiraSync): Record<string, RpcMethodHandler> {
  return {
    'sync.jira_link': (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      return sync.link(requireProjectKey(p.project));
    },
    'sync.jira_unlink': () => sync.unlink(),
    'sync.jira_status': () => sync.status(),
    /** Force a pass now instead of waiting for the poll interval. */
    'sync.jira_tick': () => sync.tick(),
  };
}
