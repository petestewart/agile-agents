/**
 * `agile mcp --agent <id> --ticket <id>` — the stdio MCP bridge every agent
 * session is configured with (T011/T012 — design/agile-agents-design.md §7
 * "Tool framework"; manager architecture decision: "runs
 * `@modelcontextprotocol/sdk` `McpServer` over `StdioServerTransport` and
 * forwards each tool call to the daemon over the existing unix-socket
 * JSON-RPC (`tool.call` / `tool.list` methods)").
 *
 * All tool logic (registry, cache, runner, ledger, built-in verbs) lives
 * daemon-side (`packages/daemon/src/tools/`) — this file is a thin,
 * stateless proxy: `tool.list` once at startup to learn the tool names, then
 * one `tool.call` RPC per MCP `tools/call`, with `agent`/`ticket` fixed from
 * this invocation's flags on every call (an agent's MCP session can't spoof
 * a different identity than the one it was launched with).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { type ParsedArgs, requireOption } from '../args';
import { callRpc } from '../client';

export interface McpBridgeOptions {
  socketPath: string;
  agent: string;
  ticket?: string;
}

interface ToolListEntry {
  name: string;
  description: string;
  source: 'builtin' | 'registry';
}

export function parseMcpArgs(args: ParsedArgs): { agent: string; ticket?: string } {
  const agent = requireOption(args.options, 'agent');
  const ticket = typeof args.options.ticket === 'string' ? args.options.ticket : undefined;
  return { agent, ticket };
}

/** Builds (but does not connect) the MCP server for one bridge invocation — split out so a test can drive it over an in-memory transport instead of real stdio. */
export async function buildMcpBridgeServer(options: McpBridgeOptions): Promise<McpServer> {
  const tools = await callRpc<ToolListEntry[]>(options.socketPath, 'tool.list');
  const server = new McpServer({ name: 'agile-agents-tools', version: '0.0.0' });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.record(z.string(), z.unknown()) },
      async (args) => {
        try {
          const result = await callRpc(options.socketPath, 'tool.call', {
            agent: options.agent,
            ticket: options.ticket,
            name: tool.name,
            input: args ?? {},
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/** Runs the bridge over real stdio and never resolves (a long-lived process, like `agile daemon start`) — the caller keeps the process alive until the parent agent session ends. */
export async function runCliMcp(options: McpBridgeOptions): Promise<number> {
  const server = await buildMcpBridgeServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return new Promise(() => {});
}
