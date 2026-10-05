/**
 * T504 (D65, design/chat-threads.md §6, §6a): what the operator does to a
 * node's chat threads, each recorded as its own line (`ThreadEntry.op`,
 * checked by the store), never by rewriting a line:
 *
 * - **Move to thread / Move to main.** Display only: the line shows in the
 *   other place, says it was moved, and moves back the same way. What the
 *   agent already received never changes.
 * - **Archive.** The thread folds away; the daemon never re-sends its lines
 *   (a brief, `read_stream`; its pending replies are dropped, and a new one
 *   is refused); the agent is told once, quietly (`thread_archived` rides
 *   the next digest). A question asked in it is withdrawn. **Restore**
 *   undoes it, and says so.
 * - **Archive and forget.** Archive, then the agent restarts fresh from a
 *   brief without it (`AttachService.restartFresh`): no notice, since the
 *   new agent never saw the thread.
 * - **Compact now.** The vendor's own compact command, told to leave the
 *   archived threads out, where the vendor has one that takes instructions
 *   (`COMPACT_COMMANDS`; LIVE-CHECKLIST §23 measures it).
 *
 * Promote to tangent is a node create (`seed_thread`, `StreamService.create`).
 */

import {
  CHAT_MAIN,
  type ChatPlace,
  type RoutedEvent,
  type ThreadAnchor,
  type ThreadEntry,
  chatThreadOpsOf,
  quoteThreadBody,
} from '@agile-agents/shared';
import type { AttachService } from '../attach/service';
import { AgentWorkingError } from '../attach/service';
import { routeAndEmit } from '../events/router';
import type { RoutedEventService } from '../events/service';
import type { StreamService } from '../streams/service';
import type { ChatThreads } from './chat-threads';
import type { QuestionService } from './service';

/** Compact now can't run here: no agent, or its vendor has no compact command known to take instructions. */
export class CompactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactUnavailableError';
  }
}

export interface ChatThreadOpsDeps {
  streams: Pick<StreamService, 'get' | 'list' | 'readThread' | 'appendThread'>;
  chatThreads: Pick<ChatThreads, 'forNode'>;
  /** The archive notice, and the replies it drops; without it the agent is told nothing. */
  events?: RoutedEventService;
  /** Withdraws a question asked in an archived thread. */
  questions?: Pick<QuestionService, 'withdraw'>;
  /** Archive and forget's restart, and Compact now's command. */
  attach?: Pick<AttachService, 'restartFresh' | 'compactCommand' | 'agentWorking'>;
}

/** What a thread is on, in words: its passage, quoted, or the message. */
function onWords(anchor: ThreadAnchor | undefined): string {
  if (anchor?.quote === undefined) return 'a message';
  return JSON.stringify(quoteThreadBody(anchor.quote.replace(/\s+/g, ' ').trim(), 120));
}

/** Who wrote the turn a thread is on, as the agent is told it. */
function ofWhom(by: string | undefined): 'agent' | 'human' | 'other' {
  if (by === undefined) return 'other';
  if (by === 'human') return 'human';
  return by.startsWith('agent:') || by === 'coordinator' || by === 'director' ? 'agent' : 'other';
}

/** The words Compact now's instruction leaves at most for the threads (the command's line is 800). */
const COMPACT_MAX = 780;

export class ChatThreadOps {
  constructor(private readonly deps: ChatThreadOpsDeps) {}

  private lines(node: string): ThreadEntry[] {
    const total = this.deps.streams.readThread(node, { limit: 1 }).total;
    return this.deps.streams.readThread(node, { limit: Math.max(1, total) }).entries;
  }

  private start(lines: readonly ThreadEntry[], thread: string): ThreadEntry {
    const start = lines.find((e) => e.ts === thread && e.anchor !== undefined);
    if (start === undefined) throw new Error(`no thread ${thread} on this node`);
    return start;
  }

