/**
 * Delivery to sessions (T242, projects-design §15 "Delivery mechanics", P10).
 *
 * A node's pending deliveries reach its live session as one prompt, the
 * digest. An idle session gets it at most `delayMs` (≤ 2 s) after the event;
 * a mid-turn session holds it until the turn ends (the turn-end rule calls
 * `flushWhenReady`). With no live session nothing moves: the deliveries stay
 * `pending` for the next session or wake.
 *
 * P10: a delivery is marked `delivered` only once the session accepts the
 * prompt, and every event in the digest is marked in the one write that
 * records the digest id. A crash between the send and the mark repeats the
 * prompt after restart (at-least-once), never an event within one digest.
 */

import { type RoutedEvent, ulid } from '@agile-agents/shared';
import { summarize } from './producers';
import type { RoutedEventService } from './service';

/** What delivery needs of a node's live session. */
export interface DeliveryTarget {
  sessionId: string;
  /** A turn is running or queued. */
  busy(): boolean;
  /** Queues a turn; `onDelivered` fires when it actually starts (the session accepted it). */
  prompt(text: string, opts: { onDelivered: () => void }): Promise<unknown>;
  /**
   * T461: whether a line runs as one of the vendor's slash commands
   * (`/compact`): it is sent alone and as written, never inside a digest.
   */
  isCommand?(line: string): boolean;
}

/** T461: a human line that runs as a slash command on `target`. */
function commandLine(target: DeliveryTarget, event: RoutedEvent): string | undefined {
  if (event.type !== 'human_line' || target.isCommand === undefined) return undefined;
  const body = String((event.payload as Record<string, unknown>).body ?? '').trim();
  return target.isCommand(body) ? body : undefined;
}

export interface SessionDeliveryOptions {
  events: RoutedEventService;
  /** The node's live worker session, if any. */
  target(node: string): DeliveryTarget | undefined;
  /** How long an idle session waits for a burst to settle (default 250 ms; P10 says ≤ 2 s). */
  delayMs?: number;
  /** After the digest is accepted and marked (e.g. clear the thread's "queued" markers). */
  onDelivered?(node: string, sessionId: string, events: readonly RoutedEvent[]): void;
  /** T243: the node has pending events and no live session; the wake policy decides (P11). */
  wake?(node: string, pending: readonly RoutedEvent[]): void;
  /** Names nodes in the summaries (T244); ids otherwise. */
  titleOf?(id: string): string | undefined;
  /**
   * T461: a human line's whole body from the thread, by its `ts` (the
   * event's `ref`). The event's payload caps it at 800 characters and the
   * composer takes 4,000, so the agent is told the thread's copy.
   */
  lineBody?(node: string, ts: string): string | undefined;
}

/** A digest lists at most this many summaries, newest last, plus "N earlier". */
export const DIGEST_MAX = 10;

/** T174: what a human line tells the worker, after the line itself. */
export const REPLY_FIRST =
  'Reply to the operator on the stream first by calling the `progress` tool (what you pass is what they read; do not write the word "progress" into your message): if it is a question, answer it directly; if it is an instruction, acknowledge it and follow it. Then continue the work.';

/**
 * T502 (D62, design/chat-threads.md §5): what a reply in a question's thread
 * tells the agent, after the line: settle the question if the reply decided
 * it, else answer or ask again. `ids` are the questions the replies are about.
 */
export function settleHint(ids: readonly string[]): string {
  const which = ids.length === 1 ? `question ${ids[0]}` : `the question (${ids.join(', ')})`;
  return `That is a reply about your open question, not a pick: it stays open until you close it. If the reply decides it, call \`settle_question\` with ${which} and what was decided; if it doesn't, answer them with \`progress\`, or \`ask\` again with better choices.`;
}

/** T502: the question a human line is a reply about, when it is one. */
function replyQuestionOf(event: RoutedEvent): { id: string; text: string } | undefined {
  if (event.type !== 'human_line') return undefined;
  const q = (event.payload as Record<string, unknown>).question;
  if (typeof q !== 'object' || q === null) return undefined;
  const { id, text } = q as Record<string, unknown>;
  return typeof id === 'string' && typeof text === 'string' ? { id, text } : undefined;
}

/** What a digest (or a wake) ends with: the reply-first rule, and T502's settle hint. */
function digestTail(events: readonly RoutedEvent[]): string {
  if (!events.some((e) => e.type === 'human_line')) return 'Continue the work.';
  const asked = [
    ...new Set(
      events.flatMap((e) => {
        const about = replyQuestionOf(e);
        return about !== undefined ? [about.id] : [];
      }),
    ),
  ];
  return asked.length > 0 ? `${settleHint(asked)}\n\n${REPLY_FIRST}` : REPLY_FIRST;
}

