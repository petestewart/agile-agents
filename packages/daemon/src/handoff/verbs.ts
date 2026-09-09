/**
 * `handoff.*` MCP verbs (T024), same `ToolService.registerProvider` shape
 * `em/verbs.ts`/`qa/tools.ts` already use — a sibling registry, not an edit
 * to either (this ticket owns `handoff/**` only). Handoff visibility
 * (`handoff_status`) is `em`-only — an EM/operator concern (design §10),
 * never something an engineer/reviewer/qa session calls on itself.
 *
 * `cooldown_set` is `em` **or** `human` (round 3 review-fix, N-a — round 2
 * left it `em`-only here while `rpc.ts`'s `handoff.cooldown_set` allowed
 * both and claimed parity with this file; that claim was false). Widened
 * rather than narrowing the RPC side: §10's own framing of a manual
 * cooldown is a human request ("keep my Max window free for 4h"), and §5
 * "HIL" already treats `human` as a first-class bus participant. No MCP
 * session today is ever launched with agent id `human` (`agile mcp --agent
 * <id> --ticket <id>` only spawns `em`/`architect`/`eng-*`/`reviewer-*`/
 * `qa-*`), so this is presently unreachable in practice — kept anyway so
 * the policy is genuinely the same on both surfaces, not merely documented
 * as such.
 */

import { roleOf } from '../bus/routing';
import type { StateStore } from '../store';
import type { ToolInputSpec } from '../tools/schema';
import type { ToolCallContext } from '../tools/types';
import { type CooldownBusSender, CooldownError, setManualCooldown } from './cooldown';

export class HandoffVerbError extends Error {}

function requireEm(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'em') {
    throw new HandoffVerbError(`${verb}: only the em agent may call this verb`);
  }
}

function requireEmOrHuman(ctx: ToolCallContext, verb: string): void {
  const role = roleOf(ctx.agent);
  if (role !== 'em' && role !== 'human') {
    throw new HandoffVerbError(`${verb}: only em or human may call this verb (was ${role})`);
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HandoffVerbError('input must be an object');
  }
  return input as Record<string, unknown>;
}

export interface HandoffToolDeps {
  store: StateStore;
  /** Round 2 (opus B3): threaded to `setManualCooldown` so `cooldown_set` also sends the urgent bus message, not only the event. Optional — a caller with no `Bus` handy (a test) still gets the event, just not the message. */
  bus?: CooldownBusSender;
}

export interface HandoffToolInfo {
  name: string;
  description: string;
  inputSpec: ToolInputSpec;
  handler: (deps: HandoffToolDeps, ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

const STRING = { type: 'string', optional: false } as const;

async function cooldownSet(deps: HandoffToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEmOrHuman(ctx, 'cooldown_set');
  const p = requireObject(input);
  if (typeof p.vendor !== 'string' || p.vendor.length === 0) {
    throw new HandoffVerbError('cooldown_set: "vendor" must be a non-empty string');
  }
  if (typeof p.account !== 'string' || p.account.length === 0) {
    throw new HandoffVerbError('cooldown_set: "account" must be a non-empty string');
  }
  if (typeof p.until !== 'string' || p.until.length === 0) {
    throw new HandoffVerbError('cooldown_set: "until" must be an ISO timestamp string');
  }
  try {
    return await setManualCooldown(deps.store, {
      vendor: p.vendor,
      account: p.account,
      until: p.until,
      bus: deps.bus,
    });
  } catch (err) {
    if (err instanceof CooldownError) throw new HandoffVerbError(err.message);
    throw err;
  }
}

async function handoffStatus(deps: HandoffToolDeps, ctx: ToolCallContext) {
  requireEm(ctx, 'handoff_status');
  const paused = deps.store.listTickets().filter((t) => t.status === 'paused');
  return {
    paused: paused.map((t) => ({ ticket: t.id, resume_at: t.resume_at })),
  };
}

export const HANDOFF_TOOLS: readonly HandoffToolInfo[] = [
  {
    name: 'cooldown_set',
    description:
      'Manually cool down a vendor account until an ISO timestamp — triggers the same handoff path as a 429 (§10).',
    inputSpec: { vendor: STRING, account: STRING, until: STRING },
    handler: cooldownSet,
  },
  {
    name: 'handoff_status',
    description:
      'List tickets currently paused for lack of a quota candidate, with their resume_at.',
    inputSpec: {},
    handler: handoffStatus,
  },
];

export function registerHandoffTools(): readonly HandoffToolInfo[] {
  return HANDOFF_TOOLS;
}