  /** §6: Move to thread (`to`: its id) or Move to main (`main`). Display only; by you. */
  async move(node: string, entry: string, to: ChatPlace): Promise<ThreadEntry> {
    const lines = this.lines(node);
    const body =
      to === CHAT_MAIN
        ? 'moved a line to the main chat'
        : `moved a line to the thread on ${onWords(this.start(lines, to).anchor)}`;
    return this.deps.streams.appendThread('human', node, {
      kind: 'event',
      body: body.slice(0, 800),
      op: { type: 'move', entry, to },
    });
  }

  /**
   * §6a: Archive (and, with `forget`, Archive and forget). Recorded first
   * (the store checks the thread is open), then: its open questions are
   * withdrawn, its pending replies dropped, and the agent is told once or,
   * forgetting, restarted fresh.
   */
  async archive(
    node: string,
    thread: string,
    options: { forget?: boolean } = {},
  ): Promise<{ entry: ThreadEntry; withdrawn: string[]; restarted?: string }> {
    const forget = options.forget === true;
    // Archive and forget waits while the agent works on a turn: nothing is written.
    if (forget && this.deps.attach?.agentWorking(node) === true) {
      throw new AgentWorkingError(this.deps.streams.get(node).title);
    }
    const lines = this.lines(node);
    const start = this.start(lines, thread);
    const derived = this.deps.chatThreads.forNode(node).threads.find((t) => t.id === thread);
    const entry = await this.deps.streams.appendThread('human', node, {
      kind: 'event',
      body: `archived the thread on ${onWords(start.anchor)}${
        forget ? ', and restarted the agent without it' : ''
      }`.slice(0, 800),
      op: { type: 'archive', thread, ...(forget ? { forget: true as const } : {}) },
    });
    const withdrawn: string[] = [];
    for (const question of derived?.questions ?? []) {
      try {
        await this.deps.questions?.withdraw(
          question,
          'the operator archived the thread it was asked in',
        );
        withdrawn.push(question);
      } catch {
        // Answered meanwhile: nothing to withdraw.
      }
    }
    await this.dropPendingReplies(node, thread);
    if (forget) {
      // The new agent never saw the thread: no notice, and none pending for it.
      await this.supersedeNotices(node, thread);
      const session = await this.deps.attach?.restartFresh(
        node,
        'Archive and forget: restarted fresh, from a brief without the archived threads',
      );
      return { entry, withdrawn, ...(session !== undefined ? { restarted: session.id } : {}) };
    }
    await this.notify(node, lines, start, { withdrawn });
    return { entry, withdrawn };
  }

  /** §6a: Restore (Unarchive): the thread is back, and the agent is told so. */
  async restore(node: string, thread: string): Promise<ThreadEntry> {
    const lines = this.lines(node);
    const start = this.start(lines, thread);
    const forgot = chatThreadOpsOf(lines).archived.get(thread)?.forget === true;
    const entry = await this.deps.streams.appendThread('human', node, {
      kind: 'event',
      body: `restored the thread on ${onWords(start.anchor)}`.slice(0, 800),
      op: { type: 'unarchive', thread },
    });
    // A forgotten thread was never in the new agent's context: the brief has it again from now.
    if (!forgot) await this.notify(node, lines, start, { restored: true });
    return entry;
  }

