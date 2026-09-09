/**
 * Daemon verbs exposed as MCP tools (§7 "Tool framework" scope line: "Also
 * expose daemon verbs as MCP tools: board_post, bus_send, ticket_get,
 * oracle_get, kb_search").
 *
 * These never touch the tool registry/cache/runner/ledger machinery in
 * `service.ts` — they're thin, role-checked wrappers over `StateStore`/`Bus`
 * methods that already exist (T005–T007). Routed to the store/bus with role
 * checks derived from the calling agent's id (`roleOf`, T006's routing
 * module) — no separate `--role` flag on the MCP bridge, since an agent id
 * like `eng-3`/`reviewer-2`/`qa-1` already encodes its role.
 */

import {
  type KbId,
  type OracleId,
  StanzaSchema,
  type TicketId,
  ulid,
  validateStanza,
} from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import { roleOf } from '../bus/routing';
import type { StateStore } from '../store/store';
import type { ToolInputSpec } from './schema';
import type { ToolCallContext } from './types';

export class BuiltinToolError extends Error {}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BuiltinToolError('input must be an object');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BuiltinToolError(`"${field}" must be a non-empty string`);
  }
  return value;
}

export interface BuiltinToolDeps {
  store: StateStore;
  bus: Bus;
}

/**
 * `board_post` — "only for engineers on their own ticket" (manager
 * decision). "Their own ticket" is the ticket the calling session was
 * launched for (`ctx.ticket`, from `agile mcp --agent <id> --ticket <id>`),
 * not merely any ticket id the caller names in the input — an engineer's MCP
 * session has no legitimate reason to post a stanza onto a different ticket.
 */
async function boardPost(deps: BuiltinToolDeps, ctx: ToolCallContext, input: unknown) {
  if (roleOf(ctx.agent) !== 'engineer') {
    throw new BuiltinToolError('board_post: only engineers may post board stanzas');
  }
  if (!ctx.ticket) {
    throw new BuiltinToolError('board_post: this session has no ticket context');
  }
  const p = requireObject(input);
  if (p.ticket !== undefined && p.ticket !== ctx.ticket) {
    throw new BuiltinToolError(
      `board_post: agent ${ctx.agent} may only post to its own ticket (${ctx.ticket}), not ${String(p.ticket)}`,
    );
  }
  const stanza = validateStanza(
    StanzaSchema.parse({
      ts: new Date().toISOString(),
      ...p,
      ticket: ctx.ticket,
      agent: ctx.agent,
    }),
  );
  return deps.store.appendStanza(stanza);
}

/** `bus_send` — routing is enforced by `Bus.send` itself (§5 "Routing rules"); `from` is always the calling agent, never caller-supplied, so a session can't spoof another agent's identity over MCP. */
async function busSend(deps: BuiltinToolDeps, ctx: ToolCallContext, input: unknown) {
  const p = requireObject(input);
  const message = {
    id: typeof p.id === 'string' ? p.id : ulid(),
    ts: new Date().toISOString(),
    ...p,
    from: ctx.agent,
  };
  const result = await deps.bus.send(message);
  if (!result.ok) throw new BuiltinToolError(`bus_send: ${result.reason}`);
  return { message: result.message, recipients: result.recipients };
}

async function ticketGet(deps: BuiltinToolDeps, _ctx: ToolCallContext, input: unknown) {
  const p = requireObject(input);
  const id = requireString(p.id, 'id') as TicketId;
  return deps.store.getTicket(id);
}

async function oracleGet(deps: BuiltinToolDeps, _ctx: ToolCallContext, input: unknown) {
  const p = requireObject(input);
  const id = requireString(p.id, 'id') as OracleId;
  return deps.store.getOracleEntry(id);
}

/** The only keys `kb_search` understands — anything else is a caller error (QA round 1), not silently ignored. */
const KB_SEARCH_KEYS = new Set(['id', 'scope', 'kind']);

