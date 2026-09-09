/**
 * Event tailer (T020 — design agile-agents-design.md §17 "Human UI": "Feed:
 * event log tailed live"). Watches `log/events.jsonl` for appended bytes and
 * hands whole new lines to a callback, parsed as JSON — the daemon-side half
 * of the feed page's live WebSocket updates.
 *
 * Poll-based (default every 250 ms) rather than `fs.watch`: `fs.watch`'s
 * behaviour (debouncing, missed events, one `rename` per platform's rules)
 * is exactly the kind of vendor-runtime unreliability
 * design/spike-findings.md warns against trusting without measuring, and a
 * 250 ms poll already clears the ticket's "within 1 s" acceptance criterion
 * with a wide margin, so polling is the simpler, more portable choice
 * (DESIGN-GAP: the ticket allows either).
 *
 * Byte-offset resume: starts at the file's current size (or `startOffset`,
 * for a caller that already knows where a previous tailer left off) so a
 * fresh tailer never re-emits history the snapshot already covered.
 * Partial-line tolerance: a poll's raw bytes are appended to an in-memory
 * `carry` buffer and split on `\n`; only complete lines are parsed and
 * emitted, and any trailing incomplete line is kept in `carry` for the next
 * poll rather than dropped or mis-parsed.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export interface EventTailerOptions {
  /** Absolute path to the `events.jsonl` file being tailed. */
  path: string;
  /** Called with every batch of new, fully-formed JSON lines parsed since the last poll. */
  onEvents: (events: unknown[]) => void;
  /** A line that fails `JSON.parse` is skipped and reported here instead of throwing. */
  onError?: (err: Error) => void;
  /** Default 250ms — see file header for why polling, not `fs.watch`. */
  pollIntervalMs?: number;
  /**
   * Byte offset to resume from. Defaults to the file's current size (i.e.
   * tail only *future* appends) — pass `0` to replay the whole file, or a
   * previous handle's `getOffset()` to resume exactly where it left off.
   */
  startOffset?: number;
}

export interface EventTailerHandle {
  /** Current byte offset already consumed (excludes any trailing partial line held in `carry`). */
  getOffset(): number;
  /** Stops the poll interval. Idempotent. */
  stop(): void;
  /** Runs one poll cycle synchronously right now — mainly for tests. */
  pollNow(): void;
}

function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, 'r');
  try {
    const length = end - start;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function startEventTailer(options: EventTailerOptions): EventTailerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let offset = options.startOffset ?? (existsSync(options.path) ? statSync(options.path).size : 0);
  let carry = '';

  function pollNow(): void {
    if (!existsSync(options.path)) return;
    const size = statSync(options.path).size;
    if (size < offset) {
      // Truncated or rotated out from under us (DESIGN-GAP: not specified —
      // `events.jsonl` is append-only per T005, so this is a defensive
      // fallback, not an expected path): restart from the top.
      offset = 0;
      carry = '';
    }
    if (size === offset) return;

    const chunk = readRange(options.path, offset, size);
    offset = size;

    const combined = carry + chunk;
    const lines = combined.split('\n');
    carry = lines.pop() ?? '';

    const parsed: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch (err) {
        options.onError?.(
          new Error(`event tailer: malformed line in ${options.path}: ${String(err)}`),
        );
      }
    }
    if (parsed.length > 0) options.onEvents(parsed);
  }

  const interval = setInterval(pollNow, pollIntervalMs);
  // Never keep the process alive on its own — a daemon shutting down
  // shouldn't wait on this timer.
  if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
    (interval as { unref(): void }).unref();
  }

  return {
    getOffset: () => offset,
    stop: () => clearInterval(interval),
    pollNow,
  };
}
