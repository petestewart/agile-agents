/**
 * EM-only MCP verbs + `em.*` RPC methods (T015; design/
 * agile-agents-design.md §7 "Tool framework" (verbs are thin role-checked
 * wrappers, same pattern as `tools/builtins.ts`'s `board_post`/`bus_send`),
 * §5 "Comms bus").
 *
 * `registerEmTools` mirrors `tools/builtins.ts`'s `BUILTIN_TOOLS` shape
 * exactly (`name`/`description`/`inputSpec`/`handler(deps, ctx, input)`) but
 * is a **separate list**, not an edit to that file — `tools/**` is outside
 * this ticket's file ownership (session brief). Wiring these into
 * `ToolService`'s combined tool list (today hardcoded to `BUILTIN_TOOLS`,
 * see `tools/service.ts`) and gating them to the `em` agent id at the MCP
 * bridge is the manager's wiring job at merge — flagged in
 * `.pipeline-report.md`.
 *
 * `buildEmRpcMethods` follows every other `build*RpcMethods(x)` in this
 * package (`bus/rpc-methods.ts`, `gates/rpc.ts`, `runner/rpc.ts`): a plain
 * object of handlers, not wired into `rpc.ts`'s `extraMethods` table by this
 * ticket (same reason: `rpc.ts` is outside this ticket's file ownership).
 */

import type { HaltId, MessageRecipient, SprintId, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { roleOf } from '../bus/routing';
import type { GateService } from '../gates';
import type { RpcMethodHandler } from '../rpc';
import type { Runner } from '../runner';
import type { StateStore } from '../store';
import type { ToolInputSpec } from '../tools/schema';
import type { ToolCallContext } from '../tools/types';
import { type AssignReadyOptions, assignReady } from './assign';
import { postDecision, readBoard } from './board';
import { type EmLoop, currentSprint } from './loop';
import { type SprintReviewOptions, sprintReview } from './review';
import { type PlanSprintOptions, planSprint } from './sprint';
import { standupCall } from './standup';

export class EmVerbError extends Error {}

function requireEm(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'em') {
    throw new EmVerbError(`${verb}: only the em agent may call this verb`);
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EmVerbError('input must be an object');
  }
  return input as Record<string, unknown>;
}

/** Resolves `{sprintId?}` -> the named sprint, or the current live sprint. Throws if neither resolves. */
function resolveSprint(store: StateStore, sprintId: unknown, verb: string) {
  const sprint =
    typeof sprintId === 'string' ? store.getSprint(sprintId as SprintId) : currentSprint(store);
  if (!sprint)
    throw new EmVerbError(
      `${verb}: no sprint (pass "sprintId", or plan one with sprint_plan first)`,
    );
  return sprint;
}

export interface EmToolDeps {
  store: StateStore;
  bus: Bus;
  gateService: GateService;
  runner: Pick<Runner, 'spawn'>;
  assign?: AssignReadyOptions;
  sprintReview: SprintReviewOptions;
}

export interface EmToolInfo {
  name: string;
  description: string;
  inputSpec: ToolInputSpec;
  handler: (deps: EmToolDeps, ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

const STRING_OPT = { type: 'string', optional: true } as const;
const NUMBER_OPT = { type: 'number', optional: true } as const;
const STRING = { type: 'string', optional: false } as const;
const ARRAY = { type: 'array', optional: false } as const;
const ARRAY_OPT = { type: 'array', optional: true } as const;

async function sprintPlan(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'sprint_plan');
  const p = requireObject(input);
  const opts: PlanSprintOptions = {
    cap: typeof p.cap === 'number' ? p.cap : undefined,
    goal: typeof p.goal === 'string' ? p.goal : undefined,
    budgetTokens: typeof p.budgetTokens === 'number' ? p.budgetTokens : undefined,
  };
  return planSprint(deps.store, opts);
}

async function assign(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'assign');
  const p = requireObject(input);
  const sprint = resolveSprint(deps.store, p.sprintId, 'assign');
  return assignReady(deps.store, deps.bus, deps.runner, sprint, deps.assign);
}

