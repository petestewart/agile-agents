/**
 * In-process MCP server factory (T011 architecture decision: "Provide also
 * an in-process `createToolMcpServer(registry)` factory in the daemon for
 * tests"). Every tool — built-in verb or `.agile/tools/`-registered — is
 * exposed with a **real per-field** input schema, built from
 * `ToolService.listTools()`'s `inputSpec` via `zodShapeFromInputSpec`
 * (review fix, T011: a bare `z.record(z.string(), z.unknown())` published an
 * empty `properties: {}`, leaving a calling agent nothing to discover
 * `read_summary`'s `path`/`question` or `test_run`'s `command`/`cwd` from) —
 * see `schema.ts`'s header for the full story. The tool's own handler still
 * does the real validation; the MCP-visible schema exists so an agent can
 * *see* the shape before calling.
 *
 * `ctx` (the calling agent/ticket) is fixed for the lifetime of the server —
 * one MCP server per `agile mcp --agent <id> --ticket <id>` invocation
 * (T012), mirrored here for the in-process case a test constructs directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodObjectSchemaFromInputSpec } from './schema';
import type { ToolService } from './service';
import type { ToolCallContext } from './types';

export interface CreateToolMcpServerOptions {
  name?: string;
  version?: string;
}

/** Wraps a `ToolService.callTool` result/error as an MCP `CallToolResult` — text content, `isError` on failure, never a thrown exception (the SDK expects tool failures to come back as data, not a rejected promise). */
export async function toCallToolResult(run: () => Promise<unknown>): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    const result = await run();
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

export function createToolMcpServer(
  service: ToolService,
  ctx: ToolCallContext,
  options: CreateToolMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? 'agile-agents-tools',
    version: options.version ?? '0.0.0',
  });

  for (const entry of service.listTools()) {
    server.registerTool(
      entry.name,
      {
        description: entry.description,
        inputSchema: zodObjectSchemaFromInputSpec(entry.inputSpec),
      },
      async (args) => toCallToolResult(() => service.callTool(ctx, entry.name, args ?? {})),
    );
  }

  return server;
}