/**
 * `kb_search` — "Reader agents query by scope before touching source" (§4
 * "Knowledge store"): `{id}` fetches one fact; `{scope?, kind?}` filters
 * `knowledge/index.yaml` (a substring match against each entry's `scope`
 * array — the index has no full-text search, only what §4 gives it) and
 * returns index entries (id + the index projection), not full fact bodies —
 * a caller that wants one in full follows up with `{id}`.
 *
 * QA round 1 fix: an unrecognized key (typo, a field from a different
 * tool's shape) used to be silently ignored, so a caller could believe a
 * filter was applied when it never was. Rejected up front instead.
 */
async function kbSearch(deps: BuiltinToolDeps, _ctx: ToolCallContext, input: unknown) {
  const p = requireObject(input);
  const unknownKeys = Object.keys(p).filter((key) => !KB_SEARCH_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new BuiltinToolError(
      `kb_search: unknown input key(s): ${unknownKeys.join(', ')} (expected only: id, scope, kind)`,
    );
  }
  if (p.id !== undefined) {
    return deps.store.getKbFact(requireString(p.id, 'id') as KbId);
  }
  if (p.scope !== undefined && typeof p.scope !== 'string') {
    throw new BuiltinToolError('kb_search: "scope" must be a string');
  }
  if (p.kind !== undefined && typeof p.kind !== 'string') {
    throw new BuiltinToolError('kb_search: "kind" must be a string');
  }
  const scope = p.scope as string | undefined;
  const kind = p.kind as string | undefined;
  const index = deps.store.listKbIndex();
  const matches = Object.entries(index).filter(([, entry]) => {
    if (kind !== undefined && entry.kind !== kind) return false;
    if (scope !== undefined && !entry.scope.some((s) => s.includes(scope))) return false;
    return true;
  });
  return matches.map(([id, entry]) => ({ id, ...entry }));
}

export interface BuiltinToolInfo {
  name: string;
  description: string;
  /** Real per-field shape, so `tools/list` over MCP is discoverable — see `schema.ts`'s header. */
  inputSpec: ToolInputSpec;
  handler: (deps: BuiltinToolDeps, ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

const STRING = { type: 'string', optional: false } as const;
const STRING_OPT = { type: 'string', optional: true } as const;
const ARRAY = { type: 'array', optional: false } as const;
const ARRAY_OPT = { type: 'array', optional: true } as const;
const BOOLEAN_OPT = { type: 'boolean', optional: true } as const;
const OBJECT_OPT = { type: 'object', optional: true } as const;

export const BUILTIN_TOOLS: readonly BuiltinToolInfo[] = [
  {
    name: 'board_post',
    description:
      "Post a board stanza (progress/blocked/discovery/etc.) to the caller's own ticket.",
    inputSpec: {
      kind: STRING,
      summary: STRING,
      discovery: OBJECT_OPT,
      handoff: OBJECT_OPT,
    },
    handler: boardPost,
  },
  {
    name: 'bus_send',
    description: 'Send a bus message, routed and validated by the daemon (§5 routing rules apply).',
    inputSpec: {
      to: ARRAY,
      kind: STRING,
      priority: STRING,
      body: STRING,
      ticket: STRING_OPT,
      reply_to: STRING_OPT,
      refs: ARRAY_OPT,
      requires_ack: BOOLEAN_OPT,
      deadline: STRING_OPT,
      promote_to: STRING_OPT,
      hil_kind: STRING_OPT,
    },
    handler: busSend,
  },
  {
    name: 'ticket_get',
    description: 'Read a ticket by id.',
    inputSpec: { id: STRING },
    handler: ticketGet,
  },
  {
    name: 'oracle_get',
    description: 'Read an oracle decision or spec by id.',
    inputSpec: { id: STRING },
    handler: oracleGet,
  },
  {
    name: 'kb_search',
    description: 'Look up a knowledge-store fact by id, or search the index by scope/kind.',
    inputSpec: { id: STRING_OPT, scope: STRING_OPT, kind: STRING_OPT },
    handler: kbSearch,
  },
];
