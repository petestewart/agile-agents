/**
 * Bounded in-memory ring of ACP protocol events for one agent session, plus
 * the wire decoder for events arriving off `spawnSession(...).on(...)`.
 *
 * Provenance: the ring is lifted from Terma
 * (vendor/terma/src/main/terminal-host/acp-event-log.ts, `AcpEventLog`,
 * renamed `EventLog`); the decoder from
 * vendor/terma/src/main/lib/terminal-host/acp-events.ts
 * (`parseAcpEvent`). Adapted only in naming — the ring logic itself is
 * behaviour Terma's tests already pinned, so it is ported unchanged.
 *
 * **In memory only, deliberately.** A store that persisted this ring and
 * replayed it back would double every event a `session/load` re-emits (the
 * agent re-sends its whole conversation on load) — see `beginReplace`.
 * Losing it on process restart is recoverable: the bridge persists sessions
 * in its own store and replays the full conversation on `session/load`.
 *
 * Two properties it guarantees:
 *
 * 1. **No notification loss across a detach window.** A caller that has not
 *    yet registered a listener still has every event recorded, and gets them
 *    on `replay()` once it does.
 * 2. **Loss is never silent.** Truncation is bounded by a count cap and a
 *    size budget — one ACP frame can carry a whole file, where a scrollback
 *    entry is one line, so a count cap alone is not a real bound. Both caps
 *    are exact: trimming runs on every append. The count of dropped events is
 *    surfaced through `replay()`.
 */
import type { AcpEvent, AcpJsonRpcMessage, AcpReplay, Sequenced, WireAcpEvent } from './types';

export const DEFAULT_MAX_EVENT_LOG_ENTRIES = 2000;
export const DEFAULT_MAX_EVENT_LOG_CHARS = 4 * 1024 * 1024;

/** A complete ring state, parked while a replacement is staged. */
interface ParkedRing<T> {
  entries: Sequenced<T>[];
  sizes: number[];
  size: number;
  dropped: number;
  gen: number;
}