async function boardRead(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'board_read');
  const p = requireObject(input);
  const sprint = resolveSprint(deps.store, p.sprintId, 'board_read');
  return readBoard(deps.store, sprint);
}

async function standupCallVerb(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'standup_call');
  const p = requireObject(input);
  if (typeof p.haltId !== 'string' || p.haltId.length === 0) {
    throw new EmVerbError('standup_call: "haltId" must be a non-empty string');
  }
  const halt = deps.store.getHalt(p.haltId as HaltId);
  await standupCall(deps.bus, halt);
  return { called: halt.id, affected: halt.affected ?? [] };
}

async function sprintReviewVerb(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'sprint_review');
  const p = requireObject(input);
  const sprint = resolveSprint(deps.store, p.sprintId, 'sprint_review');
  return sprintReview(deps.store, deps.gateService, sprint, deps.sprintReview);
}

async function decisionPost(deps: EmToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'decision_post');
  const p = requireObject(input);
  if (!Array.isArray(p.to) || p.to.length === 0) {
    throw new EmVerbError('decision_post: "to" must be a non-empty array');
  }
  if (typeof p.body !== 'string' || p.body.length === 0) {
    throw new EmVerbError('decision_post: "body" must be a non-empty string');
  }
  const result = await postDecision(deps.bus, {
    to: p.to as MessageRecipient[],
    body: p.body,
    ticket: typeof p.ticket === 'string' ? (p.ticket as TicketId) : undefined,
    refs: Array.isArray(p.refs) ? (p.refs as string[]) : undefined,
    from: 'em',
  });
  if (!result.ok) throw new EmVerbError(`decision_post: ${result.reason}`);
  return { message: result.message, recipients: result.recipients };
}

/**
 * EM-only verbs (see file header re: wiring). Names deliberately match the
 * session brief's list exactly (`sprint_plan`, `assign`, `board_read`,
 * `standup_call`, `sprint_review`, `decision_post`).
 */
export const EM_TOOLS: readonly EmToolInfo[] = [
  {
    name: 'sprint_plan',
    description: 'Compute the next dependency-frontier sprint and write sprints/S-<n>.yaml.',
    inputSpec: { cap: NUMBER_OPT, goal: STRING_OPT, budgetTokens: NUMBER_OPT },
    handler: sprintPlan,
  },
  {
    name: 'assign',
    description: "Spawn engineers for a sprint's ready tickets and send them assign messages.",
    inputSpec: { sprintId: STRING_OPT },
    handler: assign,
  },
  {
    name: 'board_read',
    description: "Read a sprint's board: per-ticket latest stanza, blocked/discovery flags.",
    inputSpec: { sprintId: STRING_OPT },
    handler: boardRead,
  },
  {
    name: 'standup_call',
    description: 'Send an urgent standup_call to every agent a halt names as affected.',
    inputSpec: { haltId: STRING },
    handler: standupCallVerb,
  },
  {
    name: 'sprint_review',
    description:
      'Run sprint review for a sprint whose tickets are all done: resolve the gate, merge + plan next (delegated) or HIL + pre-plan (human).',
    inputSpec: { sprintId: STRING_OPT },
    handler: sprintReviewVerb,
  },
  {
    name: 'decision_post',
    description: "Post a decision bus message (the standup protocol's output).",
    inputSpec: { to: ARRAY, body: STRING, ticket: STRING_OPT, refs: ARRAY_OPT },
    handler: decisionPost,
  },
];

export function registerEmTools(): readonly EmToolInfo[] {
  return EM_TOOLS;
}

export function buildEmRpcMethods(
  loop: EmLoop,
  store: StateStore,
): Record<string, RpcMethodHandler> {
  return {
    'em.tick': () => loop.tick(),
    'em.status': () => ({
      sprint: currentSprint(store),
      halts: store.listHalts(),
    }),
  };
}