  /**
   * §6a: Compact now: the vendor's compact command, told to leave out every
   * archived thread (each quoted as data). Only while the node's agent runs
   * and its vendor's command is known to take instructions.
   */
  async compact(node: string): Promise<{ entry: ThreadEntry; command: string }> {
    const name = this.deps.attach?.compactCommand(node);
    if (name === undefined) {
      throw new CompactUnavailableError(
        "Compact now needs the node's agent running, on a vendor whose compact command takes instructions",
      );
    }
    const lines = this.lines(node);
    const archived = [...chatThreadOpsOf(lines).archived.keys()];
    if (archived.length === 0) throw new Error('no archived thread to leave out');
    const head = `/${name} Leave out the archived threads (the operator closed them; don't carry them into the summary):`;
    const parts: string[] = [];
    let room = COMPACT_MAX - head.length;
    for (const thread of archived) {
      const start = lines.find((e) => e.ts === thread);
      const on = start?.anchor?.entry;
      const turn = on !== undefined ? lines.find((e) => e.ts === on) : undefined;
      const part =
        start?.anchor?.quote !== undefined
          ? ` the thread on ${onWords(start.anchor)};`
          : ` the thread on the message ${JSON.stringify(quoteThreadBody((turn?.body ?? '').replace(/\s+/g, ' '), 60))};`;
      if (part.length > room) break;
      parts.push(part);
      room -= part.length;
    }
    const command = `${head}${parts.join('')}`.replace(/;$/, '.');
    const entry = await this.deps.streams.appendThread('human', node, {
      kind: 'event',
      body: command,
      op: { type: 'compact', threads: archived.slice(0, 50) },
    });
    if (this.deps.events !== undefined) {
      // T461: a human line that starts with an advertised command goes to the vendor as typed.
      await routeAndEmit(
        this.deps.events,
        {
          type: 'human_line',
          subject: node,
          payload: { body: command },
          ref: entry.ts,
          by: 'human',
        },
        [this.deps.streams.get(node)],
      );
    }
    return { entry, command };
  }

  /** The thread's replies not yet delivered: dropped, so an archived thread wakes nobody. */
  private async dropPendingReplies(node: string, thread: string): Promise<void> {
    const events = this.deps.events;
    if (events === undefined) return;
    const ids = events
      .pendingFor(node)
      .filter((p) => {
        if (p.event.type !== 'human_line') return false;
        const t = (p.event.payload as Record<string, unknown>).thread;
        return typeof t === 'object' && t !== null && (t as Record<string, unknown>).id === thread;
      })
      .map((p) => p.event.id);
    if (ids.length > 0) await events.mark(node, ids, 'superseded').catch(() => undefined);
  }

  /** Pending notices about `thread` (the agent hasn't heard them): superseded. True if any was. */
  private async supersedeNotices(node: string, thread: string): Promise<boolean> {
    const events = this.deps.events;
    if (events === undefined) return false;
    const ids = events
      .pendingFor(node)
      .filter(
        (p) =>
          p.event.type === 'thread_archived' &&
          (p.event.payload as Record<string, unknown>).thread === thread,
      )
      .map((p) => p.event.id);
    if (ids.length === 0) return false;
    await events.mark(node, ids, 'superseded').catch(() => undefined);
    return true;
  }

  /**
   * The agent is told once: a quiet `thread_archived` (it rides the next
   * digest). An earlier change it hasn't heard yet is taken back instead:
   * archived and restored before it heard either, it hears nothing.
   */
  private async notify(
    node: string,
    lines: readonly ThreadEntry[],
    start: ThreadEntry,
    what: { restored?: true; withdrawn?: readonly string[] },
  ): Promise<RoutedEvent | undefined> {
    const events = this.deps.events;
    if (events === undefined) return undefined;
    if (await this.supersedeNotices(node, start.ts)) return undefined;
    const anchor = start.anchor as ThreadAnchor;
    const on = lines.find((e) => e.ts === anchor.entry);
    return routeAndEmit(
      events,
      {
        type: 'thread_archived',
        subject: node,
        payload: {
          thread: start.ts,
          on: anchor.entry,
          of: ofWhom(on?.by),
          ...(anchor.quote !== undefined ? { quote: quoteThreadBody(anchor.quote, 800) } : {}),
          ...(what.restored ? { restored: true } : {}),
          ...(what.withdrawn !== undefined && what.withdrawn.length > 0
            ? { withdrawn: what.withdrawn.slice(0, 20) }
            : {}),
        },
        ref: start.ts,
        by: 'human',
      },
      [this.deps.streams.get(node)],
    );
  }
}
