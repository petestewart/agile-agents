/**
 * Architect MCP verbs (T014 — design/agile-agents-design.md §7 "Tool
 * framework", §14 "Permissions per role" architect row: "oracle (write
 * guard), tickets, rules").
 *
 * Mirrors `../tools/builtins.ts`'s own shape (`name`/`description`/
 * `inputSpec`/`handler(deps, ctx, input)`) on purpose — see this ticket's
 * session notes: this ticket owns `packages/daemon/src/architect/**` only,
 * not `tools/**`, so these verbs are a parallel registry rather than an
 * addition to `BUILTIN_TOOLS`. Wiring them into the daemon's real MCP bridge
 * (`agile mcp --agent architect ...`) needs exactly one line in
 * `packages/daemon/src/tools/service.ts` — see this ticket's
 * `.pipeline-report.md` for the exact call.
 *
 * Role check: the bus has exactly one `architect` agent id (§15 "One
 * architect per repo"; `AGENT_ID_PATTERN` in `packages/shared/src/ids.ts`
 * has `architect` as a literal alternative, not a `role-N` family like
 * `eng-\d+`), so "architect role only" is simply `ctx.agent === 'architect'`
 * — no separate role-lookup table needed the way `permissions/**`'s
 * `PermissionRole` needs one for the `eng-N`/`reviewer-N`/`qa-N` families.
 */

import type {
  AgentId,
  HaltId,
  OracleEntry,
  OracleId,
  TicketContract,
  TicketId,
} from '@agile-agents/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHalt } from '../halts';
import type { StateStore } from '../store';
import { toCallToolResult } from '../tools/mcp-server';
import { type ToolInputSpec, zodObjectSchemaFromInputSpec } from '../tools/schema';
import { publishDecision, resolveDiscovery } from './decision';
import { assertOracleRefsResolve, nextTicketId, refineTicket } from './refine';
import { pointTicket } from './rubric';
import { triageDiscovery } from './triage';

export class ArchitectToolError extends Error {}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ArchitectToolError('input must be an object');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArchitectToolError(`"${field}" must be a non-empty string`);
  }
  return value;
}

export interface ArchitectToolCallContext {
  agent: AgentId | string;
  ticket?: string;
}

export interface ArchitectToolDeps {
  store: StateStore;
  now?: () => Date;
}

function assertArchitect(ctx: ArchitectToolCallContext): void {
  if (ctx.agent !== 'architect') {
    throw new ArchitectToolError(`architect verbs are architect-only (called as ${ctx.agent})`);
  }
}

// --------------------------------------------------------------- ticket_create

async function ticketCreate(
  deps: ArchitectToolDeps,
  ctx: ArchitectToolCallContext,
  input: unknown,
) {
  assertArchitect(ctx);
  const p = requireObject(input);
  const title = requireString(p.title, 'title');
  const id = (typeof p.id === 'string' ? p.id : nextTicketId(deps.store)) as TicketId;
  const oracleRefs = (p.oracle_refs as OracleId[] | undefined) ?? [];
  // QA round 1 fix: `ticket_create` used to accept an unresolved
  // `oracle_refs` entry that `ticket_refine` correctly rejects
  // (`assertOracleRefsResolve`) — a draft ticket can't be created citing an
  // oracle entry that doesn't exist (or has been superseded/retired) any
  // more than a refine can leave it citing one.
  assertOracleRefsResolve(deps.store, oracleRefs);
  return deps.store.putTicket(
    {
      id,
      title,
      status: 'draft',
      depends: (p.depends as TicketId[] | undefined) ?? [],
      oracle_refs: oracleRefs,
      kb_refs: [],
      contract: {
        inputs: [],
        outputs: [],
        acceptance: [],
        done: [],
        env: 'clone',
        ...((p.contract as Partial<TicketContract> | undefined) ?? {}),
      },
      history: [],
      security: Boolean(p.security),
    },
    { by: 'architect' },
  );
}

// --------------------------------------------------------------- ticket_refine

async function ticketRefine(
  deps: ArchitectToolDeps,
  ctx: ArchitectToolCallContext,
  input: unknown,
) {
  assertArchitect(ctx);
  const p = requireObject(input);
  const id = requireString(p.id, 'id') as TicketId;
  return refineTicket(
    deps.store,
    id,
    {
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
      ...(p.contract !== undefined ? { contract: p.contract as Partial<TicketContract> } : {}),
      ...(p.oracle_refs !== undefined ? { oracle_refs: p.oracle_refs as OracleId[] } : {}),
    },
    { by: 'architect' },
  );
}

// --------------------------------------------------------------- ticket_point

async function ticketPoint(deps: ArchitectToolDeps, ctx: ArchitectToolCallContext, input: unknown) {
  assertArchitect(ctx);
  const p = requireObject(input);
  const id = requireString(p.id, 'id') as TicketId;
  if (p.answers === undefined) {
    throw new ArchitectToolError('ticket_point: "answers" (the four-question rubric) is required');
  }
  // `pointTicket` validates `p.answers` against `FourQuestionAnswersSchema`
  // itself (review fix, opus blocker 1) — an unrecognised value/key throws
  // there rather than silently coercing to the worst tier.
  const result = pointTicket(p.answers);
  const now = deps.now ?? (() => new Date());
  const ticket = deps.store.getTicket(id);
  const estimate = {
    points: result.points,
    tier: result.tier,
    reasoning: result.reasoning,
    pointed_by: 'architect',
    pointed_at: now().toISOString(),
  };
  const updated = { ...ticket, estimate };
  const saved = await deps.store.putTicket(updated, { by: 'architect' });
  return { ticket: saved, reasoningNotes: result.reasoningNotes };
}