/** The one-line summary a recipient is told (§15). */
export function summaryOf(
  event: RoutedEvent,
  node: string = event.subject ?? '',
  titleOf?: (id: string) => string | undefined,
): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'human_line': {
      // T502: a reply in a question's thread says what it is about (the question as data).
      const about = replyQuestionOf(event);
      return about !== undefined
        ? `About your question "${about.text}": ${String(p.body)}`
        : `The operator wrote on the stream: ${String(p.body)}`;
    }
    case 'answer':
      return `Your question "${String(p.question)}" was answered: ${String(p.answer)}`;
    default:
      // T244: every other §15 type's one line, as `node` is told it.
      return summarize(event, node, titleOf);
  }
}

/** One prompt for a node's pending events, oldest first in, newest last out. */
export function digestPrompt(
  events: readonly RoutedEvent[],
  node?: string,
  titleOf?: (id: string) => string | undefined,
): string {
  const tail = digestTail(events);
  const line = (e: RoutedEvent) => summaryOf(e, node ?? e.subject ?? '', titleOf);
  if (events.length === 1) return `${line(events[0] as RoutedEvent)}\n\n${tail}`;
  const shown = events.slice(-DIGEST_MAX);
  const earlier = events.length - shown.length;
  return [
    `${events.length} things arrived for you:`,
    ...(earlier > 0 ? [`- (${earlier} earlier; read_event has them)`] : []),
    ...shown.map((e) => `- ${line(e)}`),
    '',
    tail,
  ].join('\n');
}

/**
 * T336: the section a woken session's first prompt ends with. The brief
 * alone showed only the thread's "woken by <type>" line, so the agent had
 * to ask what arrived; each event comes with its id for `read_event`.
 */
export function wakePrompt(
  events: readonly RoutedEvent[],
  node: string,
  titleOf?: (id: string) => string | undefined,
): string {
  const tail = digestTail(events);
  const shown = events.slice(-DIGEST_MAX);
  const earlier = events.length - shown.length;
  return [
    '## What woke you',
    '',
    'This session was started for what arrived below. Quoted text is what its sender wrote; `read_event <id>` returns an event in full.',
    '',
    ...(earlier > 0 ? [`- (${earlier} earlier; read_event has them)`] : []),
    ...shown.map((e) => `- ${e.id} (${e.type}): ${summaryOf(e, node, titleOf)}`),
    '',
    tail,
  ].join('\n');
}

/** T336: events a woken session's brief carries, claimed so no digest repeats them. */
export interface WakeDelivery {
  /** The section appended to the brief (`wakePrompt`). */
  text: string;
  /** T465 (D48): the same events as a live session's digest, for a resumed session (no brief). */
  digest: string;
  /** The brief was accepted: the events are `delivered` to `sessionId`. */
  delivered(sessionId: string): void;
  /** The session ended (or never started): unclaimed events go with the next digest or wake. */
  release(): void;
}

