/**
 * Local mirror of `packages/daemon/src/feed/snapshot.ts`'s `FeedSnapshot` /
 * `FeedQuotaInfo` (`GET /api/snapshot`, `/ws`'s `{type:'snapshot', ...}`
 * frame). `packages/ui` cannot import them from `@agile-agents/daemon` —
 * `daemon` already imports `@agile-agents/ui` (`FEED_HTML_PATH`,
 * `CONTROL_ROOM_DIST_DIR`), so the reverse import would be a workspace
 * cycle (repo rule: "no workspace cycles — `ui` never imports `daemon` at
 * runtime, HTTP/WebSocket/RPC only"). Neither type is a zod schema —
 * `packages/shared` is for "schemas + types, defined once" in the zod
 * sense; these are plain wire-shape interfaces already defined once in
 * `daemon`, so this file is a type-only mirror of that JSON shape, not a
 * second definition of a schema. Keep in sync with `feed/snapshot.ts` by
 * hand; a drift here shows up as a `bun run typecheck`/build failure the
 * moment a component reads a field this mirror doesn't have.
 */

import type { Event, Halt, HilRequest, Question, Sprint } from '@agile-agents/shared';

export interface TicketsSummary {
  done: number;
  in_flight: number;
  stale: number;
  total: number;
}

export interface FeedSprintInfo {
  sprint?: Sprint;
  tickets: TicketsSummary;
}

export interface FeedQuotaInfo {
  vendor: string;
  account: string;
  remaining_fraction: number;
  cooldown_until: string | null;
  confidence: 'reported' | 'estimated' | 'low';
  spend_usd?: number;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  sprint: FeedSprintInfo;
  halts: Halt[];
  hil: HilRequest[];
  /** T040: the open questions (`board/questions/Q-*.yaml`) — Needs-you cards alongside the pending HIL requests. */
  questions: Question[];
  quota: FeedQuotaInfo[];
}
