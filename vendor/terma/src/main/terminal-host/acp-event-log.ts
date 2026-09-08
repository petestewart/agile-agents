import {
  ACP_MAX_EVENT_LOG_ENTRIES,
  ACP_MAX_EVENT_LOG_CHARS,
} from "../../shared/constants";

/**
 * Bounded in-memory ring of ACP protocol events for one agent session, so a
 * pane can paint its timeline immediately on attach.
 *
 * **In memory only, deliberately.** An earlier cut of this also wrote
 * `~/.terma[-dev]/agent-sessions/<id>.ndjson`. That file had no reader: replay
 * serves from this ring, and the file could never become one, because reading a
 * previous run back is exactly what caused the timeline-doubling bug this
 * module was rewritten to fix (SPIKE Q4 — the bridge re-emits the entire
 * conversation on `session/load`, so anything replayed from disk would be a
 * second copy). A store that is structurally forbidden from ever being loaded
 * is not persistence, so it was removed along with its costs: a streaming
 * append per ACP frame, full rewrites on truncation, never-reaped disk growth,
 * and a path-traversal surface on the session id.
 *
 * Losing the ring is recoverable: the bridge persists sessions in Claude Code's
 * own store and replays the full conversation on `session/load`.
 *
 * Two properties it guarantees:
 *
 * 1. **No notification-side loss across a detach window.** AG-02 closed the
 *    request-side hole (agent requests are refused outright when no client is
 *    attached) but left notifications to be emitted into the void. Every event
 *    is recorded regardless of attach state, so notifications arriving while
 *    the pane is detached are replayed on reattach rather than lost.
 *
 * 2. **Loss is never silent.** Head truncation is bounded by a count cap and a
 *    size budget — one ACP frame can carry a whole file, where a scrollback
 *    entry is one line, so a count cap alone is not a real bound. Both caps are
 *    exact: trimming runs on every append, so `ACP_MAX_EVENT_LOG_ENTRIES`
 *    bounds at the number it states. The count of dropped events is surfaced
 *    through `replay()`, so a UI can tell the user that earlier events are gone
 *    rather than showing a timeline that silently starts mid-conversation.
 *
 *    Truncation is the *only* way this ring loses events. Replacing the
 *    timeline for a `session/load` is staged (`beginReplace`), so a load that
 *    fails or races another cannot empty it — see those methods.
 */

/**
 * `Sequenced` / `AcpReplay` are defined in `src/shared/acp-types.ts` so the
 * renderer can type a replay it receives over tRPC. Re-exported here because
 * this module is where they are produced.
 *
 * `dropped` is the canonical count of head-truncated events; the `truncated`
 * event that leads a replay repeats it only so a renderer walking the timeline
 * cannot miss the gap.
 */
export type { Sequenced, AcpReplay } from "../../shared/acp-types";
import type { Sequenced, AcpReplay } from "../../shared/acp-types";

/** A complete ring state, parked while a replacement is staged. */
interface ParkedRing<T> {
  entries: Sequenced<T>[];
  sizes: number[];
  size: number;
  dropped: number;
  gen: number;
}

export class AcpEventLog<T extends object> {
  private entries: Sequenced<T>[] = [];
  /** Serialized size of each entry, parallel to `entries`. */
  private sizes: number[] = [];
  private size = 0;
  private dropped = 0;
  private nextSeq = 1;
  /**
   * Generation of the timeline being appended into. Bumped when a replacement
   * is staged, so staged events are distinguishable from the ones they replace
   * even before the swap is committed.
   */
  private gen = 1;
  /** Non-null while a replacement is staged; what `replay()` serves meanwhile. */
  private parked: ParkedRing<T> | null = null;

  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(
    maxEntries: number = ACP_MAX_EVENT_LOG_ENTRIES,
    maxChars: number = ACP_MAX_EVENT_LOG_CHARS,
  ) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxChars = Math.max(1, maxChars);
  }

  /**
   * Record one event and return it with its sequence number attached.
   *
   * Callers forward the returned object to live clients, so the live stream and
   * a later replay share one sequence space and de-duplicate exactly
   * (`seq <= lastReplayed`).
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
   * Current timeline, with the dropped-event count that a UI must surface.
   *
   * While a replacement is staged this serves the parked timeline, so a reader
   * never observes the half-built one.
   */
  replay(): AcpReplay<T> {
    const ring = this.parked;
    return ring === null
      ? { events: [...this.entries], dropped: this.dropped, generation: this.gen }
      : { events: [...ring.entries], dropped: ring.dropped, generation: ring.gen };
  }

  /**
   * Discard the timeline, keeping the sequence space monotonic so a client that
   * already painted earlier events can still tell old frames from new ones.
   */
  reset(): void {
    // A reset is a replacement too: anything a client painted from the old
    // timeline is stale, and only a generation change says so.
    this.gen += 1;
    this.parked = null;
    this.entries = [];
    this.sizes = [];
    this.size = 0;
    this.dropped = 0;
  }

  /**
   * Begin replacing the timeline: park the current one and start recording into
   * a fresh ring, while `replay()` keeps serving the parked timeline until the
   * replacement is committed.
   *
   * This exists for `session/load`, where the agent re-emits the entire
   * conversation as ordinary notifications. Resetting outright instead would
   * be wrong three ways, all of which were observed: two overlapping loads each
   * reset an empty ring and then both append into it, producing the exact
   * doubling this guards against; a load that *fails* leaves the timeline
   * destroyed with nothing to show for it; and a client replaying during the
   * window sees an empty timeline. Staging the replacement makes the swap
   * atomic from a reader's point of view.
   *
   * Sequence numbers keep advancing across a replacement, so staged events can
   * never collide with ones a client already painted.
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
    // Bump before staging, not on commit: events appended into the staged ring
    // are emitted live immediately, and a client must be able to tell them from
    // the timeline they are replacing at the moment it receives them, not
    // retroactively once the load resolves.
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
   * Drop entries from the head until both caps are satisfied. Always leaves at
   * least the newest entry, so a single oversized frame truncates the history
   * rather than looping forever on itself.
   */
  private trim(): void {
    let drop = 0;
    while (
      this.entries.length - drop > this.maxEntries ||
      (this.size > this.maxChars && this.entries.length - drop > 1)
    ) {
      this.size -= this.sizes[drop];
      drop++;
    }
    if (drop === 0) return;
    this.dropped += drop;
    this.entries = this.entries.slice(drop);
    this.sizes = this.sizes.slice(drop);
  }
}
