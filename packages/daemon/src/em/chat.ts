/**
 * EM chat thread (T041 — design §17 "EM chat", §5 "Comms bus").
 *
 * The thread is the bus, not a new store: a human line is the `fyi` message
 * `POST /api/chat/em` has always written to the EM's inbox, and the EM's
 * reply is the mirror-image `fyi` from `em` to `human` (§5 routing: "em →
 * anyone"). Nothing new is written under `.agile/` — `history()` just reads
 * both inboxes (unread + `done/`, since a polled message moves), which is
 * what makes a page reload show the same conversation.
 *
 * Bodies are capped at `MESSAGE_BODY_MAX_CHARS` like every other message.
 * A longer reply follows the repo's "signal over volume" rule the same way
 * a tool's raw output does: the full text is written to
 * `.agile-daemon-cache/raw/em-chat/<message id>.md` (`tools/cache.ts`'s
 * `rawOutputPath`/`writeRawOutput` — host-local, gitignored, exactly the
 * existing precedent) and the message body carries the head plus a pointer,
 * with the path in `refs`. `history()` re-hydrates from that file so the
 * reloaded thread reads the same as the streamed one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { MESSAGE_BODY_MAX_CHARS, type Message, ulid, validateMessage } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import type { QuestionService } from '../questions';
import type { StateStore } from '../store';
import { rawOutputPath, writeRawOutput } from '../tools/cache';

/** The one chat thread this daemon serves. Named so the `/ws` frames can carry a thread id without inventing a second concept today. */
export const EM_CHAT_THREAD = 'em';

/** Raw-output bucket for over-cap EM replies (`.agile-daemon-cache/raw/em-chat/`). */
const CHAT_RAW_BUCKET = 'em-chat';

/** How much of an over-cap reply stays in the message body, leaving room for the pointer suffix. */
const POINTER_MARGIN_CHARS = 120;

/** One rendered line of the chat thread, as `GET /api/chat/em` returns it. */
export interface ChatEntry {
  id: string;
  ts: string;
  from: 'human' | 'em';
  /** The full text — re-hydrated from the raw-output file when the message body was capped. */
  body: string;
  /** Present when the body was capped and the full text lives in a file. */
  ref?: string;
}

function isChatMessage(message: Message): boolean {
  if (message.kind !== 'fyi') return false;
  if (message.from === 'human') return message.to.includes('em');
  if (message.from === 'em') return message.to.includes('human');
  return false;
}

/** Every message file in an agent's inbox, unread and acked alike — the acked half is why a polled EM inbox doesn't lose the thread. */
function inboxMessages(store: StateStore, agent: string): Message[] {
  return [
    ...store.listEntities(`bus/inbox/${agent}`, validateMessage),
    ...store.listEntities(`bus/inbox/${agent}/done`, validateMessage),
  ];
}

function hydrate(repoRoot: string, message: Message): ChatEntry {
  const ref = message.refs.find((r) => r.startsWith(`${CHAT_RAW_BUCKET}/`));
  let body = message.body;
  if (ref) {
    const path = rawOutputPath(repoRoot, CHAT_RAW_BUCKET, ref.slice(`${CHAT_RAW_BUCKET}/`.length));
    try {
      if (existsSync(path)) body = readFileSync(path, 'utf8');
    } catch {
      // The pointer is host-local and best-effort: a missing or unreadable
      // raw file degrades to the capped body, never to a failed read of the
      // whole thread.
    }
  }
  return {
    id: message.id,
    ts: message.ts,
    from: message.from as 'human' | 'em',
    body,
    ...(ref ? { ref } : {}),
  };
}

/**
 * The chat thread, oldest first. Ids are ulids, so id order is send order —
 * the same ordering rule `Bus.poll` uses to break priority ties.
 */
export function readChatThread(store: StateStore, repoRoot: string): ChatEntry[] {
  const messages = [...inboxMessages(store, 'em'), ...inboxMessages(store, 'human')].filter(
    isChatMessage,
  );
  // One message per id: a `fyi` to `['em', 'human']` would be filed in both
  // inboxes and must still read as a single line.
  const unique = new Map(messages.map((m) => [m.id, m]));
  return [...unique.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => hydrate(repoRoot, m));
}

/**
 * Renders the EM's reply into a message body: the text itself when it fits,
 * otherwise the head plus a pointer to the raw-output file (which this
 * writes). Returns the body and the `refs` entry, if any.
 */
export function renderReplyBody(
  repoRoot: string,
  messageId: string,
  text: string,
): { body: string; refs: string[] } {
  const trimmed = text.trim().length > 0 ? text.trim() : '(the EM session replied with nothing)';
  if (trimmed.length <= MESSAGE_BODY_MAX_CHARS) return { body: trimmed, refs: [] };
  const fileName = `${messageId}.md`;
  const ref = `${CHAT_RAW_BUCKET}/${fileName}`;
  writeRawOutput(rawOutputPath(repoRoot, CHAT_RAW_BUCKET, fileName), trimmed);
  const suffix = `\n… full reply: ${ref}`;
  const head = trimmed.slice(0, MESSAGE_BODY_MAX_CHARS - POINTER_MARGIN_CHARS);
  return { body: `${head}${suffix}`.slice(0, MESSAGE_BODY_MAX_CHARS), refs: [ref] };
}

