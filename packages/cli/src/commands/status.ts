/**
 * `agile status` — sprint/tickets/agents/spend (T008 scope line).
 *
 * Only `daemon.status` and `state.ticket_list` are real RPC methods today
 * (`packages/daemon/src/store/rpc-methods.ts`'s comment: "Only the two
 * simplest read paths are wired here"). There is no `state.sprint_get`,
 * `state.agent_list`, or ledger/spend RPC yet, and this ticket's file
 * ownership excludes `packages/daemon/**` — adding one is out of scope (see
 * the session's file-ownership note). So `agents` and `spend` are reported
 * as `n/a (no RPC yet)` rather than invented; `sprint` is read off whichever
 * ticket carries a `sprint` field, best-effort, since there's no direct
 * sprint RPC either.
 *
 * DESIGN-GAP: §17 "Sprint strip" names goal/burn/halt-count/barometer as
 * status-worthy; none of that is reachable without daemon RPC this ticket
 * cannot add. Tracked in the pipeline report for whoever wires
 * `state.sprint_get` / an agents/ledger RPC next.
 */

import type { DaemonStatus } from '@agile-agents/daemon';
import type { Ticket } from '@agile-agents/shared';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

export interface StatusResult {
  daemon: DaemonStatus;
  tickets: Ticket[];
  agents: 'n/a (no RPC yet)';
  spend: 'n/a (no RPC yet)';
}

export async function fetchStatus(socketPath: string): Promise<StatusResult> {
  const daemon = await callRpc<DaemonStatus>(socketPath, 'daemon.status');
  const tickets = await callRpc<Ticket[]>(socketPath, 'state.ticket_list');
  return { daemon, tickets, agents: 'n/a (no RPC yet)', spend: 'n/a (no RPC yet)' };
}

export function printStatusHuman(status: StatusResult): void {
  printFields([
    [
      'daemon',
      `pid=${status.daemon.pid} version=${status.daemon.version} uptime=${status.daemon.uptime.toFixed(1)}s`,
    ],
    ['state', status.daemon.stateRoot],
    ['agents', status.agents],
    ['spend', status.spend],
  ]);
  console.log('');
  if (status.tickets.length === 0) {
    console.log('tickets: (none)');
    return;
  }
  printTable(
    ['id', 'status', 'sprint', 'assignee', 'title'],
    status.tickets.map((t) => [t.id, t.status, t.sprint ?? '-', t.assignee ?? '-', t.title]),
  );
}

export async function runStatus(socketPath: string, json: boolean): Promise<number> {
  const status = await fetchStatus(socketPath);
  if (json) printJson(status);
  else printStatusHuman(status);
  return 0;
}
