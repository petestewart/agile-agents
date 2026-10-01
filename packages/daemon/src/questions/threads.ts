/**
 * T502 (design/chat-threads.md §4, §5, §8 step 1, D62, D63): a question is
 * its thread. Derived on every read, never stored, and with no new field on
 * a thread entry (that is T503's):
 *
 * - **By ref.** A question's lines share `ref: questions/<id>.yaml`: the
 *   question, your replies typed in its card, the answer (or the agent's
 *   settle), the daemon's lines about it. A question the agent asked again
 *   (`superseded_by`) carries on as one thread under the newer one.
 * - **By cause (§4.1).** A turn the daemon started for your reply posts in
 *   the reply's thread: deliveries record the digest and session that took
 *   each event, so the agent's lines between that digest's start and the
 *   turn's end are the thread's. A digest that carried anything else is a
 *   batched turn and stays in the main flow; nothing is guessed.
 * - **State.** Waits on you; waiting on the agent (you replied, its turn on
 *   it hasn't finished); unsettled (it finished without a settle or a
 *   re-ask: a Needs me row); with the coordinator (T338); resolved.
 */

import {
  type EventDeliveryStatus,
  QUESTION_THREAD_ENTRIES_MAX,
  type Question,
  type QuestionId,
  type QuestionThread,
  type QuestionThreadState,
  type RoutedEvent,
  type SessionRef,
  type Stream,
  type ThreadEntry,
  questionIdOfThreadRef,
} from '@agile-agents/shared';
import type { RoutedEventService } from '../events/service';
import type { StreamService } from '../streams/service';
import { type QuestionService, withCoordinator } from './service';

/** One routed event on a node's queue and what became of it (`RoutedEventService.activityFor`). */
export interface ThreadActivity {
  event: RoutedEvent;
  status: EventDeliveryStatus;
  delivered_at?: string;
  session?: string;
  digest?: string;
}

/** `attach/service.ts`'s `TURN_FINISHED_LINE`: a finished turn whose session rests (T465). */
const TURN_FINISHED = 'turn finished';

/** A session working on a turn (or about to). */
const WORKING: ReadonlySet<SessionRef['status']> = new Set(['starting', 'running']);

/** How much of a node's thread a derivation reads: the newest lines, as the page does. */
export const QUESTION_THREAD_WINDOW = 500;

/** How many resolved child questions a coordinator's chat keeps listing (D63). */
export const CHILD_QUESTIONS_RESOLVED_MAX = 5;

/** One digest a session took: when it started, and what it carried. */
interface Digest {
  id: string;
  session: string;
  at: string;
  events: RoutedEvent[];
}

