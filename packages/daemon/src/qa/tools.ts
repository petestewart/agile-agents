/**
 * QA's MCP verbs (T017): `qa_plan`, `qa_run`, `qa_submit`, wrapping
 * `QaProtocol` in the same shape `tools/builtins.ts`'s `BUILTIN_TOOLS`
 * already uses (`BuiltinToolInfo`) — this ticket owns `src/qa/**` only, not
 * `tools/**`, so this is a sibling registry rather than an addition to that
 * file. See this module's bottom doc comment for the one-line wiring the
 * manager needs to splice these into `ToolService`.
 */

import type { AgentId, TicketId } from '@agile-agents/shared';
import { roleOf } from '../bus/routing';
import type { ToolInputSpec } from '../tools/schema';
import type { ToolCallContext } from '../tools/types';
import type { QaProtocol } from './protocol';

export class QaToolError extends Error {}

function requireQaRole(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'qa') {
    throw new QaToolError(`${verb}: only the qa role may call this verb`);
  }
}

function requireTicket(ctx: ToolCallContext, verb: string): string {
  if (!ctx.ticket) {
    throw new QaToolError(`${verb}: this session has no ticket context`);
  }
  return ctx.ticket;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new QaToolError('input must be an object');
  }
  return input as Record<string, unknown>;
}

/**
 * `qa_plan` input: `{ plan: { "<criterion index>": "<command>", ... } }` —
 * an object keyed by criterion index (as a string, JSON's only object-key
 * shape) rather than an array, so a QA turn can plan a subset of criteria
 * (skip the ones it can't map to a command) without gapped array holes.
 */
function qaPlanInput(input: unknown): Record<number, string> {
  const p = requireObject(input);
  const plan = p.plan;
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    throw new QaToolError('qa_plan: "plan" must be an object of {criterionIndex: command}');
  }
  const mapping: Record<number, string> = {};
  for (const [key, value] of Object.entries(plan as Record<string, unknown>)) {
    // Review round nit: validate the key itself — `Number("foo")` is `NaN`,
    // which used to surface only downstream as an opaque
    // "no criterion at index NaN" from `QaProtocol.plan`. Not a silent
    // drop either way, but naming the actual problem here is clearer.
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new QaToolError(`qa_plan: plan key "${key}" must be a non-negative integer index`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new QaToolError(`qa_plan: plan["${key}"] must be a non-empty command string`);
    }
    mapping[index] = value;
  }
  return mapping;
}

export interface QaToolInfo {
  name: string;
  description: string;
  inputSpec: ToolInputSpec;
  handler: (ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

const OBJECT = { type: 'object', optional: false } as const;

/** `registerQaTools(protocol)` — one `QaToolInfo` array, same shape as `BUILTIN_TOOLS`, for the manager to splice into `ToolService`/`tools/builtins.ts` (see wiring note below). */
export function registerQaTools(protocol: QaProtocol): QaToolInfo[] {
  return [
    {
      name: 'qa_plan',
      description:
        'Map acceptance-criterion indices to the command/action that exercises each one from outside (§13).',
      inputSpec: { plan: OBJECT },
      handler: async (ctx, input) => {
        requireQaRole(ctx, 'qa_plan');
        const ticket = requireTicket(ctx, 'qa_plan');
        protocol.plan(ticket as TicketId, qaPlanInput(input));
        return { ok: true };
      },
    },
    {
      name: 'qa_run',
      description:
        'Execute every acceptance criterion via its planned command (one rerun on failure; a flaky pass files a KB fact).',
      inputSpec: {},
      handler: async (ctx) => {
        requireQaRole(ctx, 'qa_run');
        const ticket = requireTicket(ctx, 'qa_run');
        return protocol.run(ticket as TicketId);
      },
    },
    {
      name: 'qa_submit',
      description:
        'Assemble and file the QA report from the last qa_run, send the qa_verdict, and transition the ticket.',
      inputSpec: {},
      handler: async (ctx) => {
        requireQaRole(ctx, 'qa_submit');
        const ticket = requireTicket(ctx, 'qa_submit');
        return protocol.submit(ticket as TicketId, ctx.agent as AgentId);
      },
    },
  ];
}

/**
 * Wiring for the manager (this ticket does not own `tools/service.ts` or
 * `tools/builtins.ts`): `ToolService.callTool` (`tools/service.ts`) already
 * does `BUILTIN_TOOLS.find((t) => t.name === name)` before falling through
 * to the registry — the one-line addition is either (a) append
 * `registerQaTools(qaProtocol)`'s entries onto the `BUILTIN_TOOLS` array at
 * daemon construction (both are the same `{name, description, inputSpec,
 * handler}` shape, just with a `(deps, ctx, input)` vs. `(ctx, input)`
 * handler signature — trivial to bridge with `(deps, ctx, input) =>
 * qaTool.handler(ctx, input)`), or (b) give `ToolService` a second lookup
 * table (`this.qaTools = registerQaTools(qaProtocol)`) checked alongside
 * `BUILTIN_TOOLS` in `callTool`. Either way, `QaProtocol` needs to be
 * constructed once (with the daemon's `store`/`bus`/`repoRoot`) and handed
 * to both this function and `buildQaRpcMethods` (`rpc.ts`, same directory).
 */
