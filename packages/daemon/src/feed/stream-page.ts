/**
 * The stream page's one read (§9.3), `GET /api/streams/:id`: the record,
 * its path, the thread, rules in scope, docs and the Land preflight in one
 * response, so a `thread_appended` event is one re-fetch. The diff has its
 * own route: it runs git and is only wanted when its tab is open.
 */

import {
  type ChatBatch,
  type ChatMove,
  type ChatThread,
  type KnowledgeItem,
  type ModelPick,
  type QuestionThread,
  type Stream,
  type ThreadEntry,
  liveChildrenOf,
  nodeRole,
} from '@agile-agents/shared';
import type { DeliveryService, LandPreflight } from '../delivery/service';
import type { Doc, DocsService } from '../docs/service';
import type { KnowledgeService } from '../knowledge/service';
import type { ChatThreads } from '../questions/chat-threads';
import type { QuestionThreads } from '../questions/threads';
import type { StreamService } from '../streams/service';
import { rollupProgress } from '../trackers/rollup';

/** How much of the thread one read carries (the newest entries). */
export const STREAM_PAGE_THREAD_LIMIT = 500;

export interface StreamPagePayload {
  stream: Stream;
  /** Ancestor titles root→leaf, the stream's own last (§3.2's path). */
  path: string[];
  /** The newest `STREAM_PAGE_THREAD_LIMIT` entries, oldest first. */
  thread: ThreadEntry[];
  /** Total entries; more than `thread.length` means older ones were left out. */
  thread_total: number;
  /** Exactly the rules in scope (§9.3: "why was I denied" is one click), and T463's switched off here (`stream.rules_off`). */
  rules: KnowledgeItem[];
  /** In-scope rules Land checks against the whole diff (§8.2). */
  diff_rules: string[];
  /** Repo docs plus the stream docs of the stream and its ancestors. */
  docs: Doc[];
  /** Land's preflight; absent with no landing service. */
  land?: LandPreflight;
  /** T322: a linked node's roll-up, nodes merged of those counting toward its issue. */
  rollup?: { merged: number; total: number };
  /**
   * T482: what a start with no pick would run when that start is a routed
   * pick (the node never ran, or waits on a choose-again); absent when its
   * kept pick would run.
   */
  next_pick?: ModelPick;
  /**
   * T502 (D62): this node's question threads over the loaded lines: the
   * open questions (with their state) and those that have a thread.
   */
  question_threads?: QuestionThread[];
  /** T502 (D63): on a coordinating node or a project root, its children's questions as threads. */
  child_questions?: QuestionThread[];
  /** T503 (D60, D64): the chat threads on this node's turns, over the loaded lines. */
  chat_threads?: ChatThread[];
  /** T503 (§4.1): turns woken by lines from several threads: in the main flow, linking them. */
  chat_batches?: ChatBatch[];
  /** T504 (§6): lines moved to a thread or to the main flow (display only), over the loaded lines. */
  chat_moves?: ChatMove[];
}

export interface StreamPageSources {
  streams: StreamService;
  rules?: KnowledgeService;
  docs?: DocsService;
  landing?: DeliveryService;
  /** T482: the routed pick a start with no pick would make. */
  nextPick?: (stream: Stream) => ModelPick | undefined;
  /** T502: question threads (and, on a coordinator's node, its children's). */
  threads?: Pick<QuestionThreads, 'forNode' | 'forCoordinator'>;
  /** T503: chat threads on the node's turns. */
  chatThreads?: Pick<ChatThreads, 'forNode'>;
}

export function buildStreamPage(sources: StreamPageSources, id: string): StreamPagePayload {
  const { streams } = sources;
  const stream = streams.get(id);

  const path: string[] = [];
  const seen = new Set<string>();
  let current: Stream | undefined = stream;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.title);
    const parent: string | undefined = current.parent;
    try {
      current = parent === undefined ? undefined : streams.get(parent);
    } catch {
      current = undefined;
    }
  }

  const total = streams.readThread(id, { limit: 1 }).total;
  const from = Math.max(0, total - STREAM_PAGE_THREAD_LIMIT);
  const thread = streams.readThread(id, {
    ...(from > 0 ? { after: from - 1 } : {}),
    limit: STREAM_PAGE_THREAD_LIMIT,
  }).entries;

  // T463: the ones switched off here too, so the Knowledge tab can switch them back on.
  const rules = sources.rules?.inScope(id, undefined, undefined, { includeOff: true }) ?? [];
  const diffRules = sources.rules?.inScope(id, 'ship') ?? [];

  const rollup =
    stream.external_link !== undefined
      ? rollupProgress(stream, streams.list({ include_archived: true }))
      : undefined;

  // T502: derived over the loaded lines; an unreadable record leaves the page as it was.
  let questionThreads: QuestionThread[] | undefined;
  let childQuestions: QuestionThread[] | undefined;
  if (sources.threads !== undefined) {
    try {
      questionThreads = sources.threads.forNode(id, thread);
      const all = streams.list();
      const role = nodeRole(stream, liveChildrenOf(id, all), all);
      if (role === 'project' || role === 'coordinating') {
        childQuestions = sources.threads.forCoordinator(id, thread);
      }
    } catch (err) {
      console.error(`question threads of ${id}:`, err);
    }
  }

  // T503: derived over the loaded lines, as the question threads are.
  let chat: ReturnType<ChatThreads['forNode']> | undefined;
  if (sources.chatThreads !== undefined) {
    try {
      chat = sources.chatThreads.forNode(id, thread);
    } catch (err) {
      console.error(`chat threads of ${id}:`, err);
    }
  }

  return {
    stream,
    path,
    thread,
    thread_total: total,
    rules,
    diff_rules: diffRules.map((rule) => rule.id),
    docs: sources.docs?.docsForStream(id) ?? [],
    ...(sources.landing ? { land: sources.landing.preflight(id) } : {}),
    ...(rollup ? { rollup } : {}),
    ...(questionThreads !== undefined && questionThreads.length > 0
      ? { question_threads: questionThreads }
      : {}),
    ...(childQuestions !== undefined && childQuestions.length > 0
      ? { child_questions: childQuestions }
      : {}),
    ...(chat !== undefined && chat.threads.length > 0 ? { chat_threads: chat.threads } : {}),
    ...(chat !== undefined && chat.batches.length > 0 ? { chat_batches: chat.batches } : {}),
    ...(chat !== undefined && chat.moves.length > 0 ? { chat_moves: chat.moves } : {}),
    ...(() => {
      try {
        const next = sources.nextPick?.(stream);
        return next !== undefined ? { next_pick: next } : {};
      } catch {
        // A preview only: an unreadable layer leaves the page as it was.
        return {};
      }
    })(),
  };
}
