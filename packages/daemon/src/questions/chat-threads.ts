/**
 * T503 (D60, D61, D64, design/chat-threads.md §3a, §4, §6, §8 step 2): the
 * chat threads on a node's turns. Derived on every read, like T502's
 * question threads (`threads.ts`); only a line's `thread` and its first
 * reply's `anchor` are stored.
 *
 * - **By field.** Your replies carry `thread` (the first one also its
 *   `anchor`); so does a line the agent placed itself (`progress` / `ask`
 *   with `thread`, §4.2).
 * - **By cause (§4.1).** A turn the daemon started because of one thread's
 *   reply posts in that thread: its agent's lines, findings and questions
 *   between the digest and the turn's end. A turn woken by lines from more
 *   than one thread (or the main chat and a thread) is a batch: its lines
 *   stay in the main flow and link the threads it answers.
 * - **State (§6).** Waiting on the agent (your reply is with it, its turn on
 *   it not finished); waits on you (a question asked in it is open);
 *   resolved (its questions are answered and you haven't written since);
 *   open otherwise.
 */

import {
  CHAT_MAIN,
  CHAT_THREAD_ENTRIES_MAX,
  CHAT_THREAD_REPLIES_MAX,
  type ChatBatch,
  type ChatMove,
  type ChatThread,
  type ChatThreadReply,
  type ChatThreadState,
  type Question,
  type QuestionId,
  type RoutedEvent,
  type Stream,
  type ThreadEntry,
  chatThreadOpsOf,
  isAgentRole,
  questionIdOfThreadRef,
} from '@agile-agents/shared';
import type { RoutedEventService } from '../events/service';
import type { StreamService } from '../streams/service';
import type { QuestionService } from './service';
import {
  QUESTION_THREAD_WINDOW,
  type ThreadActivity,
  WORKING,
  digestsOf,
  turnEnd,
  turnsByCause,
} from './threads';

/** The kinds of line a thread-woken turn places in its thread (a question shows in both, §6). */
const PLACED_KINDS: ReadonlySet<ThreadEntry['kind']> = new Set(['line', 'finding', 'question']);

export interface ChatThreadsInput {
  /** The node (its sessions say who answers, and whether a turn still runs). */
  node: Pick<Stream, 'id' | 'sessions'>;
  /** Its thread lines (the newest `QUESTION_THREAD_WINDOW` will do), oldest first. */
  entries: readonly ThreadEntry[];
  /** Its queue's deliveries (`RoutedEventService.activityFor`). */
  activity: readonly ThreadActivity[];
  /** Its questions (a question asked in a thread waits on you there). */
  questions?: readonly Question[];
}

export interface ChatThreadsOf {
  threads: ChatThread[];
  batches: ChatBatch[];
  /** T504 (§6): lines shown somewhere other than where they were written. */
  moves: ChatMove[];
}

/** T504: a line that is no message of a thread: a recorded change, or one written for the agent. */
function notAMessage(entry: ThreadEntry): boolean {
  return entry.op !== undefined || entry.agent_only === true;
}

