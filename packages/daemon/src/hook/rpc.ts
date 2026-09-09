/**
 * `hook.*` RPC methods over a `HookService` (T009 — same shape as
 * `bus/rpc-methods.ts`/`halts/index.ts`'s `build*RpcMethods` — for wiring
 * into `daemon.ts`'s `extraMethods` table). Takes the raw Claude hook
 * payload (whatever `agile hook <event>` forwarded verbatim from stdin) and
 * returns the raw Claude hook output JSON, which the CLI then prints
 * verbatim.
 */

import type { RpcMethodHandler } from '../rpc';
import type { ClaudePostToolUsePayload, ClaudeStopPayload, HookService } from './service';
import type { ClaudePreToolUsePayload } from './types';

function asObject(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function buildHookRpcMethods(service: HookService): Record<string, RpcMethodHandler> {
  return {
    'hook.pre_tool_use': (params) =>
      service.preToolUse(asObject(params) as ClaudePreToolUsePayload),
    'hook.post_tool_use': (params) =>
      service.postToolUse(asObject(params) as ClaudePostToolUsePayload),
    'hook.stop': (params) => service.stop(asObject(params) as ClaudeStopPayload),
  };
}
