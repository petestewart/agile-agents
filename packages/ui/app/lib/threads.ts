/**
 * T503 (D60, D61, D64, design/chat-threads.md §3a, §4, §6): chat threads on
 * a node's turns, as the chat shows them. Pure, so `bun test` covers it;
 * the panel, the marks and the highlights are in `Chat.tsx`.
 *
 *  - `placeChatThreads`: which lines leave the main flow for their thread,
 *    where each thread's mark sits (under the turn it is on, in passage
 *    order), which main-flow lines link a thread (a question asked in one,
 *    a batched turn's reply).
 *  - `anchorFor` / `findPassage`: a selection as a thread's anchor, and the
 *    passage found again in a turn's text (whitespace and Markdown aside).
 *  - `threadUnread`, `openThreadsChip`: what you haven't read, and the
 *    "Open threads (2)" chip's count and target.
 */

import type { ChatBatch, ChatThread, ThreadAnchor, ThreadEntry } from '@agile-agents/shared';
import { THREAD_ANCHOR_QUOTE_MAX_CHARS } from '@agile-agents/shared';
import { vendorLabel } from './chat';
import { tidySelection } from './quote';

/** Where each chat thread shows in a node's chat, and the lines it takes out of the flow. */
export interface ChatThreadPlacement {
  /** The threads under each turn (`ts`), in passage order (a whole-turn thread last). */
  marksOn: Map<string, ChatThread[]>;
  /** Lines shown in their thread instead of the main flow (`ts`). */
  nested: Set<string>;
  /** Main-flow lines that are also in a thread (a question asked there, §6): the thread. */
  alsoIn: Map<string, ChatThread>;
  /** The first line of a batched turn (§4.1): the threads it replies to. */
  repliesTo: Map<string, ChatThread[]>;
}

/** Passage order: by where the passage starts; one placed only by its quote next; the whole turn last. */
function passageOrder(a: ChatThread, b: ChatThread): number {
  const rank = (t: ChatThread) =>
    t.anchor.start !== undefined
      ? t.anchor.start
      : t.anchor.quote !== undefined
        ? Number.MAX_SAFE_INTEGER - 1
        : Number.MAX_SAFE_INTEGER;
  return rank(a) - rank(b) || a.id.localeCompare(b.id);
}

/**
 * Each thread's mark sits under the turn it is on; its lines leave the
 * main flow, except a question asked in it, which stays there too (with a
 * link to its thread: what needs you never hides in a folded thread). A
 * thread on a turn above the loaded lines keeps its lines in the flow and
 * its mark on the first of them. A batched turn's first line links the
 * threads it answers.
 */
export function placeChatThreads(
  threads: readonly ChatThread[],
  batches: readonly ChatBatch[],
  loaded: readonly Pick<ThreadEntry, 'ts' | 'kind'>[],
): ChatThreadPlacement {
  const kindOf = new Map(loaded.map((e) => [e.ts, e.kind]));
  const marksOn = new Map<string, ChatThread[]>();
  const nested = new Set<string>();
  const alsoIn = new Map<string, ChatThread>();
  const byId = new Map(threads.map((t) => [t.id, t]));
  const mark = (ts: string, thread: ChatThread) => {
    marksOn.set(ts, [...(marksOn.get(ts) ?? []), thread]);
  };
  for (const thread of threads) {
    const lines = thread.entries.filter((ts) => kindOf.has(ts));
    if (kindOf.has(thread.anchor.entry)) {
      mark(thread.anchor.entry, thread);
      for (const ts of lines) {
        if (kindOf.get(ts) === 'question') alsoIn.set(ts, thread);
        else nested.add(ts);
      }
    } else if (lines[0] !== undefined) {
      mark(lines[0], thread);
    }
  }
  for (const [ts, list] of marksOn) marksOn.set(ts, [...list].sort(passageOrder));
  const repliesTo = new Map<string, ChatThread[]>();
  for (const batch of batches) {
    const first = batch.entries.find((ts) => kindOf.has(ts) && !nested.has(ts));
    const linked = batch.threads.flatMap((id) => {
      const t = byId.get(id);
      return t ? [t] : [];
    });
    if (first !== undefined && linked.length > 0) repliesTo.set(first, linked);
  }
  return { marksOn, nested, alsoIn, repliesTo };
}

/** What a thread is on, in a few words: its passage, quoted and cut, or "whole message". */
export function anchorLabel(anchor: Pick<ThreadAnchor, 'quote'>, max = 40): string {
  const quote = anchor.quote?.replace(/\s+/g, ' ').trim();
  if (quote === undefined || quote === '') return 'whole message';
  return `“${quote.length > max ? `${quote.slice(0, max - 1).trimEnd()}…` : quote}”`;
}

