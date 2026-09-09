/**
 * `handoff.*` RPC methods (T024), same shape as `quota/rpc.ts`'s
 * `buildQuotaRpcMethods` — for wiring into `rpc.ts`'s `extraMethods` table.
 * Not wired into `daemon.ts`/`index.ts`/`rpc.ts` by this ticket (file
 * ownership boundary); see the pipeline report for the exact wiring line.
 */

import type { TicketId } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';
import type { HandoffCoordinator } from './coordinator';
import { CooldownError, setManualCooldown } from './cooldown';

export interface HandoffCooldownSetParams {
  vendor: string;
  account: string;
  until: string;
}

export interface HandoffTickParams {
  sprintTicketIds?: TicketId[];
}

export function buildHandoffRpcMethods(
  coordinator: HandoffCoordinator,
  store: StateStore,
): Record<string, RpcMethodHandler> {
  return {
    'handoff.tick': (params) => {
      const { sprintTicketIds } = (params ?? {}) as HandoffTickParams;
      return coordinator.tick(sprintTicketIds ?? store.listTickets().map((t) => t.id));
    },
    'handoff.cooldown_set': async (params) => {
      const { vendor, account, until } = params as HandoffCooldownSetParams;
      try {
        return await setManualCooldown(store, { vendor, account, until });
      } catch (err) {
        if (err instanceof CooldownError) throw new Error(err.message);
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
