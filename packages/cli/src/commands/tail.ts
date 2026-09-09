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
 * unpredictably on some filesystems), while a byte-offset poll is simple,
 * correct even mid-write (a poll that lands mid-line just waits for the
 * next tick), and cheap at the sub-second interval a human is watching a
 * feed at.
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
    return undefined; // a partially-written line mid-poll; skip, it'll be whole next tick
  }
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

async function readAllLines(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split('\n');
}

export async function runTail(options: RunTailOptions): Promise<number> {
  const { eventsPath, filters, follow, json } = options;

  const emit = (event: Event) => {
    if (!matchesFilters(event, filters)) return;
    if (json) printJson(event);
    else printEventHuman(event);
  };

  let offset = 0;
  const initialLines = await readAllLines(eventsPath);
  for (const line of initialLines) {
    const event = parseEventLine(line);
    if (event) emit(event);
  }
  offset = existsSync(eventsPath) ? statSync(eventsPath).size : 0;

  if (!follow) return 0;

  const pollMs = options.pollMs ?? 200;
  while (!options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (options.signal?.aborted) break;
    if (!existsSync(eventsPath)) continue;

    const size = statSync(eventsPath).size;
    if (size <= offset) continue;

    // `Bun.file(...).slice(start, end)` reads a byte range without a
    // node:fs/promises file handle — deliberate: `packages/acp-client/src/
    // session.test.ts` replaces the whole `node:fs/promises` module for the
    // process via `mock.module` (Bun's module mocks are process-global, not
    // per-file) and only re-exports `readFile`/`writeFile`/`realpath`, so
    // anything from that module imported here breaks under the full `bun
    // test` run despite passing in isolation. Bun's own file API sidesteps
    // that collision entirely.
    const appended = await Bun.file(eventsPath).slice(offset, size).text();
    offset = size;
    for (const line of appended.split('\n')) {
      const event = parseEventLine(line);
      if (event) emit(event);
    }
  }

  return 0;
}