/**
 * The attention queue the daemon injects into the EM's chat context (§17
 * "Technical shape": "the daemon injects the attention queue into the EM
 * context"): every open `hil_request` and every open question, so "what is
 * left on all tickets" is answerable without the EM having to go looking.
 * Capped to a handful of lines each — this rides on every turn.
 */
export function renderAttentionQueue(gates?: GateService, questions?: QuestionService): string {
  const hil = (gates?.list() ?? []).filter((r) => r.status === 'pending').slice(0, 10);
  const open = (questions?.listOpen() ?? []).slice(0, 10);
  if (hil.length === 0 && open.length === 0) return 'Attention queue: empty.';
  const lines = ['Attention queue (daemon-injected, current as of this turn):'];
  for (const req of hil) {
    lines.push(
      `- hil ${req.id}: gate ${req.gate}${req.ticket ? ` (${req.ticket})` : ''} — ${req.summary ?? 'no summary'}`,
    );
  }
  for (const q of open) {
    lines.push(`- question ${q.id}${q.ticket ? ` (${q.ticket})` : ''}: ${q.text}`);
  }
  return lines.join('\n');
}

export interface EmChatDeps {
  store: StateStore;
  bus: Bus;
  repoRoot: string;
  gates?: GateService;
  questions?: QuestionService;
  /** The resident EM session. Absent (or dead) means the human's line still lands on the bus; only the reply is missing. */
  resident?: { prompt(text: string): AsyncIterable<string> & { done: Promise<string> } };
  now?: () => Date;
}

export interface ChatSendHooks {
  onDelta(messageId: string, text: string): void;
  onEnd(messageId: string, error?: string): void;
}

export interface ChatSendResult {
  /** The human's message as filed on the bus. */
  message: Message;
  /** The id the EM's reply will carry — the same id the `chat_delta`/`chat_turn_end` frames use. */
  replyId?: string;
  /** `false` when there is no resident EM to answer (the line is still on the EM's inbox). */
  streaming: boolean;
  /** Why nothing is streaming, when `streaming` is false. */
  reason?: string;
}

/**
 * `POST`/`GET /api/chat/em`'s whole behaviour, one object: file the human's
 * line on the bus (unchanged from T025), then run one resident EM turn,
 * streaming deltas through `hooks` and appending the finished reply to the
 * bus as an `em → human` message so the thread survives a reload.
 */
export class EmChatService {
  constructor(private readonly deps: EmChatDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  history(): ChatEntry[] {
    return readChatThread(this.deps.store, this.deps.repoRoot);
  }

  /** Builds the prompt one chat turn gets: the attention queue, then the human's line. The role brief itself is the session's first turn (`ResidentEm` is seeded with it by the daemon). */
  buildPrompt(body: string): string {
    return [
      renderAttentionQueue(this.deps.gates, this.deps.questions),
      '',
      'The human just wrote to you in the control room chat. Answer them directly and concisely; use your `agile` verbs to read the board when you need facts rather than guessing.',
      '',
      `Human: ${body}`,
    ].join('\n');
  }

  /**
   * Returns as soon as the human's line is on the bus and the turn is
   * queued — the reply arrives through `hooks`, not through this promise,
   * so the browser's POST never blocks on a model turn.
   */
  async send(
    input: { body: string; ticket?: string },
    hooks: ChatSendHooks,
  ): Promise<ChatSendResult> {
    const sent = await this.deps.bus.send({
      id: ulid(),
      ts: this.now().toISOString(),
      from: 'human',
      to: ['em'],
      kind: 'fyi',
      priority: 'normal',
      body: input.body,
      ...(input.ticket !== undefined ? { ticket: input.ticket } : {}),
    });
    if (!sent.ok) throw new Error(sent.reason);
    const message = sent.message as Message;

    const resident = this.deps.resident;
    if (!resident) {
      return { message, streaming: false, reason: 'no resident EM session is configured' };
    }

    const replyId = ulid();
    const turn = resident.prompt(this.buildPrompt(input.body));
    void this.relay(replyId, turn, hooks);
    return { message, replyId, streaming: true };
  }

  /** Streams one turn out to `hooks` and files the completed reply on the bus. Never throws — a failed turn ends the stream with an error frame. */
  private async relay(
    replyId: string,
    turn: AsyncIterable<string> & { done: Promise<string> },
    hooks: ChatSendHooks,
  ): Promise<void> {
    // Attached before anything awaits it: a turn that fails during the
    // delta stream leaves `done` rejected and otherwise unobserved, which
    // Bun reports as an unhandled rejection and kills the process.
    void turn.done.catch(() => undefined);
    try {
      for await (const chunk of turn) hooks.onDelta(replyId, chunk);
      const full = await turn.done;
      await this.appendReply(replyId, full);
      hooks.onEnd(replyId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The failure is part of the thread, not just a UI toast: without it a
      // reload would show a human line with no answer and no explanation.
      await this.appendReply(replyId, `(the EM session could not answer: ${message})`).catch(
        () => undefined,
      );
      hooks.onEnd(replyId, message);
    }
  }

  private async appendReply(replyId: string, text: string): Promise<void> {
    const { body, refs } = renderReplyBody(this.deps.repoRoot, replyId, text);
    const result = await this.deps.bus.send({
      id: replyId,
      ts: this.now().toISOString(),
      from: 'em',
      to: ['human'],
      kind: 'fyi',
      priority: 'normal',
      body,
      refs,
    });
    if (!result.ok) throw new Error(`EM chat reply rejected by the bus: ${result.reason}`);
  }
}
