/**
 * `agile inbox` (T121) — everything waiting on the human, across every
 * stream, oldest first (cockpit design §3). One call to `inbox.list`, one
 * table: kind, stream path, age, context, id.
 */

import type { InboxItem } from '@agile-agents/shared';
import { callRpc } from '../client';
import { printJson, printTable } from '../format';

/** Coarse, human-readable age — the inbox is a queue, not a stopwatch. */
export function ageOf(ts: string, now: number = Date.now()): string {
  const ms = now - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export async function runInbox(socketPath: string, json: boolean): Promise<number> {
  const result = await callRpc<{ items: InboxItem[] }>(socketPath, 'inbox.list', {});
  if (json) {
    printJson(result);
    return 0;
  }
  if (result.items.length === 0) {
    console.log('inbox: (empty)');
    return 0;
  }
  printTable(
    ['kind', 'stream', 'age', 'context', 'id'],
    result.items.map((item) => [
      item.kind,
      item.stream_path.join(' / '),
      ageOf(item.ts),
      item.context,
      item.id,
    ]),
  );
  return 0;
}
