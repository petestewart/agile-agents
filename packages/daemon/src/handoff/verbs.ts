/**
 * `handoff.*` MCP verbs (T024), same `ToolService.registerProvider` shape
 * `em/verbs.ts`/`qa/tools.ts` already use — a sibling registry, not an edit
 * to either (this ticket owns `handoff/**` only). `em`-only: cooldowns and
 * handoff visibility are an EM/operator concern (design §10), never
 * something an engineer/reviewer/qa session calls on itself.
 */

import { roleOf } from '../bus/routing';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';
import type { ToolInputSpec } from '../tools/schema';
import type { ToolCallContext } from '../tools/types';
import { CooldownError, setManualCooldown } from './cooldown';

export class HandoffVerbError extends Error {}

function requireEm(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'em') {
    throw new HandoffVerbError(`${verb}: only the em agent may call this verb`);
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
}

export interface HandoffToolInfo {
  name: string;
  description: string;
  inputSpec: ToolInputSpec;
  handler: (deps: HandoffToolDeps, ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

const STRING = { type: 'string', optional: false } as const;

async function cooldownSet(deps: HandoffToolDeps, ctx: ToolCallContext, input: unknown) {
  requireEm(ctx, 'cooldown_set');
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