/** Every delivered digest on a node's queue, oldest first. */
function digestsOf(activity: readonly ThreadActivity[]): Digest[] {
  const byId = new Map<string, Digest>();
  for (const a of activity) {
    if (a.status !== 'delivered' || a.digest === undefined) continue;
    if (a.session === undefined || a.delivered_at === undefined) continue;
    const d = byId.get(a.digest);
    if (d === undefined) {
      byId.set(a.digest, {
        id: a.digest,
        session: a.session,
        at: a.delivered_at,
        events: [a.event],
      });
    } else {
      d.events.push(a.event);
      if (a.delivered_at < d.at) d.at = a.delivered_at;
    }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * When the turn `session` started at `at` (with digest `digest`) ended: the
 * next digest it took, or the daemon's "turn finished" / "session ended"
 * line for it, whichever is first. Undefined: no sign of an end yet.
 */
function turnEnd(
  entries: readonly ThreadEntry[],
  digests: readonly Digest[],
  session: string,
  at: string,
  digest: string,
): string | undefined {
  let end: string | undefined;
  for (const d of digests) {
    if (d.session === session && d.id !== digest && d.at > at) {
      end = d.at;
      break;
    }
  }
  for (const e of entries) {
    if (e.ts <= at || (end !== undefined && e.ts >= end)) continue;
    if (
      e.by === 'daemon' &&
      e.kind === 'event' &&
      e.ref === session &&
      (e.body === TURN_FINISHED || e.body.startsWith('session ended'))
    ) {
      return e.ts;
    }
  }
  return end;
}

/**
 * §4.1's rule: for each digest every event of which `keyOf` maps to the
 * same key, the lines its session's agent wrote in that turn. Lines of a
 * batched digest (mixed keys, or an event with none) are no thread's.
 */
export function linesByCause(
  entries: readonly ThreadEntry[],
  activity: readonly ThreadActivity[],
  keyOf: (event: RoutedEvent) => string | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const digests = digestsOf(activity);
  for (const d of digests) {
    const keys = new Set(d.events.map(keyOf));
    if (keys.size !== 1) continue;
    const [key] = keys;
    if (key === undefined) continue;
    const end = turnEnd(entries, digests, d.session, d.at, d.id);
    const by = `agent:${d.session}`;
    const lines = out.get(key) ?? [];
    for (const e of entries) {
      if (e.by !== by || e.ts < d.at || (end !== undefined && e.ts >= end)) continue;
      // A question or answer the turn wrote has its own `ref`; proposals stay on the main flow.
      if (e.kind !== 'line' && e.kind !== 'finding') continue;
      lines.push(e.ts);
    }
    if (lines.length > 0) out.set(key, lines);
  }
  return out;
}

export interface QuestionThreadsInput {
  /** The node the questions were asked on (its sessions say who asked, and who still works). */
  node: Pick<Stream, 'id' | 'sessions'>;
  /** Its thread lines (the newest `QUESTION_THREAD_WINDOW` will do), oldest first. */
  entries: readonly ThreadEntry[];
  /** Its questions, open and answered. */
  questions: readonly Question[];
  /** Its queue's deliveries (`RoutedEventService.activityFor`). */
  activity: readonly ThreadActivity[];
  /** T338: a part's question its live coordinator has first. */
  withCoordinator?: (question: Question) => boolean;
  /** Every chain, not only the open ones and the ones with a thread. */
  all?: boolean;
}

/**
 * The node's question threads, oldest first: each chain of re-asked
 * questions (keyed by the newest), its lines by ref and by cause, and its
 * state. Unless `all`, only the open ones and those that have a thread (a
 * reply, a re-ask): a question answered at once is a question and its answer.
 */
export function questionThreadsOf(input: QuestionThreadsInput): QuestionThread[] {
  const { entries, activity } = input;
  const byId = new Map<string, Question>(input.questions.map((q) => [q.id, q]));
  const headOf = (id: string): Question | undefined => {
    let q = byId.get(id);
    const seen = new Set<string>();
    while (q?.superseded_by !== undefined && byId.has(q.superseded_by) && !seen.has(q.id)) {
      seen.add(q.id);
      q = byId.get(q.superseded_by);
    }
    return q;
  };
  const chains = new Map<string, Question[]>();
  for (const q of [...input.questions].sort((a, b) => a.raised_at.localeCompare(b.raised_at))) {
    const head = headOf(q.id) ?? q;
    const chain = chains.get(head.id) ?? [];
    chain.push(q);
    chains.set(head.id, chain);
  }

  // By ref: every line naming a question of the chain; your lines are its replies.
  const members = new Map<string, Set<string>>();
  const replies = new Map<string, ThreadEntry[]>();
  const replyHead = new Map<string, string>();
  for (const e of entries) {
    const id = questionIdOfThreadRef(e.ref);
    const head = id === undefined ? undefined : headOf(id);
    if (head === undefined) continue;
    const set = members.get(head.id) ?? new Set<string>();
    set.add(e.ts);
    members.set(head.id, set);
    if (e.by === 'human' && e.kind === 'line') {
      replyHead.set(e.ts, head.id);
      replies.set(head.id, [...(replies.get(head.id) ?? []), e]);
    }
  }
  // By cause: the turns your replies started.
  const caused = linesByCause(entries, activity, (event) =>
    event.type === 'human_line' && event.ref !== undefined ? replyHead.get(event.ref) : undefined,
  );
  for (const [head, lines] of caused) {
    const set = members.get(head) ?? new Set<string>();
    for (const ts of lines) set.add(ts);
    members.set(head, set);
  }

  const digests = digestsOf(activity);
  const stateOf = (head: Question): QuestionThreadState => {
    if (head.status !== 'open') return 'resolved';
    if (input.withCoordinator?.(head) === true) return 'with_coordinator';
    const own = (replies.get(head.id) ?? []).filter(
      (e) => questionIdOfThreadRef(e.ref) === head.id && e.ts >= head.raised_at,
    );
    const latest = own.at(-1);
    if (latest === undefined) return 'waits_on_you';
    const delivery = activity.find(
      (a) => a.event.type === 'human_line' && a.event.ref === latest.ts,
    );
    if (
      delivery === undefined ||
      delivery.status !== 'delivered' ||
      delivery.session === undefined ||
      delivery.delivered_at === undefined
    ) {
      return 'waiting_on_agent';
    }
    const session = delivery.session;
    const ended =
      turnEnd(entries, digests, session, delivery.delivered_at, delivery.digest ?? '') !==
        undefined || !WORKING.has(input.node.sessions.find((s) => s.id === session)?.status ?? 'stopped');
    return ended ? 'unsettled' : 'waiting_on_agent';
  };

  const out: QuestionThread[] = [];
  for (const [headId, chain] of chains) {
    const head = byId.get(headId) as Question;
    const state = stateOf(head);
    const replyCount = replies.get(headId)?.length ?? 0;
    const earlier = chain.filter((q) => q.id !== headId).map((q) => q.id as QuestionId);
    if (!input.all && state === 'resolved' && replyCount === 0 && earlier.length === 0) continue;
    const lines = [...(members.get(headId) ?? [])].sort().slice(-QUESTION_THREAD_ENTRIES_MAX);
    const vendor = input.node.sessions.find((s) => s.id === head.session)?.vendor;
    out.push({
      question: head.id,
      earlier,
      stream: head.stream,
      text: head.text,
      ...(head.options !== undefined && head.options.length > 0
        ? { options: head.options.slice(0, 6) }
        : {}),
      state,
      ...(vendor !== undefined ? { vendor: vendor.slice(0, 80) } : {}),
      replies: replyCount,
      entries: lines,
      raised_at: (chain[0] as Question).raised_at,
      ...(head.answer !== undefined ? { answer: head.answer } : {}),
      ...(head.resolved_as !== undefined ? { resolved_as: head.resolved_as } : {}),
    });
  }
  return out.sort((a, b) => a.raised_at.localeCompare(b.raised_at));
}

export interface QuestionThreadSources {
  streams: Pick<StreamService, 'get' | 'list' | 'readThread'>;
  questions: Pick<QuestionService, 'list'>;
  /** Deliveries: without them, no thread has turns by cause and no reply is known to be read. */
  events?: Pick<RoutedEventService, 'activityFor'>;
}

/** How many deliveries a derivation reads per node (newest first). */
const ACTIVITY_WINDOW = 1000;

/** T502: the question threads of a node, of the parts under a coordinator, and an open question's state. */
export class QuestionThreads {
  constructor(private readonly sources: QuestionThreadSources) {}

  /** The newest `QUESTION_THREAD_WINDOW` lines of a node's thread. */
  private tail(node: string): ThreadEntry[] {
    const total = this.sources.streams.readThread(node, { limit: 1 }).total;
    const from = Math.max(0, total - QUESTION_THREAD_WINDOW);
    return this.sources.streams.readThread(node, {
      ...(from > 0 ? { after: from - 1 } : {}),
      limit: QUESTION_THREAD_WINDOW,
    }).entries;
  }

  private activity(node: string): ThreadActivity[] {
    return [...(this.sources.events?.activityFor(node, ACTIVITY_WINDOW) ?? [])].reverse();
  }

  private coordinatorOf(): (question: Question) => boolean {
    return (question) => {
      if (question.coordinator === undefined) return false;
      try {
        return withCoordinator(question, this.sources.streams.get(question.coordinator));
      } catch {
        return false;
      }
    };
  }

  private derive(node: Stream, entries: readonly ThreadEntry[], all = false): QuestionThread[] {
    const questions = this.sources.questions.list().filter((q) => q.stream === node.id);
    if (questions.length === 0) return [];
    return questionThreadsOf({
      node,
      entries,
      questions,
      activity: this.activity(node.id),
      withCoordinator: this.coordinatorOf(),
      all,
    });
  }

  /** The node page's threads: open questions, and those with a thread, over `entries` (its loaded lines). */
  forNode(id: string, entries?: readonly ThreadEntry[]): QuestionThread[] {
    const node = this.sources.streams.get(id);
    return this.derive(node, entries ?? this.tail(id));
  }

  /** An open question's state, and who asked it (the inbox: waiting on the agent, or unsettled). */
  stateOf(question: Question): { state: QuestionThreadState; vendor?: string } {
    if (question.status !== 'open') return { state: 'resolved' };
    const node = this.sources.streams.get(question.stream);
    const thread = this.derive(node, this.tail(node.id), true).find(
      (t) => t.question === question.id,
    );
    return {
      state: thread?.state ?? 'waits_on_you',
      ...(thread?.vendor !== undefined ? { vendor: thread.vendor } : {}),
    };
  }

  /**
   * D63: a coordinator's chat (a coordinating node or a project root) shows
   * its children's questions as threads: the open ones and the last few
   * resolved, each with its child's title and the coordinator's own lines
   * its question caused (its notes, `ts` on the coordinator's thread:
   * `entries`, the lines the page loaded).
   */
  forCoordinator(id: string, entries: readonly ThreadEntry[]): QuestionThread[] {
    const children = this.sources.streams
      .list()
      .filter((s) => s.parent === id && s.archived !== true);
    const threads: QuestionThread[] = [];
    const questionsOf = new Map<string, Question[]>();
    for (const q of this.sources.questions.list()) {
      questionsOf.set(q.stream, [...(questionsOf.get(q.stream) ?? []), q]);
    }
    for (const child of children) {
      if (!questionsOf.has(child.id)) continue;
      for (const t of this.derive(child, this.tail(child.id), true)) {
        threads.push({ ...t, node_title: child.title.slice(0, 200) });
      }
    }
    // The coordinator's notes: its turns woken by a child's question alone.
    const chainOf = new Map<string, string>();
    for (const t of threads) {
      chainOf.set(t.question, t.question);
      for (const e of t.earlier) chainOf.set(e, t.question);
    }
    const askedOn = (child: string, at: string): string | undefined =>
      (questionsOf.get(child) ?? [])
        .filter((q) => q.raised_at <= at)
        .sort((a, b) => a.raised_at.localeCompare(b.raised_at))
        .at(-1)?.id;
    const notes = linesByCause(entries, this.activity(id), (event) => {
      const p = event.payload as Record<string, unknown>;
      if (event.type === 'child_question' && typeof p.question === 'string') {
        return chainOf.get(p.question);
      }
      if (event.type === 'child_status' && p.status === 'question' && typeof p.child === 'string') {
        const asked = askedOn(p.child, event.at);
        return asked === undefined ? undefined : chainOf.get(asked);
      }
      return undefined;
    });
    const open = threads.filter((t) => t.state !== 'resolved');
    const resolved = threads
      .filter((t) => t.state === 'resolved')
      .sort((a, b) => a.raised_at.localeCompare(b.raised_at))
      .slice(-CHILD_QUESTIONS_RESOLVED_MAX);
    return [...open, ...resolved]
      .map((t) => {
        const own = notes.get(t.question);
        return own !== undefined ? { ...t, notes: own.slice(-QUESTION_THREAD_ENTRIES_MAX) } : t;
      })
      .sort((a, b) => a.raised_at.localeCompare(b.raised_at));
  }
}