export class SessionDelivery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Event ids per node in a digest sent but not yet accepted. */
  private readonly sending = new Map<string, Set<string>>();
  private readonly holds = new Map<
    string,
    { count: number; released: Promise<void>; release: () => void }
  >();
  private stopped = false;

  constructor(private readonly options: SessionDeliveryOptions) {
    options.events.onEmitted((event) => {
      for (const { node } of event.routing) this.notify(node);
    });
  }

  /**
   * Holds a node's delivery while a producer is between its first write and
   * its emit, so a turn ending in that window keeps the session. Returns the release.
   */
  hold(node: string): () => void {
    let h = this.holds.get(node);
    if (h === undefined) {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      h = { count: 0, released, release };
      this.holds.set(node, h);
    }
    h.count += 1;
    const held = h;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      held.count -= 1;
      if (held.count === 0) {
        this.holds.delete(node);
        held.release();
      }
      this.notify(node);
    };
  }

  /** T461: `events` with each human line's body as the thread has it, uncapped. */
  private withFullLines(node: string, events: readonly RoutedEvent[]): RoutedEvent[] {
    const lineBody = this.options.lineBody;
    if (lineBody === undefined) return [...events];
    return events.map((e) => {
      if (e.type !== 'human_line' || e.ref === undefined) return e;
      const body = lineBody(node, e.ref);
      return body === undefined ? e : { ...e, payload: { ...e.payload, body } };
    });
  }

  private unsent(node: string): RoutedEvent[] {
    const sending = this.sending.get(node);
    return this.options.events
      .pendingFor(node)
      .map((p) => p.event)
      .filter((e) => !sending?.has(e.id));
  }

  /** Something is (or is about to be) waiting for this node's session. */
  waiting(node: string): boolean {
    return this.holds.has(node) || this.unsent(node).length > 0;
  }

  /**
   * T336: hands `events` to a session about to start, in its brief. Until
   * `release`, no digest sends them; `delivered` marks them (P10: once the
   * session accepts the prompt).
   */
  inBrief(node: string, events: readonly RoutedEvent[]): WakeDelivery {
    const ids = events.map((e) => e.id);
    let sending = this.sending.get(node);
    if (sending === undefined) {
      sending = new Set();
      this.sending.set(node, sending);
    }
    for (const id of ids) sending.add(id);
    const claimed = sending;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const id of ids) claimed.delete(id);
      // Anything that arrived meanwhile (or went unmarked) goes now.
      if (this.waiting(node)) this.notify(node);
    };
    const full = this.withFullLines(node, events);
    return {
      text: wakePrompt(full, node, this.options.titleOf),
      digest: digestPrompt(full, node, this.options.titleOf),
      delivered: (sessionId) => {
        const events_ = this.options.events;
        const still = new Set(events_.pendingFor(node).map((p) => p.event.id));
        void events_
          .mark(
            node,
            ids.filter((id) => still.has(id)),
            'delivered',
            { session: sessionId, digest: `D-${ulid()}` },
          )
          .then(() => this.options.onDelivered?.(node, sessionId, events))
          .catch(() => {
            // Already moved, or the home is gone: still-pending ones go again.
          })
          .finally(release);
      },
      release,
    };
  }

  /** An idle session gets the digest after `delayMs`; a busy one at turn end. */
  notify(node: string): void {
    if (this.stopped || this.timers.has(node)) return;
    const timer = setTimeout(() => {
      this.timers.delete(node);
      void this.flush(node).catch((err) => console.error('event delivery failed:', err));
    }, this.options.delayMs ?? 250);
    this.timers.set(node, timer);
  }

  /** The turn-end path: waits out a producer's hold, then flushes. True if a digest was sent. */
  async flushWhenReady(node: string): Promise<boolean> {
    // The ending turn still counts as in flight, and the caller knows none is queued.
    while (true) {
      const h = this.holds.get(node);
      if (h === undefined) break;
      await h.released;
    }
    return this.flush(node, { atTurnEnd: true });
  }

  /** Sends the node's pending events as one digest, if its session is idle. True if sent. */
  async flush(node: string, opts: { atTurnEnd?: boolean } = {}): Promise<boolean> {
    const busy = (t: DeliveryTarget) => !opts.atTurnEnd && t.busy();
    if (this.stopped || this.holds.has(node)) return false;
    const target = this.options.target(node);
    if (target === undefined) {
      const pending = this.unsent(node);
      if (pending.length > 0) this.options.wake?.(node, pending);
      return false;
    }
    if (busy(target)) return false;
    let events = this.unsent(node);
    // Folding tolerates several pending events per coalesce key: the newest wins.
    const newest = new Map<string, string>();
    for (const e of events) if (e.coalesce_key !== undefined) newest.set(e.coalesce_key, e.id);
    const older = events.filter(
      (e) => e.coalesce_key !== undefined && newest.get(e.coalesce_key) !== e.id,
    );
    if (older.length > 0) {
      await this.options.events.mark(
        node,
        older.map((e) => e.id),
        'superseded',
      );
      events = this.unsent(node);
    }
    if (events.length === 0) return false;
    // Re-checked after the await: a turn may have been queued meanwhile.
    if (busy(target) || this.options.target(node)?.sessionId !== target.sessionId) return false;
    events = this.withFullLines(node, events);
    // T461: a slash command is its own turn, as typed: what came before it
    // goes first as a digest, what came after waits for the next turn end.
    const command = commandLine(target, events[0] as RoutedEvent);
    if (command !== undefined) {
      events = events.slice(0, 1);
    } else {
      const at = events.findIndex((e) => commandLine(target, e) !== undefined);
      if (at > 0) events = events.slice(0, at);
    }
    const ids = events.map((e) => e.id);
    let sending = this.sending.get(node);
    if (sending === undefined) {
      sending = new Set();
      this.sending.set(node, sending);
    }
    for (const id of ids) sending.add(id);
    const release = (): void => {
      for (const id of ids) sending?.delete(id);
    };
    const digest = `D-${ulid()}`;
    // The prompt is reserved in the runner synchronously, before any await.
    void target
      .prompt(command ?? digestPrompt(events, node, this.options.titleOf), {
        onDelivered: () => {
          const events_ = this.options.events;
          // Only still-pending ones move (one may have been superseded meanwhile).
          const still = new Set(events_.pendingFor(node).map((p) => p.event.id));
          void events_
            .mark(
              node,
              ids.filter((id) => still.has(id)),
              'delivered',
              { session: target.sessionId, digest },
            )
            .then(() => this.options.onDelivered?.(node, target.sessionId, events))
            .catch(() => {
              // Already moved (superseded/expired meanwhile) or the home is
              // gone: still-pending ones go again with the next digest.
            })
            .finally(release);
        },
      })
      .catch(() => {
        // Not accepted (the session was stopped): the events stay pending.
        release();
      });
    return true;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
