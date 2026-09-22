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
import { RpcConnectionError, callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';
import { type DaemonStatusReport, daemonStatusReport, formatDaemonStatus } from './daemon';
import { STREAM_HEADERS, type StreamNode, streamRows } from './stream';

export interface StatusResult {
  daemon: DaemonStatus;
  /** Open questions (`questions/` in the state home). */
  questions: Question[];
  /** Pending gates (`gates/` in the state home). */
  gates: HilRequest[];
  /** Streams as `stream.list` returns them (archived excluded); `inFlight` narrows them for the human view (T128). */
  streams: StreamNode[];
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

/**
 * In flight = the human still has it: `open` or `waiting_on_you`. `closed`
 * and `landed` are done, and archived never comes back from `stream.list`
 * (§7.2). A dropped node's children are promoted, so an open child under a
 * closed parent is still listed.
 */
export function inFlight(nodes: StreamNode[]): StreamNode[] {
  const kept: StreamNode[] = [];
  for (const node of nodes) {
    const children = inFlight(node.children);
    const status = node.stream.human.status;
    if (status === 'open' || status === 'waiting_on_you') kept.push({ ...node, children });
    else kept.push(...children);
  }
  return kept;
}

/** `stream.list` without `include_archived`: archived streams stay hidden (§7.2). */
async function fetchStreams(socketPath: string): Promise<StreamNode[]> {
  try {
    return (await callRpc<{ tree: StreamNode[] }>(socketPath, 'stream.list', {})).tree;
  } catch {
    return [];
  }
}

export async function fetchStatus(socketPath: string): Promise<StatusResult> {
  const daemon = await callRpc<DaemonStatus>(socketPath, 'daemon.status');
  const questions = await fetchOrEmpty<Question>(socketPath, 'question.list', { open: true });
  const gates = await fetchOrEmpty<HilRequest>(socketPath, 'gate.list');
  const streams = await fetchStreams(socketPath);
  return { daemon, questions, gates, streams };
}

export function printStatusHuman(status: StatusResult): void {
  const pending = status.gates.filter((g) => g.status === 'pending');
  printFields([
    [
      'daemon',
      `pid=${status.daemon.pid} version=${status.daemon.version} uptime=${status.daemon.uptime.toFixed(1)}s`,
    ],
    ['state', status.daemon.stateRoot],
  ]);
  // T128: what is in flight, between the daemon block and the needs-you
  // count — the same `id title agent/human` shape as `agile stream list`.
  const rows = streamRows(inFlight(status.streams));
  if (rows.length === 0) {
    console.log('streams: (none open)');
  } else {
    console.log(`streams (${rows.length}):`);
    printTable(
      STREAM_HEADERS.map((h) => `  ${h}`),
      rows.map((r) => [`  ${r[0] ?? ''}`, ...r.slice(1)]),
    );
  }
  printFields([['needs you', String(pending.length + status.questions.length)]]);
  console.log('');

  if (pending.length === 0) {
    console.log('gates: (none open)');
  } else {
    printTable(
      ['id', 'kind', 'owner', 'summary'],
      pending.map((g) => [g.id, g.hil_kind, g.owner, g.summary ?? '-']),
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

/**
 * A dead daemon is not an error to spill: `agile status` used to print the
 * raw `could not reach daemon at <sock>: connect ENOENT ...` while `agile
 * daemon status` said `agiled is not running` (after the home line) for the same fact
 * (T126, QA rough edge 3). Both now say the same sentence, from the same
 * formatter, and exit 1.
 */
export async function runStatus(socketPath: string, json: boolean): Promise<number> {
  let status: StatusResult;
  try {
    status = await fetchStatus(socketPath);
  } catch (err) {
    if (!(err instanceof RpcConnectionError)) throw err;
    // Drop any pid: the socket is unreachable, so whatever the pidfile
    // claims, there is no daemon answering here.
    const { pid: _pid, ...paths } = daemonStatusReport();
    const report: DaemonStatusReport = { ...paths, running: false };
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.error(formatDaemonStatus(report));
    return 1;
  }
  if (json) printJson(status);
  else printStatusHuman(status);
  return 0;
}
