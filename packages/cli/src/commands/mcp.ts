/**
 * `agile mcp --session <id>` — the stdio MCP bridge every attached session
 * is configured with (design/cockpit-design.md §4.1).
 *
 * A thin, stateless proxy: the eight verbs are a fixed table in
 * `@agile-agents/shared`, so there is nothing to discover at startup — the
 * bridge registers them from the shared schemas and forwards each call to
 * the daemon's `agent.<verb>` RPC. The session id is fixed from this
 * invocation's flag and merged into every call, so an agent's MCP session
 * cannot claim to be a different session than the one it was launched with
 * (it is also what stamps the `agent` principal daemon-side).
 *
 * T130 replaced the old `--agent`/`--ticket` bridge over `tool.list`/
 * `tool.call`: there is no tool registry to list any more.
 */

import {
  AGENT_VERBS,
  AGENT_VERB_DESCRIPTIONS,
  AGENT_VERB_SCHEMAS,
  type AgentVerb,
} from '@agile-agents/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type ParsedArgs, optionalString, requireOption } from '../args';
import { callRpc } from '../client';

/**
 * A live `test_run` call takes real seconds (an actual test suite), and
 * `client.ts`'s general 5s default is tuned for cheap round trips.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export interface McpBridgeOptions {
  socketPath: string;
  /** The attached session this bridge belongs to — fixed for its lifetime. */
  session: string;
  /** RPC deadline for a verb call, in ms. Default `DEFAULT_MCP_TOOL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export function parseMcpArgs(args: ParsedArgs): {
  session: string;
  timeoutMs?: number;
  /** `--socket <path>`: the daemon socket, explicit — a `.worktrees/**` cwd resolves to the wrong repo root without it. */
  socketPath?: string;
} {
  const session = requireOption(args.options, 'session');
  const socketPath = optionalString(args.options, 'socket');
  const timeoutRaw = optionalString(args.options, 'timeout');
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  if (timeoutRaw !== undefined && (timeoutMs === undefined || Number.isNaN(timeoutMs))) {
    throw new Error(
      `--timeout must be a number of milliseconds, got ${JSON.stringify(timeoutRaw)}`,
    );
  }
  return { session, timeoutMs, ...(socketPath !== undefined ? { socketPath } : {}) };
}

/** The verb's published input shape: its zod fields minus `session`, which this bridge supplies. */
function verbInputShape(verb: AgentVerb): Record<string, unknown> {
  const { session: _session, ...rest } = AGENT_VERB_SCHEMAS[verb].shape;
  return rest;
}

/** Builds (but does not connect) the MCP server for one bridge invocation — split out so a test can drive it over an in-memory transport. */
export function buildMcpBridgeServer(options: McpBridgeOptions): McpServer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
  const server = new McpServer({ name: 'agile-agents-verbs', version: '0.0.0' });

  for (const verb of AGENT_VERBS) {
    server.registerTool(
      verb,
      {
        description: AGENT_VERB_DESCRIPTIONS[verb],
        // biome-ignore lint/suspicious/noExplicitAny: the SDK types the shape as its own ZodRawShape.
        inputSchema: verbInputShape(verb) as any,
      },
      async (args: Record<string, unknown> | undefined) => {
        try {
          const result = await callRpc(
            options.socketPath,
            `agent.${verb}`,
            { ...(args ?? {}), session: options.session },
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

/** Runs the bridge over real stdio and never resolves — the parent agent session's lifetime owns this process. */
export async function runCliMcp(options: McpBridgeOptions): Promise<number> {
  const server = buildMcpBridgeServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return new Promise(() => {});
}
