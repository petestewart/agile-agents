/**
 * Tails `log/events.jsonl` for the live `/ws` feed, handing each batch of
 * new complete lines to a callback. Polls (default 250 ms) rather than
 * `fs.watch`, whose behaviour varies by platform. Starts at the file's
 * current size (the snapshot covers history); a trailing partial line is
 * carried to the next poll, never dropped or mis-parsed.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export interface EventTailerOptions {
  /** The `events.jsonl` being tailed. */
  path: string;
  /** Every batch of new complete lines, parsed. */
  onEvents: (events: unknown[]) => void;
  /** A malformed line is skipped and reported here. */
  onError?: (err: Error) => void;
  /** Default 250ms. */
  pollIntervalMs?: number;
  /** Byte offset to resume from; default the current size (only future appends), `0` replays. */
  startOffset?: number;
}

export interface EventTailerHandle {
  /** Bytes consumed so far (excluding a carried partial line). */
  getOffset(): number;
  /** Stops the poll interval. Idempotent. */
  stop(): void;
  /** One poll cycle, synchronously (tests). */
  pollNow(): void;
}

function readRange(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const length = end - start;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function startEventTailer(options: EventTailerOptions): EventTailerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let offset = options.startOffset ?? (existsSync(options.path) ? statSync(options.path).size : 0);
  // Kept as bytes: a poll can end mid-character, and `getOffset` counts bytes.
  let carry: Buffer = Buffer.alloc(0);

  function pollNow(): void {
    if (!existsSync(options.path)) return;
    const size = statSync(options.path).size;
    if (size < offset) {
      // Truncated or rotated (append-only, so defensive): restart at the top.
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (size === offset) return;

    const chunk = readRange(options.path, offset, size);
    offset = size;

    const combined = Buffer.concat([carry, chunk]);
    const end = combined.lastIndexOf(0x0a) + 1;
    carry = combined.subarray(end);
    const lines = combined.subarray(0, end).toString('utf8').split('\n');

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
  // Never keep the process alive on its own.
  if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
    (interval as { unref(): void }).unref();
  }

  return {
    // A carried partial line is not consumed yet: it is re-read with its tail.
    getOffset: () => offset - carry.length,
    stop: () => clearInterval(interval),
    pollNow,
  };
}
