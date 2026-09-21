/**
 * Feed snapshot (T020 — "Feed: event log tailed live"; "Attention queue:
 * every open `hil_request`"). Assembled fresh from the `StateStore`/
 * `GateService` on every `GET /api/snapshot` and on every new `/ws`
 * connection, so a client that just opened the page (or just reconnected
 * after a drop) gets caught up without replaying the whole event log itself.
 *
 * T122 cut the top strip, the ticket stories, the Team table and the
 * vendor barometer out of it with the subsystems that fed them; what is left
 * is the event tail, the open gates, the open questions and the top bar's
 * project block. The cockpit's own shell is rebuilt in Phase 6.
 */

import { basename } from 'node:path';
import type { Event, HilRequest, Question } from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { QuestionService } from '../questions';
import type { StateStore } from '../store';

/** Default cap on how many recent events a snapshot carries (ticket: "last N (e.g. 200)"). */
export const DEFAULT_SNAPSHOT_EVENT_LIMIT = 200;

/**
 * T043 (§17 "Control room v2" — "Top bar is identical on every view"): the
 * project the daemon is driving. `name` is what the bar shows, `path` is
 * what it shows on hover. Derived from the daemon's own repo root, never
 * from anything a browser sends.
 */
export interface FeedProjectInfo {
  name: string;
  path: string;
}

/** T043: what the always-on top bar renders, in one read the control room already makes. */
export interface FeedStatusInfo {
  /** Open HIL requests + open questions — the Needs-you count. */
  needs_you: number;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  hil: HilRequest[];
  /**
   * T040: the *open* questions, which are attention-queue items exactly like
   * a pending `hil_request`. Answered ones are history and stay out, same
   * rule as `hil` above. Empty when no `QuestionService` is wired.
   */
  questions: Question[];
  /** T043: the top bar's project name/path. Absent only when no project root was supplied. */
  project?: FeedProjectInfo;
  status: FeedStatusInfo;
}

export function buildSnapshot(
  store: StateStore,
  gates: GateService,
  eventLimit: number = DEFAULT_SNAPSHOT_EVENT_LIMIT,
  /** T040: optional — without it the snapshot carries an empty `questions` array. */
  questions?: QuestionService,
  /** T043: the repo root the daemon is driving. Optional — without it the snapshot carries no `project`. */
  projectRoot?: string,
): FeedSnapshot {
  const events = store.listEvents().slice(-eventLimit);
  // "the open hil_request list" (T020 scope) — resolved requests are history,
  // not attention-queue items, so the snapshot only ships pending ones.
  const hil = gates.list().filter((request) => request.status === 'pending');
  const openQuestions = questions?.listOpen() ?? [];

  return {
    type: 'snapshot',
    events,
    hil,
    questions: openQuestions,
    ...(projectRoot
      ? { project: { name: basename(projectRoot) || projectRoot, path: projectRoot } }
      : {}),
    status: { needs_you: hil.length + openQuestions.length },
  };
}
