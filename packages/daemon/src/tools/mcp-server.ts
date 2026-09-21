/**
 * In-process MCP server over the eight verbs (design/cockpit-design.md
 * §4.1). One server per attached session: the session id is fixed for the
 * life of the server and merged into every call, so a model cannot name a
 * different session than the one its bridge was launched with.
 *
 * T130 replaced the tool *framework* this file used to serve (a registry of
 * `tool.yaml` folders, each with its own generated input schema) with the
 * fixed verb table. The published schema per verb is the shared zod schema
 * minus `session` — the model never supplies its own identity.
 *
 * `agile mcp --session <id>` (`packages/cli/src/commands/mcp.ts`) is the
 * real, out-of-process bridge; this factory is the same surface for a test
 * that drives it in-process.
 */

import {
  AGENT_VERBS,
  AGENT_VERB_DESCRIPTIONS,
  AGENT_VERB_SCHEMAS,
  type AgentVerb,
} from '@agile-agents/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type VerbService, verbHandlers } from '../attach/verbs';

export interface CreateVerbMcpServerOptions {
  name?: string;
  version?: string;
}

/** Wraps a verb call's result/error as an MCP `CallToolResult` — a tool failure is data, never a rejected promise. */
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

/** The verb's published input shape: its zod fields, minus the `session` the bridge supplies. */
export function verbInputShape(verb: AgentVerb): Record<string, unknown> {
  const { session: _session, ...rest } = AGENT_VERB_SCHEMAS[verb].shape;
  return rest;
}

export function createVerbMcpServer(
  service: VerbService,
  sessionId: string,
  options: CreateVerbMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? 'agile-agents-verbs',
    version: options.version ?? '0.0.0',
  });
  const handlers = verbHandlers(service);

  for (const verb of AGENT_VERBS) {
    server.registerTool(
      verb,
      {
        description: AGENT_VERB_DESCRIPTIONS[verb],
        // biome-ignore lint/suspicious/noExplicitAny: the SDK types the shape as its own ZodRawShape.
        inputSchema: verbInputShape(verb) as any,
      },
      async (args: Record<string, unknown> | undefined) =>
        toCallToolResult(async () => handlers[verb]({ ...(args ?? {}), session: sessionId })),
    );
  }

  return server;
}
