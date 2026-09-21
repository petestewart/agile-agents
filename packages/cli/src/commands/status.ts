/**
 * `agile status` — the daemon, the streams, and what is waiting on you.
 *
 * T122 deleted the sprint strip, the ticket table, the halt list and the
 * vendor barometer with the subsystems behind them; what is left is the
 * `daemon.status` read plus the two things the cockpit's Needs-you count is
 * built from (`question.list`, `gate.list`).
 */

import type { DaemonStatus } from '@agile-agents/daemon';
import type { HilRequest, Question } from '@agile-agents/shared';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

export interface StatusResult {
  daemon: DaemonStatus;
  /** Open questions (`questions/` in the state home). */
  questions: Question[];
  /** Pending gates (`gates/` in the state home). */
  gates: HilRequest[];
}

/** Degrade, don't throw: a daemon started before `agile init` keeps `agile status` working. */
async function fetchOrEmpty<T>(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  try {
    return await callRpc<T[]>(socketPath, method, params);
  } catch {
    return [];
  }
}

export async function fetchStatus(socketPath: string): Promise<StatusResult> {
  const daemon = await callRpc<DaemonStatus>(socketPath, 'daemon.status');
  const questions = await fetchOrEmpty<Question>(socketPath, 'question.list', { open: true });
  const gates = await fetchOrEmpty<HilRequest>(socketPath, 'gate.list');
  return { daemon, questions, gates };
}

export function printStatusHuman(status: StatusResult): void {
  const pending = status.gates.filter((g) => g.status === 'pending');
  printFields([
    [
      'daemon',
      `pid=${status.daemon.pid} version=${status.daemon.version} uptime=${status.daemon.uptime.toFixed(1)}s`,
    ],
    ['state', status.daemon.stateRoot],
    ['needs you', String(pending.length + status.questions.length)],
  ]);
  console.log('');

  if (pending.length === 0) {
    console.log('gates: (none open)');
  } else {
    printTable(
      ['id', 'kind', 'owner', 'summary'],
      pending.map((g) => [g.id, g.hil_kind, g.owner, g.summary]),
    );
  }
  console.log('');

  if (status.questions.length === 0) {
    console.log('open questions: (none)');
  } else {
    printTable(
      ['id', 'raised_by', 'stream', 'question'],
      status.questions.map((q) => [q.id, q.raised_by, q.stream, q.text]),
    );
  }
}

export async function runStatus(socketPath: string, json: boolean): Promise<number> {
  const status = await fetchStatus(socketPath);
  if (json) printJson(status);
  else printStatusHuman(status);
  return 0;
}
