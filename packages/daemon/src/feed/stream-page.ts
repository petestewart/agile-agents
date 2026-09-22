/**
 * The stream page's one read (T161, design/cockpit-design.md §9.3):
 * `GET /api/streams/:id`. Everything the page shows that is not live on
 * the `/ws` cockpit frame — the record, its ancestor path, the thread, the
 * rules in scope, the docs and the Land button's "before" read — in one
 * response, so a `thread_appended` event is one re-fetch, not five.
 *
 * Read-only. The diff is its own route (`GET /api/streams/:id/diff`): it
 * runs git and is only wanted when its tab is open.
 */

import type { Rule, Stream, ThreadEntry } from '@agile-agents/shared';
import type { Doc, DocsService } from '../docs/service';
import type { LandPreflight, LandingService } from '../landing/service';
import type { RulesService } from '../rules/service';
import type { StreamService } from '../streams/service';

/** How much of the thread one read carries — the newest entries. */
export const STREAM_PAGE_THREAD_LIMIT = 500;

export interface StreamPagePayload {
  stream: Stream;
  /** Ancestor titles root→leaf, the stream's own last (§3.2's path). */
  path: string[];
  /** The newest `STREAM_PAGE_THREAD_LIMIT` entries, oldest first. */
  thread: ThreadEntry[];
  /** Total entries in the thread; more than `thread.length` means older ones were left out. */
  thread_total: number;
  /** Exactly `rulesInScope(stream)` (§9.3: "why was I denied" is one click). */
  rules: Rule[];
  /** Ids of the in-scope rules Land checks against the whole diff (stage `diff` or `both`, §8.2). */
  diff_rules: string[];
  /** Repo `.agile-docs/` and the stream docs of the stream and its ancestors (T134). */
  docs: Doc[];
  /** The Land button's "before": would `land` refuse right now, and why. Absent with no landing service. */
  land?: LandPreflight;
}

export interface StreamPageSources {
  streams: StreamService;
  rules?: RulesService;
  docs?: DocsService;
  landing?: LandingService;
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
  const diffRules = sources.rules?.inScope(id, 'diff') ?? [];

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
