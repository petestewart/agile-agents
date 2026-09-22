/**
 * Local mirror of `packages/daemon/src/feed/snapshot.ts`'s `FeedSnapshot`
 * (`GET /api/snapshot`, `/ws`'s `{type:'snapshot', ...}` frame).
 * `packages/ui` cannot import it from `@agile-agents/daemon` — `daemon`
 * already imports `@agile-agents/ui` (`FEED_HTML_PATH`,
 * `CONTROL_ROOM_DIST_DIR`), so the reverse import would be a workspace
 * cycle. Keep in sync with `feed/snapshot.ts` by hand; a drift here shows up
 * as a `bun run typecheck`/build failure the moment a component reads a
 * field this mirror doesn't have.
 */

import type {
  Event,
  HilRequest,
  InboxItem,
  Question,
  Rule,
  Stream,
  ThreadEntry,
} from '@agile-agents/shared';

/** The project the daemon drives — the header's name, and its path on hover. */
export interface FeedProjectInfo {
  name: string;
  path: string;
}

export interface FeedStatusInfo {
  needs_you: number;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  hil: HilRequest[];
  questions: Question[];
  project?: FeedProjectInfo;
  status: FeedStatusInfo;
}

export function isFeedSnapshot(value: unknown): value is FeedSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'snapshot' &&
    Array.isArray((value as { events?: unknown }).events)
  );
}

/**
 * T160: mirror of `feed/snapshot.ts`'s `CockpitStreamRow` — one row of the
 * stream tree, carrying the two-writer status pair the dot reads (§9.2).
 */
export interface CockpitStreamRow {
  id: string;
  title: string;
  parent?: string;
  agent_status: Stream['agent']['status'];
  human_status: Stream['human']['status'];
}

/** T160: mirror of `feed/snapshot.ts`'s `CockpitFrame` — the inbox and the tree, pushed on connect and after every event batch. */
export interface CockpitFrame {
  type: 'cockpit';
  inbox: InboxItem[];
  streams: CockpitStreamRow[];
}

/** T161: mirror of `landing/service.ts`'s `LandPreflight` — the Land button's "before". */
export interface LandPreflight {
  ready: boolean;
  reason?: string;
  branch?: string;
  target?: string;
  ahead?: number;
  gated?: true;
  /** T166: already merged into the target outside `land`. */
  merged?: true;
}

/** T161: mirror of `docs/service.ts`'s `Doc`. */
export interface StreamDoc {
  source: 'repo' | 'stream';
  path: string;
  name: string;
  body: string;
}

/** T161: mirror of `feed/stream-page.ts`'s `StreamPagePayload` (`GET /api/streams/:id`). */
export interface StreamPagePayload {
  stream: Stream;
  path: string[];
  thread: ThreadEntry[];
  thread_total: number;
  rules: Rule[];
  diff_rules: string[];
  docs: StreamDoc[];
  land?: LandPreflight;
}

/** T161: mirror of `landing/service.ts`'s `StreamDiff` (`GET /api/streams/:id/diff`). */
export interface StreamDiff {
  stream: string;
  branch: string;
  target: string;
  worktree?: string;
  stat: string;
  patch: string;
  truncated: boolean;
}

/** T161: mirror of `landing/service.ts`'s `LandOutcome` — the Land button's "after". */
export type LandOutcome =
  | { status: 'gated'; gate: HilRequest; line: string }
  | { status: 'refused'; reason: string; line: string }
  | { status: 'blocked'; target: string; conflicts: string[]; line: string }
  | { status: 'landed'; target: string; sha: string; line: string };
