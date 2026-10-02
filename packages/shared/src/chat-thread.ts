/**
 * T503 (D60, D61, D64, design/chat-threads.md §3a, §4, §6, §7): a chat
 * thread on a turn, as the node page reads it. Derived on every read from
 * the thread's lines and their deliveries, never stored: the only stored
 * fields are a line's `thread` and its first reply's `anchor`
 * (`ThreadEntrySchema`).
 */

import { z } from 'zod';
import { UlidSchema } from './ids';
import { QuestionIdSchema } from './question';
import { ChatThreadIdSchema, ThreadAnchorSchema } from './stream';

/**
 * Where a chat thread stands (§6), from its lines:
 *
 * - `waiting_on_agent`: your latest reply in it is with the agent, and the
 *   turn it started hasn't finished.
 * - `waits_on_you`: a question asked in it is open.
 * - `resolved`: the questions asked in it are all answered, and you haven't
 *   written in it since (replying again reopens it).
 * - `open`: anything else (the agent answered; nothing waits).
 */
export const CHAT_THREAD_STATES = ['open', 'waits_on_you', 'waiting_on_agent', 'resolved'] as const;
export const ChatThreadStateSchema = z.enum(CHAT_THREAD_STATES);
export type ChatThreadState = z.infer<typeof ChatThreadStateSchema>;

/** How many lines one chat thread lists (a page reads at most 500). */
export const CHAT_THREAD_ENTRIES_MAX = 500;

export const ChatThreadSchema = z
  .object({
    /** Its first reply's `ts`. */
    id: ChatThreadIdSchema,
    stream: UlidSchema,
    /** The turn (and passage) it is on. */
    anchor: ThreadAnchorSchema,
    state: ChatThreadStateSchema,
    /** Its lines: your replies, the agent's (by cause or by its own `thread`), its questions. */
    replies: z.number().int().nonnegative(),
    /** Their `ts`, oldest first. */
    entries: z.array(z.string().min(1)).max(CHAT_THREAD_ENTRIES_MAX),
    /** When its last line was written. */
    last_at: z.string().min(1),
    /** When its last line not yours was written (unread is this against your read mark). */
    reply_at: z.string().min(1).optional(),
    /** The questions asked in it still open (they show in the main flow and Needs me too, §6). */
    questions: z.array(QuestionIdSchema).max(50).optional(),
    /** The node's agent's vendor (`codex`), for "Waiting on Codex". */
    vendor: z.string().min(1).max(80).optional(),
  })
  .strict();
export type ChatThread = z.infer<typeof ChatThreadSchema>;

/**
 * §4.1: a turn woken by lines from more than one thread (or the main flow
 * and a thread) posts in the main flow; its lines link the threads it
 * replies to ("replies to: ⓐ ⓑ").
 */
export const ChatBatchSchema = z
  .object({
    entries: z.array(z.string().min(1)).min(1).max(CHAT_THREAD_ENTRIES_MAX),
    threads: z.array(ChatThreadIdSchema).min(1).max(50),
  })
  .strict();
export type ChatBatch = z.infer<typeof ChatBatchSchema>;

/** A node's thread with a reply you may not have read (the rail row's unread mark, §6). */
export const ChatThreadReplySchema = z
  .object({ thread: ChatThreadIdSchema, at: z.string().min(1) })
  .strict();
export type ChatThreadReply = z.infer<typeof ChatThreadReplySchema>;

/** How many of a node's threads its rail row carries (the newest replies). */
export const CHAT_THREAD_REPLIES_MAX = 20;
