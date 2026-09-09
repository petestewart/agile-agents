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

import type { ToolInputSpec } from '@agile-agents/daemon';
import { zodObjectSchemaFromInputSpec } from '@agile-agents/daemon';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type ParsedArgs, optionalString, requireOption } from '../args';
import { callRpc } from '../client';

/**
 * QA round 1 (T011): a live `read_summary`/`test_run` call can take real
 * seconds (a short-lived ACP session, or an actual test suite) — `client.ts`'s
 * general 5s default is tuned for cheap RPC round trips, not "run something",
 * and would routinely time out a perfectly healthy call. Matches the
 * runner's own `DEFAULT_RUNNER_TIMEOUT_MS` so the bridge doesn't give up
 * meaningfully before the daemon-side runner would anyway.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export interface McpBridgeOptions {
  socketPath: string;
  agent: string;
  ticket?: string;
  /** RPC deadline for `tool.call` (and `tool.list`), in ms. Default `DEFAULT_MCP_TOOL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface ToolListEntry {
  name: string;
  description: string;
  source: 'builtin' | 'registry';
  inputSpec: ToolInputSpec;
}

export function parseMcpArgs(args: ParsedArgs): {
  agent: string;
  ticket?: string;
  timeoutMs?: number;
} {
  const agent = requireOption(args.options, 'agent');
  const ticket = typeof args.options.ticket === 'string' ? args.options.ticket : undefined;
  const timeoutRaw = optionalString(args.options, 'timeout');
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  if (timeoutRaw !== undefined && (timeoutMs === undefined || Number.isNaN(timeoutMs))) {
    throw new Error(
      `--timeout must be a number of milliseconds, got ${JSON.stringify(timeoutRaw)}`,
    );
  }
  return { agent, ticket, timeoutMs };
}

/** Builds (but does not connect) the MCP server for one bridge invocation — split out so a test can drive it over an in-memory transport instead of real stdio. */
export async function buildMcpBridgeServer(options: McpBridgeOptions): Promise<McpServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
  const tools = await callRpc<ToolListEntry[]>(options.socketPath, 'tool.list', undefined, {
    timeoutMs,
  });
  const server = new McpServer({ name: 'agile-agents-tools', version: '0.0.0' });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: zodObjectSchemaFromInputSpec(tool.inputSpec) },
      async (args) => {
        try {
          const result = await callRpc(
            options.socketPath,
            'tool.call',
            {
              agent: options.agent,
              ticket: options.ticket,
              name: tool.name,
              input: args ?? {},
            },
            { timeoutMs },
          );
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
