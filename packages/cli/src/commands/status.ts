/**
 * `agile status` — sprint/tickets/agents/spend (T008 scope line).
 *
 * Only `daemon.status`, `state.ticket_list`, and (T007) `state.halt_list`
 * are real RPC methods today (`packages/daemon/src/store/rpc-methods.ts`'s
 * comment: "Only the two simplest read paths are wired here" — halts are
 * wired separately in `packages/daemon/src/halts/index.ts`'s
 * `buildHaltRpcMethods`). There is no `state.sprint_get`, `state.agent_list`,
 * or ledger RPC yet, and this ticket's file ownership excludes
 * `packages/daemon/**` — adding one is out of scope (see the session's
 * file-ownership note). So `agents` is still reported as `n/a (no RPC
 * yet)`; `sprint` is read off whichever ticket carries a `sprint` field,
 * best-effort, since there's no direct sprint RPC either.
 *
 * Review fix (independent review nit 1): active halts are now included —
 * `state.halt_list` costs nothing extra (no daemon change) and is the only
 * discovery path for a halt id short of `agile tail`, which `agile resume
 * <halt-id>` needs.
 *
 * T023: `spend` is now a real Quota/Spend section via `quota.list`
 * (`packages/daemon/src/quota/rpc.ts`'s `buildQuotaRpcMethods`, T023's
 * `QuotaService`), replacing the `n/a` placeholder — §17 "Sprint strip"
 * names this as status-worthy ("the vendor barometer — per-vendor gauge,
 * resets-in, confidence dot"). `quota.list` is not wired into the running
 * daemon by this ticket (file-ownership boundary excludes
 * `packages/daemon/{daemon,index}.ts`), so `fetchStatus` degrades to the
 * same `'n/a (no RPC yet)'` string whenever the call fails (method not
 * found against a daemon that hasn't been wired up yet) rather than
 * throwing — `agile status` must keep working against today's daemon.
 */

import type { DaemonStatus } from '@agile-agents/daemon';
import type { Halt, Question, Ticket } from '@agile-agents/shared';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

/** Shape of one `quota.list` entry (`packages/daemon/src/quota/records.ts`'s `Quota`, `@agile-agents/shared`). */
export interface StatusQuotaEntry {
  vendor: string;
  account: string;
  remaining: number;
  unit: string;
  limit?: number;
  confidence: string;
  cooldown_until: string | null;
  spend_usd?: number;
}

export interface StatusResult {
  daemon: DaemonStatus;
  tickets: Ticket[];
  halts: Halt[];
  agents: 'n/a (no RPC yet)';
  spend: StatusQuotaEntry[] | 'n/a (no RPC yet)';
  /** T040: the open questions (`board/questions/`) — "`agile status` lists open questions" (ticket scope). */
  questions: Question[];
}

async function fetchQuota(socketPath: string): Promise<StatusQuotaEntry[] | 'n/a (no RPC yet)'> {
  try {
    return await callRpc<StatusQuotaEntry[]>(socketPath, 'quota.list');
  } catch {
    return 'n/a (no RPC yet)';
  }
}

/** Same degrade-don't-throw rule as `fetchQuota`: a daemon without the T040 questions store keeps `agile status` working. */
async function fetchOpenQuestions(socketPath: string): Promise<Question[]> {
  try {
    return await callRpc<Question[]>(socketPath, 'question.list', { open: true });
  } catch {
    return [];
  }
}

export async function fetchStatus(socketPath: string): Promise<StatusResult> {
  const daemon = await callRpc<DaemonStatus>(socketPath, 'daemon.status');
  const tickets = await callRpc<Ticket[]>(socketPath, 'state.ticket_list');
  const halts = await callRpc<Halt[]>(socketPath, 'state.halt_list');
  const spend = await fetchQuota(socketPath);
  const questions = await fetchOpenQuestions(socketPath);
  return { daemon, tickets, halts, agents: 'n/a (no RPC yet)', spend, questions };
}

function quotaFractionOf(entry: StatusQuotaEntry): number {
  if (entry.limit !== undefined && entry.limit > 0) {
    return Math.max(0, Math.min(1, entry.remaining / entry.limit));
  }
  return entry.remaining;
}

export function printStatusHuman(status: StatusResult): void {
  printFields([
    [
      'daemon',
      `pid=${status.daemon.pid} version=${status.daemon.version} uptime=${status.daemon.uptime.toFixed(1)}s`,
    ],
    ['state', status.daemon.stateRoot],
    ['agents', status.agents],
  ]);
  console.log('');

  if (status.spend === 'n/a (no RPC yet)') {
    console.log('spend: n/a (no RPC yet)');
  } else if (status.spend.length === 0) {
    console.log('spend: (no accounts configured)');
  } else {
    printTable(
      ['vendor', 'account', 'remaining', 'confidence', 'cooldown', 'spend_usd'],
      status.spend.map((q) => [
        q.vendor,
        q.account,
        `${(quotaFractionOf(q) * 100).toFixed(0)}%`,
        q.confidence,
        q.cooldown_until ?? '-',
        q.spend_usd !== undefined ? q.spend_usd.toFixed(2) : '-',
      ]),
    );
  }
  console.log('');

  if (status.halts.length === 0) {
    console.log('halts: (none)');
  } else {
    printTable(
      ['id', 'scope', 'quorum', 'reason'],
      status.halts.map((h) => [h.id, JSON.stringify(h.scope), h.quorum, h.reason]),
    );
  }
  console.log('');

  if (status.questions.length === 0) {
    console.log('open questions: (none)');
  } else {
    printTable(
      ['id', 'raised_by', 'ticket', 'question'],
      status.questions.map((q) => [q.id, q.raised_by, q.ticket ?? '-', q.text]),
    );
  }
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
