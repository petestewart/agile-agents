/** `hook.*` RPC: the raw Claude hook payload in (forwarded by `agile hook <event>`), raw hook JSON out. */

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