/** The chat thread a delivered human line is a reply in (its payload's `thread.id`). */
function threadOfEvent(event: RoutedEvent): string | undefined {
  if (event.type !== 'human_line') return undefined;
  const t = (event.payload as Record<string, unknown>).thread;
  if (typeof t !== 'object' || t === null) return undefined;
  const id = (t as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** A turn's line the agent placed itself (a `thread` of its own) is never moved by cause. */
function placedByField(entry: ThreadEntry): boolean {
  return entry.thread !== undefined;
}

/**
 * The node's chat threads (oldest first) and its batched turns, over
 * `entries`. A thread whose first reply is not among them is not listed.
 */
export function chatThreadsOf(input: ChatThreadsInput): ChatThreadsOf {
  const { entries, activity } = input;
  const starts = new Map<string, ThreadEntry>();
  for (const e of entries) {
    if (e.anchor !== undefined && e.thread === e.ts) starts.set(e.ts, e);
  }
  if (starts.size === 0) return { threads: [], batches: [], moves: [] };
  // T504: moves, archives and promotions, read back from their lines.
  const ops = chatThreadOpsOf(entries);

  // By field.
  const members = new Map<string, Set<string>>();
  const add = (thread: string, ts: string): void => {
    const set = members.get(thread) ?? new Set<string>();
    set.add(ts);
    members.set(thread, set);
  };
  for (const e of entries) {
    if (e.thread !== undefined && starts.has(e.thread) && !notAMessage(e)) add(e.thread, e.ts);
  }

  // By cause: a turn one thread's reply woke posts there; a mixed one is a batch.
  const batches: ChatBatch[] = [];
  const keyOf = (event: RoutedEvent): string | undefined => {
    const id = threadOfEvent(event);
    return id !== undefined && starts.has(id) ? id : undefined;
  };
  for (const turn of turnsByCause(entries, activity, keyOf, PLACED_KINDS)) {
    const own = turn.lines.filter((e) => !placedByField(e));
    if (own.length === 0) continue;
    const threads = [...turn.keys].filter((k): k is string => k !== undefined);
    if (threads.length === 0) continue;
    if (turn.keys.size === 1) {
      for (const e of own) add(threads[0] as string, e.ts);
      continue;
    }
    // A batched turn: in the main flow, linking what it answers (its questions too, §6).
    batches.push({
      entries: own.map((e) => e.ts).slice(-CHAT_THREAD_ENTRIES_MAX),
      threads: threads.sort().slice(0, 50),
    });
  }

  const byTs = new Map(entries.map((e) => [e.ts, e]));

  // T504 (§6): Move to thread / Move to main, display only: the latest move of a line wins,
  // and a line moved back where it was written is not moved.
  const moves: ChatMove[] = [];
  if (ops.moves.size > 0) {
    const written = new Map<string, string>();
    for (const [thread, set] of members) for (const ts of set) written.set(ts, thread);
    for (const [entry, move] of ops.moves) {
      if (!byTs.has(entry) || starts.has(entry)) continue;
      const from = written.get(entry) ?? CHAT_MAIN;
      if (move.to === from) continue;
      if (move.to !== CHAT_MAIN && !starts.has(move.to)) continue;
      if (from !== CHAT_MAIN) members.get(from)?.delete(entry);
      if (move.to !== CHAT_MAIN) add(move.to, entry);
      moves.push({ entry, from, to: move.to, at: move.at });
    }
    const moved = new Set(moves.filter((m) => m.to !== CHAT_MAIN).map((m) => m.entry));
    for (let i = batches.length - 1; i >= 0; i--) {
      const batch = batches[i] as ChatBatch;
      const left = batch.entries.filter((ts) => !moved.has(ts));
      if (left.length === 0) batches.splice(i, 1);
      else batches[i] = { ...batch, entries: left };
    }
  }
  const questionsById = new Map<string, Question>(
    (input.questions ?? []).map((q) => [q.id as string, q]),
  );
  const digests = digestsOf(activity);
  const vendor = [...input.node.sessions].reverse().find((s) => isAgentRole(s.role))?.vendor;

  const stateOf = (lines: readonly ThreadEntry[], open: readonly string[]): ChatThreadState => {
    if (open.length > 0) return 'waits_on_you';
    const lastHuman = [...lines].reverse().find((e) => e.by === 'human' && e.kind === 'line');
    const asked = lines.filter((e) => e.kind === 'question');
    if (lastHuman !== undefined && !lines.some((e) => e.by !== 'human' && e.ts > lastHuman.ts)) {
      // Your latest reply: still with the agent, unless the turn it started is over.
      const delivery = activity.find(
        (a) => a.event.type === 'human_line' && a.event.ref === lastHuman.ts,
      );
      if (delivery === undefined || delivery.status === 'pending') return 'waiting_on_agent';
      if (
        delivery.status !== 'delivered' ||
        delivery.session === undefined ||
        delivery.delivered_at === undefined
      ) {
        return 'open';
      }
      const session = delivery.session;
      const ended =
        turnEnd(entries, digests, session, delivery.delivered_at, delivery.digest ?? '') !==
          undefined ||
        !WORKING.has(input.node.sessions.find((s) => s.id === session)?.status ?? 'stopped');
      return ended ? 'open' : 'waiting_on_agent';
    }
    const lastAsked = asked.at(-1);
    if (lastAsked !== undefined && (lastHuman === undefined || lastHuman.ts < lastAsked.ts)) {
      return 'resolved';
    }
    return 'open';
  };

  const threads: ChatThread[] = [];
  for (const [id, start] of starts) {
    const lines = [...(members.get(id) ?? new Set<string>([id]))].sort().flatMap((ts) => {
      const e = byTs.get(ts);
      return e ? [e] : [];
    });
    const open = lines
      .filter((e) => e.kind === 'question')
      .map((e) => questionIdOfThreadRef(e.ref))
      .filter((q): q is QuestionId => q !== undefined && questionsById.get(q)?.status === 'open');
    const others = lines.filter((e) => e.by !== 'human');
    const last = lines.at(-1) ?? start;
    threads.push({
      id,
      stream: input.node.id,
      anchor: start.anchor as NonNullable<ThreadEntry['anchor']>,
      state: stateOf(lines, open),
      replies: lines.length,
      entries: lines.map((e) => e.ts).slice(-CHAT_THREAD_ENTRIES_MAX),
      last_at: last.ts,
      ...(others.length > 0 ? { reply_at: (others.at(-1) as ThreadEntry).ts } : {}),
      ...(open.length > 0 ? { questions: [...new Set(open)].slice(0, 50) } : {}),
      ...(vendor !== undefined ? { vendor: vendor.slice(0, 80) } : {}),
      ...(() => {
        const archived = ops.archived.get(id);
        const promoted = ops.promoted.get(id);
        return {
          ...(archived !== undefined ? { archived } : {}),
          ...(promoted !== undefined ? { promoted } : {}),
        };
      })(),
    });
  }
  return { threads: threads.sort((a, b) => a.id.localeCompare(b.id)), batches, moves };
}

/** T504: the recorded changes an agent is still shown: a promotion (the thread goes on as a tangent). */
function agentSeesOp(entry: ThreadEntry): boolean {
  return entry.op?.type === 'promote';
}

/**
 * T504 (D65, design/chat-threads.md §6a): a node's lines as its agent is
 * handed them again (a brief, `read_stream`): without the cockpit's own
 * records (moves are display only; an archive is told once, as an event)
 * and without the archived threads, as the chat shows them: their lines by
 * field, by cause and moved in, and anything written in them.
 */
export function linesForAgent(
  entries: readonly ThreadEntry[],
  activity: readonly ThreadActivity[] = [],
): ThreadEntry[] {
  const kept = (e: ThreadEntry) => e.op === undefined || agentSeesOp(e);
  const ops = chatThreadOpsOf(entries);
  if (ops.archived.size === 0) return entries.filter(kept);
  const hidden = new Set<string>();
  for (const thread of chatThreadsOf({ node: { id: '', sessions: [] }, entries, activity })
    .threads) {
    if (thread.archived !== undefined) for (const ts of thread.entries) hidden.add(ts);
  }
  return entries.filter(
    (e) => kept(e) && !hidden.has(e.ts) && !(e.thread !== undefined && ops.archived.has(e.thread)),
  );
}

export interface ChatThreadSources {
  streams: Pick<StreamService, 'get' | 'readThread'>;
  questions?: Pick<QuestionService, 'list'>;
  /** Deliveries: without them, no turn is placed by cause. */
  events?: Pick<RoutedEventService, 'activityFor'>;
}

/** How many deliveries a derivation reads per node (newest first). */
const ACTIVITY_WINDOW = 1000;

/** T503: a node's chat threads (its page), and their latest replies (its rail row's unread). */
export class ChatThreads {
  /** Per node: the rail's replies, as of the thread's last change. */
  private readonly replied = new Map<
    string,
    { at: string | undefined; replies: ChatThreadReply[] }
  >();

  constructor(private readonly sources: ChatThreadSources) {}

  private tail(node: string): ThreadEntry[] {
    const total = this.sources.streams.readThread(node, { limit: 1 }).total;
    const from = Math.max(0, total - QUESTION_THREAD_WINDOW);
    return this.sources.streams.readThread(node, {
      ...(from > 0 ? { after: from - 1 } : {}),
      limit: QUESTION_THREAD_WINDOW,
    }).entries;
  }

  /** The node page's threads and batches, over `entries` (its loaded lines). */
  forNode(
    id: string,
    entries?: readonly ThreadEntry[],
    /** Read the node's questions (a thread's state needs them; its replies don't). */
    withQuestions = true,
  ): ChatThreadsOf {
    const node = this.sources.streams.get(id);
    const lines = entries ?? this.tail(id);
    if (!lines.some((e) => e.anchor !== undefined)) return { threads: [], batches: [], moves: [] };
    return chatThreadsOf({
      node,
      entries: lines,
      activity: [...(this.sources.events?.activityFor(id, ACTIVITY_WINDOW) ?? [])].reverse(),
      ...(withQuestions
        ? { questions: (this.sources.questions?.list() ?? []).filter((q) => q.stream === id) }
        : {}),
    });
  }

  /** T504: `entries` (the node's lines) as its agent is handed them again (`linesForAgent`). */
  linesForAgent(id: string, entries: readonly ThreadEntry[]): ThreadEntry[] {
    if (!entries.some((e) => e.op !== undefined)) return [...entries];
    return linesForAgent(
      entries,
      [...(this.sources.events?.activityFor(id, ACTIVITY_WINDOW) ?? [])].reverse(),
    );
  }

  /** T504 (§7): a chat thread's lines as the chat shows them, oldest first (Promote to tangent). */
  linesOf(id: string, thread: string): ThreadEntry[] | undefined {
    const lines = this.tail(id);
    const found = this.forNode(id, lines, false).threads.find((t) => t.id === thread);
    if (found === undefined) return undefined;
    const byTs = new Map(lines.map((e) => [e.ts, e]));
    return found.entries.flatMap((ts) => {
      const e = byTs.get(ts);
      return e !== undefined ? [e] : [];
    });
  }

  /**
   * The rail row's unread: each thread's latest line not yours, newest
   * first. `changedAt` is when the node's thread last changed: the answer
   * is kept until it changes.
   */
  repliesFor(id: string, changedAt: string | undefined): ChatThreadReply[] {
    const known = this.replied.get(id);
    if (known !== undefined && known.at === changedAt) return known.replies;
    let replies: ChatThreadReply[] = [];
    try {
      replies = this.forNode(id, undefined, false)
        // T504: an archived thread has nothing for you to read.
        .threads.flatMap((t) =>
          t.reply_at !== undefined && t.archived === undefined
            ? [{ thread: t.id, at: t.reply_at }]
            : [],
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, CHAT_THREAD_REPLIES_MAX);
    } catch {
      // An unreadable thread has no replies to show.
    }
    this.replied.set(id, { at: changedAt, replies });
    return replies;
  }
}
