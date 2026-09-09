/**
 * `handoff.*` RPC methods (T024), same shape as `quota/rpc.ts`'s
 * `buildQuotaRpcMethods` — for wiring into `rpc.ts`'s `extraMethods` table.
 * Not wired into `daemon.ts`/`index.ts`/`rpc.ts` by this ticket (file
 * ownership boundary); see the pipeline report for the exact wiring line.
 *
 * Round 2 (QA round 1): unlike a verb (`verbs.ts`'s `cooldownSet`, gated by
 * `requireEm`/`requireEmOrHuman` on the `ToolCallContext` the MCP bridge
 * builds from the calling session's own agent id), a raw RPC method has no
 * caller identity of its own to check by default — `tool.call`'s own RPC
 * entry (`tools/rpc.ts`) is exactly why every other role-restricted
 * capability in this codebase is reached *through* `tool.call`/
 * `ToolService`, not a bespoke RPC method. `handoff.cooldown_set` is one
 * exception (built to mirror `quota/rpc.ts`'s ungated `quota.record_429`
 * shape) — so it takes the caller's `agent` id as an explicit param (same
 * pattern `tools/rpc.ts`'s `tool.call`/`tool.list` already use) and checks
 * its role itself, rather than trusting every socket client that can reach
 * the RPC port to be `em`.
 *
 * Round 3 (N-b): `handoff.tick` gained the same treatment. Executed
 * unchecked, it runs a full coordinator pass — stops sessions, reassigns
 * tickets, pauses others — for any client that can reach the socket, which
 * is a strictly bigger blast radius than `cooldown_set`'s single write.
 * Its allow-list is wider than `cooldown_set`'s (`em`/`human`/`daemon`,
 * not just `em`/`human`) because the daemon's own ceremony timer is
 * exactly who is expected to drive it every tick (see the pipeline
 * report's wiring section) — unlike `cooldown_set`, which no daemon-internal
 * code ever calls on its own initiative.
 */

import type { TicketId } from '@agile-agents/shared';
import { roleOf } from '../bus/routing';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';
import { type CooldownBusSender, CooldownError, setManualCooldown } from './cooldown';
import type { HandoffCoordinator } from './coordinator';

export class HandoffRpcError extends Error {}

export interface HandoffCooldownSetParams {
  /** Caller identity — checked against the same `em`/`human` allow-list `verbs.ts`'s `cooldownSet` enforces via `ToolCallContext`. */
  agent: string;
  vendor: string;
  account: string;
  until: string;
}

export interface HandoffTickParams {
  /** Caller identity — checked against `em`/`human`/`daemon` (round 3, N-b). */
  agent: string;
  sprintTicketIds?: TicketId[];
}

function requireRole(
  agent: unknown,
  method: string,
  allowed: readonly ReturnType<typeof roleOf>[],
): void {
  if (typeof agent !== 'string' || agent.length === 0) {
    throw new HandoffRpcError(`${method}: "agent" must be a non-empty string`);
  }
  const role = roleOf(agent);
  if (!allowed.includes(role)) {
    throw new HandoffRpcError(
      `${method}: only ${allowed.join('/')} may call this method (was ${role})`,
    );
  }
}

export function buildHandoffRpcMethods(
  coordinator: HandoffCoordinator,
  store: StateStore,
  /** Optional — threaded to `setManualCooldown` so `handoff.cooldown_set` also sends the urgent bus message (parity with `verbs.ts`'s `cooldownSet`), not only the event `HandoffCoordinator.tick()` reacts to. */
  bus?: CooldownBusSender,
): Record<string, RpcMethodHandler> {
  return {
    'handoff.tick': (params) => {
      const { agent, sprintTicketIds } = (params ?? {}) as Partial<HandoffTickParams>;
      requireRole(agent, 'handoff.tick', ['em', 'human', 'daemon']);
      return coordinator.tick(sprintTicketIds ?? store.listTickets().map((t) => t.id));
    },
    'handoff.cooldown_set': async (params) => {
      const { agent, vendor, account, until } = (params ?? {}) as Partial<HandoffCooldownSetParams>;
      requireRole(agent, 'handoff.cooldown_set', ['em', 'human']);
      if (typeof vendor !== 'string' || vendor.length === 0) {
        throw new HandoffRpcError('handoff.cooldown_set: "vendor" must be a non-empty string');
      }
      if (typeof account !== 'string' || account.length === 0) {
        throw new HandoffRpcError('handoff.cooldown_set: "account" must be a non-empty string');
      }
      if (typeof until !== 'string' || until.length === 0) {
        throw new HandoffRpcError('handoff.cooldown_set: "until" must be an ISO timestamp string');
      }
      try {
        return await setManualCooldown(store, { vendor, account, until, bus });
      } catch (err) {
        if (err instanceof CooldownError) throw new HandoffRpcError(err.message);
        throw err;
      }
    },
    'handoff.paused': () =>
      store
        .listTickets()
        .filter((t) => t.status === 'paused')
        .map((t) => ({ ticket: t.id, resume_at: t.resume_at })),
  };
}
