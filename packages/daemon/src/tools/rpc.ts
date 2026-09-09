/**
 * `tool.*` RPC methods — the transport the CLI's `agile mcp --agent <id>
 * --ticket <id>` bridge (T011 architecture decision) forwards MCP tool calls
 * over. Same shape as every other `build*RpcMethods(x)` in this package
 * (`store/rpc-methods.ts`, `bus/rpc-methods.ts`, `gates/rpc.ts`).
 */

import type { RpcMethodHandler } from '../rpc';
import type { ToolService } from './service';

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

export function buildToolRpcMethods(service: ToolService): Record<string, RpcMethodHandler> {
  return {
    'tool.list': () => service.listTools(),
    'tool.call': (params) => {
      const p = requireObject(params);
      const agent = requireString(p.agent, 'agent');
      const name = requireString(p.name, 'name');
      const ticket = typeof p.ticket === 'string' ? p.ticket : undefined;
      return service.callTool({ agent, ticket }, name, p.input ?? {});
    },
  };
}