export class EventLog<T extends object> {
  private entries: Sequenced<T>[] = [];
  /** Serialized size of each entry, parallel to `entries`. */
  private sizes: number[] = [];
  private size = 0;
  private dropped = 0;
  private nextSeq = 1;
  /**
   * Generation of the timeline being appended into. Bumped when a
   * replacement is staged, so staged events are distinguishable from the
   * ones they replace even before the swap is committed.
   */
  private gen = 1;
  /** Non-null while a replacement is staged; what `replay()` serves meanwhile. */
  private parked: ParkedRing<T> | null = null;

  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(
    maxEntries: number = DEFAULT_MAX_EVENT_LOG_ENTRIES,
    maxChars: number = DEFAULT_MAX_EVENT_LOG_CHARS,
  ) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxChars = Math.max(1, maxChars);
  }

  /**
   * Record one event and return it with its sequence number attached.
   *
   * Callers forward the returned object to live listeners, so the live
   * stream and a later replay share one sequence space and de-duplicate
   * exactly (`seq <= lastReplayed`).
   */
  append(event: T): Sequenced<T> {
    const entry: Sequenced<T> = { ...event, seq: this.nextSeq++, gen: this.gen };
    const line = JSON.stringify(entry);

    this.entries.push(entry);
    this.sizes.push(line.length);
    this.size += line.length;
    this.trim();

    return entry;
  }

  /**
   * Current timeline, with the dropped-event count a caller must surface.
   * While a replacement is staged this serves the parked timeline, so a
   * reader never observes the half-built one.
   */
  replay(): AcpReplay<T> {
    const ring = this.parked;
    return ring === null
      ? { events: [...this.entries], dropped: this.dropped, generation: this.gen }
      : { events: [...ring.entries], dropped: ring.dropped, generation: ring.gen };
  }

  /**
   * Discard the timeline, keeping the sequence space monotonic so a caller
   * that already saw earlier events can still tell old frames from new ones.
   */
  reset(): void {
    this.gen += 1;
    this.parked = null;
    this.entries = [];
    this.sizes = [];
    this.size = 0;
    this.dropped = 0;
  }

  /**
   * Begin replacing the timeline: park the current one and start recording
   * into a fresh ring, while `replay()` keeps serving the parked timeline
   * until the replacement is committed.
   *
   * This exists for `session/load`, where the agent re-emits the entire
   * conversation as ordinary notifications. Resetting outright would be
   * wrong three ways: two overlapping loads would each reset an empty ring
   * and both append into it (doubling); a load that *fails* would leave the
   * timeline destroyed; a reader during the window would see an empty
   * timeline. Staging makes the swap atomic from a reader's point of view.
   */
  beginReplace(): void {
    // Nested begins keep the *original* timeline parked: that is the one a
    // reader should still see, and the one an abort must restore.
    if (this.parked === null) {
      this.parked = {
        entries: this.entries,
        sizes: this.sizes,
        size: this.size,
        dropped: this.dropped,
        gen: this.gen,
      };
    }
    // Bump before staging, not on commit: events appended into the staged
    // ring are emitted live immediately, and a listener must be able to tell
    // them from the timeline they are replacing at the moment it receives
    // them, not retroactively once the load resolves.
    this.gen += 1;
    this.entries = [];
    this.sizes = [];
    this.size = 0;
    this.dropped = 0;
  }

  /** Promote the staged timeline to the live one. */
  commitReplace(): void {
    this.parked = null;
  }

  /** Discard the staged timeline and restore the one parked by `beginReplace`. */
  abortReplace(): void {
    if (this.parked === null) return;
    this.entries = this.parked.entries;
    this.sizes = this.parked.sizes;
    this.size = this.parked.size;
    this.dropped = this.parked.dropped;
    this.gen = this.parked.gen;
    this.parked = null;
  }

  /**
   * Drop entries from the head until both caps are satisfied. Always leaves
   * at least the newest entry, so one oversized frame truncates the history
   * rather than looping forever on itself.
   */
  private trim(): void {
    let drop = 0;
    while (
      this.entries.length - drop > this.maxEntries ||
      (this.size > this.maxChars && this.entries.length - drop > 1)
    ) {
      this.size -= this.sizes[drop] as number;
      drop++;
    }
    if (drop === 0) return;
    this.dropped += drop;
    this.entries = this.entries.slice(drop);
    this.sizes = this.sizes.slice(drop);
  }
}

/**
 * Parse one JSONL line off the agent's stdout into a `WireAcpEvent`. Returns
 * null for anything that is not a well-formed envelope, so a malformed or
 * future-shaped frame is dropped rather than crashing the caller.
 */
export function parseAcpEvent(data: string): WireAcpEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  const seq = typeof event.seq === 'number' ? { seq: event.seq } : {};
  const gen = typeof event.gen === 'number' ? { gen: event.gen } : {};
  switch (event.acp) {
    case 'initialized':
      return { acp: 'initialized', result: event.result, ...seq, ...gen };
    case 'notification':
      if (typeof event.message !== 'object' || event.message === null) return null;
      return {
        acp: 'notification',
        message: event.message as AcpJsonRpcMessage,
        ...seq,
        ...gen,
      };
    case 'request':
      if (typeof event.id !== 'number' && typeof event.id !== 'string') return null;
      if (typeof event.method !== 'string') return null;
      return {
        acp: 'request',
        id: event.id,
        method: event.method,
        params: event.params,
        ...seq,
        ...gen,
      };
    case 'truncated':
      if (typeof event.dropped !== 'number') return null;
      return { acp: 'truncated', dropped: event.dropped, ...seq, ...gen };
    default:
      return null;
  }
}

export type { AcpEvent, AcpReplay, Sequenced, WireAcpEvent };
