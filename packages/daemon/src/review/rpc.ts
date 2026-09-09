/**
 * `review.*`/`rules.*` RPC methods — same shape as every other
 * `build*RpcMethods(x)` in this package (`tools/rpc.ts`'s
 * `buildToolRpcMethods`, `store/rpc-methods.ts`, `bus/rpc-methods.ts`).
 *
 * WIRING GAP: not yet spliced into `rpc.ts`'s `buildMethods` (that file is
 * outside this ticket's ownership — `daemon.ts`/`index.ts`/`rpc.ts` are
 * named off-limits in the Session override). The one-line change needed:
 * `buildMethods` merges `buildReviewRpcMethods(...)`'s result into its
 * returned method table, the same way it already merges
 * `buildToolRpcMethods`/`buildHaltRpcMethods`/etc.
 */

import type { RpcMethodHandler } from '../rpc';
import type { ToolCallContext } from '../tools/types';
import { type ReviewVerbDeps, reviewDispute, reviewGet, reviewSubmit, rulesList } from './verbs';

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('params must be an object');
  }
  return params as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value;
}

function ctxFrom(p: Record<string, unknown>): ToolCallContext {
  const agent = requireString(p.agent, 'agent');
  const ticket = typeof p.ticket === 'string' ? p.ticket : undefined;
  return { agent, ticket };
}

export function buildReviewRpcMethods(deps: ReviewVerbDeps): Record<string, RpcMethodHandler> {
  return {
    'review.submit': (params) => {
      const p = requireObject(params);
      return reviewSubmit(deps, ctxFrom(p), p.input ?? {});
    },
    'review.get': (params) => {
      const p = requireObject(params);
      return reviewGet(deps, ctxFrom(p), p.input ?? {});
    },
    'rules.list': (params) => {
      const p = requireObject(params);
      return rulesList(deps, ctxFrom(p), p.input ?? {});
    },
    'review.dispute': (params) => {
      const p = requireObject(params);
      return reviewDispute(deps, ctxFrom(p), p.input ?? {});
    },
  };
}
