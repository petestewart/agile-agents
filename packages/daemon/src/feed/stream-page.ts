/**
 * The stream page's one read (§9.3), `GET /api/streams/:id`: the record,
 * its path, the thread, rules in scope, docs and the Land preflight in one
 * response, so a `thread_appended` event is one re-fetch. The diff has its
 * own route: it runs git and is only wanted when its tab is open.
 */

import type { KnowledgeItem, Stream, ThreadEntry } from '@agile-agents/shared';
import type { DeliveryService, LandPreflight } from '../delivery/service';
import type { Doc, DocsService } from '../docs/service';
import type { KnowledgeService } from '../knowledge/service';
import type { StreamService } from '../streams/service';

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
  /** Exactly the rules in scope (§9.3: "why was I denied" is one click). */
  rules: KnowledgeItem[];
  /** In-scope rules Land checks against the whole diff (§8.2). */
  diff_rules: string[];
  /** Repo docs plus the stream docs of the stream and its ancestors. */
  docs: Doc[];
  /** Land's preflight; absent with no landing service. */
  land?: LandPreflight;
}

export interface StreamPageSources {
  streams: StreamService;
  rules?: KnowledgeService;
  docs?: DocsService;
  landing?: DeliveryService;
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

  const rules = sources.rules?.inScope(id) ?? [];
  const diffRules = sources.rules?.inScope(id, 'ship') ?? [];

  return {
    stream,
    path,
    thread,
    thread_total: total,
    rules,
    diff_rules: diffRules.map((rule) => rule.id),
    docs: sources.docs?.docsForStream(id) ?? [],
    ...(sources.landing ? { land: sources.landing.preflight(id) } : {}),
  };
}
