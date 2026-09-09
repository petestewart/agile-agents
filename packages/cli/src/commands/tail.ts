/**
 * `agile tail` — reads `.agile/log/events.jsonl` directly off disk (T008
 * scope: "reads the event log, follow, filters by ticket/agent/kind"). No
 * RPC round trip: the log is the daemon's own append-only audit file
 * (`packages/daemon/src/store/store.ts`'s `log/events.jsonl`), readable by
 * any process with filesystem access to `.agile/`, same as `git log` on the
 * agile-state branch — same pattern the design's "Feed" panel (§17) uses.
 *
 * `--follow` polls the file's size/mtime rather than `fs.watch`: `fs.watch`
 * behaves inconsistently across platforms for append-only writers (fires
 * once per underlying write syscall, which can coalesce or split lines
 * unpredictably on some filesystems), while a byte-offset poll is simple
 * and cheap at the sub-second interval a human is watching a feed at.
 *
 * A poll landing mid-line (the writer's `appendFileSync` hasn't flushed a
 * trailing `\n` yet) must *defer* the partial line, not drop it: `offset`
 * only ever advances past the last complete `\n` seen so far, and any
 * trailing fragment is held in `carry` and re-prefixed onto the next read.
 * (Review fix: an earlier version advanced `offset` to the full read size
 * regardless, which drops a line torn across two polls instead of
 * completing it on the next one, contradicting this file's own original
 * claim that a mid-line poll "just waits for the next tick".)
 */

import { existsSync, statSync } from 'node:fs';
import type { Event } from '@agile-agents/shared';
import { printJson } from '../format';

export interface TailFilters {
  ticket?: string;
  agent?: string;
  kind?: string;
}

function matchesFilters(event: Event, filters: TailFilters): boolean {
  if (filters.ticket && event.ticket !== filters.ticket) return false;
  if (filters.agent && event.agent !== filters.agent) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  return true;
}

function parseEventLine(line: string): Event | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as Event;
  } catch {
    // `splitComplete` below only ever hands this a line it already
    // considers newline-terminated and complete, so a parse failure here
    // means genuinely malformed JSON on disk, not a torn mid-poll read —
    // skip it rather than crash the whole tail over one bad line.
    return undefined;
  }
}

/**
 * Splits `carry + chunk` on `\n` into complete lines plus a leftover
 * fragment. The fragment is never parsed or emitted — it is handed back to
 * the caller to prepend to whatever the *next* read brings in, so a line
 * torn across two polls (the writer's `appendFileSync` landing between two
 * stat calls) is deferred, not dropped or mis-parsed as garbage.
 */
export function splitComplete(carry: string, chunk: string): { complete: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split('\n');
  // A trailing `\n` makes `split` emit a final empty string — not a
  // fragment — so `complete` is always `parts` minus its last element,
  // and that last element (empty or not) is the new carry either way.
  return { complete: parts.slice(0, -1), carry: parts[parts.length - 1] ?? '' };
}

function printEventHuman(event: Event): void {
  const scope = [event.ticket, event.agent].filter(Boolean).join(' ');
  const data = Object.keys(event.data ?? {}).length > 0 ? ` ${JSON.stringify(event.data)}` : '';
  console.log(`${event.ts} ${event.kind}${scope ? ` [${scope}]` : ''}${data}`);
}

export interface RunTailOptions {
  eventsPath: string;
  filters: TailFilters;
  follow: boolean;
  json: boolean;
  /** Poll interval in ms for `--follow`. Test hook; default 200ms. */
  pollMs?: number;
  /** Stop condition for tests — checked each poll tick when following. */
  signal?: AbortSignal;
}

/**
 * Reads the bytes of `path` from `readSize` up to its *current* size and
 * returns both the text and that current size — the single source of truth
 * for how far `offset` has advanced. Deliberately one `statSync` call whose
 * result is used for both the slice's end and the caller's next offset:
 * the original implementation `stat`ed once to slice and read, then
 * `stat`ed again afterward to set `offset`, so a line appended in the gap
 * between those two calls was counted into `offset` (because it landed
 * before the second stat) without ever being read or emitted — a silent
 * drop, not a deferral. One stat, reused for both, closes that race.
 *
 * `Bun.file(...).slice(start, end).text()` reads the byte range without a
 * `node:fs/promises` file handle — deliberate: `packages/acp-client/src/
 * session.test.ts` replaces the whole `node:fs/promises` module for the
 * process via `mock.module` (Bun's module mocks are process-global, not
 * per-file) and only re-exports `readFile`/`writeFile`/`realpath`, so
 * anything else imported from that module breaks under the full `bun test`
 * run despite passing in isolation. Bun's own file API sidesteps that
 * collision entirely.
 */
async function readFrom(path: string, readSize: number): Promise<{ text: string; size: number }> {
  if (!existsSync(path)) return { text: '', size: readSize };
  const size = statSync(path).size;
  if (size <= readSize) return { text: '', size };
  const text = await Bun.file(path).slice(readSize, size).text();
  return { text, size };
}

export async function runTail(options: RunTailOptions): Promise<number> {
  const { eventsPath, filters, follow, json } = options;

  const emit = (event: Event) => {
    if (!matchesFilters(event, filters)) return;
    if (json) printJson(event);
    else printEventHuman(event);
  };

  let carry = '';
  let offset = 0;

  const consume = (text: string) => {
    const result = splitComplete(carry, text);
    carry = result.carry;
    for (const line of result.complete) {
      const event = parseEventLine(line);
      if (event) emit(event);
    }
  };

  const initial = await readFrom(eventsPath, 0);
  consume(initial.text);
  offset = initial.size;

  if (!follow) return 0;

  const pollMs = options.pollMs ?? 200;
  while (!options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (options.signal?.aborted) break;

    const next = await readFrom(eventsPath, offset);
    if (next.size === offset) continue; // nothing new this tick
    consume(next.text);
    offset = next.size;
  }

  return 0;
}