// --------------------------------------------------------------- discovery_triage

async function discoveryTriage(
  deps: ArchitectToolDeps,
  ctx: ArchitectToolCallContext,
  input: unknown,
) {
  assertArchitect(ctx);
  const p = requireObject(input);
  const reporterTicket = requireString(p.reporterTicket, 'reporterTicket') as TicketId;
  const discovery = p.discovery as {
    tier: 'local' | 'scoped' | 'global';
    affects: OracleId[];
    proposed: string;
  };
  if (!discovery) throw new ArchitectToolError('discovery_triage: "discovery" is required');

  const result = triageDiscovery(
    { reporterTicket, discovery },
    deps.store.listTickets(),
    deps.store.listOracleIndex(),
  );
  if (result.tier === 'local') {
    return { ...result, halt: null };
  }
  const halt = await createHalt(deps.store, {
    scope: result.tier === 'global' ? 'global' : result.affected,
    reason: discovery.proposed,
    raised_by: 'architect',
  });
  return { ...result, halt };
}

// --------------------------------------------------------------- decision_publish

async function decisionPublish(
  deps: ArchitectToolDeps,
  ctx: ArchitectToolCallContext,
  input: unknown,
) {
  assertArchitect(ctx);
  const p = requireObject(input);
  const entry = p.entry as OracleEntry | undefined;
  const body = requireString(p.body, 'body');
  if (!entry) throw new ArchitectToolError('decision_publish: "entry" is required');

  if (typeof p.haltId === 'string') {
    return resolveDiscovery(deps.store, p.haltId as HaltId, entry, body);
  }
  return publishDecision(deps.store, entry, body);
}

export interface ArchitectToolInfo {
  name: string;
  description: string;
  inputSpec: ToolInputSpec;
  handler: (
    deps: ArchitectToolDeps,
    ctx: ArchitectToolCallContext,
    input: unknown,
  ) => Promise<unknown>;
}

const STRING = { type: 'string', optional: false } as const;
const STRING_OPT = { type: 'string', optional: true } as const;
const ARRAY_OPT = { type: 'array', optional: true } as const;
const OBJECT_OPT = { type: 'object', optional: true } as const;
const OBJECT = { type: 'object', optional: false } as const;

export const ARCHITECT_TOOLS: readonly ArchitectToolInfo[] = [
  {
    name: 'ticket_create',
    description: 'Create a new draft ticket (architect-only).',
    inputSpec: {
      id: STRING_OPT,
      title: STRING,
      contract: OBJECT_OPT,
      oracle_refs: ARRAY_OPT,
      depends: ARRAY_OPT,
    },
    handler: ticketCreate,
  },
  {
    name: 'ticket_refine',
    description:
      "Refine a ticket's contract/oracle_refs and ready it if it's a draft (architect-only).",
    inputSpec: { id: STRING, title: STRING_OPT, contract: OBJECT_OPT, oracle_refs: ARRAY_OPT },
    handler: ticketRefine,
  },
  {
    name: 'ticket_point',
    description:
      'Point a ticket via the four-question rubric, writing estimate.points/tier/reasoning (architect-only).',
    inputSpec: { id: STRING, answers: OBJECT },
    handler: ticketPoint,
  },
  {
    name: 'discovery_triage',
    description:
      "Confirm or change an engineer discovery's tier (local/scoped/global) and raise a halt if not local (architect-only).",
    inputSpec: { reporterTicket: STRING, discovery: OBJECT },
    handler: discoveryTriage,
  },
  {
    name: 'decision_publish',
    description:
      'Publish an oracle decision (through the write guard) and, if haltId is given, release that halt (architect-only).',
    inputSpec: { entry: OBJECT, body: STRING, haltId: STRING_OPT },
    handler: decisionPublish,
  },
];

/**
 * Mirrors `tools/builtins.ts`'s own registration pattern for a `ToolService`
 * (`callTool` dispatch + `listTools` publication) — kept as a standalone
 * function rather than a method on `StateStore`/`ToolService` since this
 * ticket doesn't own `tools/**`. A caller with access to `tools/service.ts`
 * wires these in with one line (see file header / `.pipeline-report.md`).
 */
export function registerArchitectTools(deps: ArchitectToolDeps) {
  return {
    listTools(): ArchitectToolInfo[] {
      return [...ARCHITECT_TOOLS];
    },
    async callTool(ctx: ArchitectToolCallContext, name: string, input: unknown): Promise<unknown> {
      const tool = ARCHITECT_TOOLS.find((t) => t.name === name);
      if (!tool) throw new ArchitectToolError(`unknown architect tool: ${name}`);
      return tool.handler(deps, ctx, input);
    },
  };
}

/**
 * In-process MCP server for these verbs, mirroring `../tools/mcp-server.ts`'s
 * `createToolMcpServer` factory (same `zodObjectSchemaFromInputSpec` +
 * `toCallToolResult` pieces, reused read-only — this ticket doesn't own
 * `tools/**`, it just calls into its already-exported helpers). Used by this
 * ticket's own tests (`verbs.test.ts`, `protocol.test.ts`) to drive the
 * verbs the same way a real `agile mcp --agent architect ...` bridge would;
 * the real daemon-side wiring for that bridge is the one line named in the
 * file header / `.pipeline-report.md`.
 */
export function createArchitectMcpServer(
  deps: ArchitectToolDeps,
  ctx: ArchitectToolCallContext,
  options: { name?: string; version?: string } = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? 'agile-agents-architect-tools',
    version: options.version ?? '0.0.0',
  });
  const service = registerArchitectTools(deps);
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