/** A thread's state in words for its mark and panel, and the tone of its tag. */
export interface ThreadStateWords {
  text: string;
  tone: 'amber' | 'blue' | 'green' | 'gray';
}

export function threadStateWords(
  thread: Pick<ChatThread, 'state' | 'vendor'>,
): ThreadStateWords | undefined {
  switch (thread.state) {
    case 'waits_on_you':
      return { text: 'waiting on you', tone: 'amber' };
    case 'waiting_on_agent':
      return {
        text: `waiting on ${thread.vendor !== undefined ? vendorLabel(thread.vendor) : 'the agent'}`,
        tone: 'blue',
      };
    case 'resolved':
      return { text: 'resolved', tone: 'green' };
    case 'open':
      return undefined;
  }
}

/** "1 reply", "3 replies". */
export function threadRepliesText(n: number): string {
  return `${n} ${n === 1 ? 'reply' : 'replies'}`;
}

/** The read mark's key for one thread (beside the nodes' own, in the same per-browser store). */
export function threadReadKey(node: string, thread: string): string {
  return `thread:${node}:${thread}`;
}

/** The lines of `thread` not yours written after `readUpTo`: its unread count. */
export function threadUnread(
  thread: Pick<ChatThread, 'entries' | 'reply_at'>,
  byOf: (ts: string) => string | undefined,
  readUpTo: string,
): number {
  if (thread.reply_at === undefined || thread.reply_at <= readUpTo) return 0;
  return thread.entries.filter((ts) => {
    const by = byOf(ts);
    return ts > readUpTo && by !== undefined && by !== 'human';
  }).length;
}

/**
 * "Open threads (2)": the threads not resolved, and where the chip jumps
 * (the first unread, else the first waiting on you, else the newest).
 */
export function openThreadsChip(
  threads: readonly ChatThread[],
  unread: (thread: ChatThread) => number,
): { count: number; target?: ChatThread; unread: number } {
  const open = threads.filter((t) => t.state !== 'resolved');
  const unreadOnes = threads.filter((t) => unread(t) > 0);
  const target =
    unreadOnes[0] ?? open.find((t) => t.state === 'waits_on_you') ?? open.at(-1) ?? undefined;
  return {
    count: open.length,
    unread: unreadOnes.length,
    ...(target !== undefined ? { target } : {}),
  };
}

/** Characters a rendered turn may drop or add around its source (whitespace and Markdown marks). */
const LOOSE = /[\s*_`#>~[\]()|\\-]/;

/** `text` without its loose characters, and where each kept one came from. */
function tight(text: string): { chars: string; at: number[] } {
  let chars = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (LOOSE.test(c)) continue;
    chars += c;
    at.push(i);
  }
  return { chars, at };
}

/**
 * Where `quote` reads in `text`, ignoring whitespace and Markdown marks:
 * `[start, end)` in `text`, the occurrence nearest `near` when there are
 * several (a passage's own offset, scaled). Undefined when it isn't there.
 */
export function findPassage(
  text: string,
  quote: string,
  near?: number,
): { start: number; end: number } | undefined {
  const needle = tight(quote.replace(/…$/, '')).chars;
  if (needle === '') return undefined;
  const hay = tight(text);
  let best: { start: number; end: number } | undefined;
  for (let i = hay.chars.indexOf(needle); i >= 0; i = hay.chars.indexOf(needle, i + 1)) {
    const span = {
      start: hay.at[i] as number,
      end: (hay.at[i + needle.length - 1] as number) + 1,
    };
    if (near === undefined) return span;
    if (best === undefined || Math.abs(span.start - near) < Math.abs(best.start - near)) {
      best = span;
    }
  }
  return best;
}

/** A selection's text as a thread's quote: tidied, and cut with "…" at the quote limit. */
export function quoteOf(selection: string): string {
  const text = tidySelection(selection);
  return text.length <= THREAD_ANCHOR_QUOTE_MAX_CHARS
    ? text
    : `${text.slice(0, THREAD_ANCHOR_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * T503 (§3a): a thread on `entry`'s turn. With a selection, on that
 * passage: quoted, with its start and end in the turn's source when it
 * reads there (a selection the source doesn't match keeps the quote alone).
 */
export function anchorFor(
  entry: Pick<ThreadEntry, 'ts' | 'body'>,
  selection?: string,
): ThreadAnchor {
  if (selection === undefined) return { entry: entry.ts };
  const quote = quoteOf(selection);
  if (quote.trim() === '') return { entry: entry.ts };
  const span = findPassage(entry.body, quote);
  return span !== undefined
    ? { entry: entry.ts, start: span.start, end: span.end, quote }
    : { entry: entry.ts, quote };
}
