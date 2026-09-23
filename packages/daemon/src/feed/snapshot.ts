/**
 * The feed snapshot, built fresh on every `GET /api/snapshot` and new
 * `/ws` connection so a client catches up without replaying the log: the
 * event tail, pending gates, open questions and the project block. Plus
 * the cockpit frame (inbox and stream tree).
 */

import { basename } from 'node:path';
import type { Event, HilRequest, InboxItem, Question, Stream } from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { InboxService } from '../inbox';
import type { QuestionService } from '../questions';
import type { StateStore } from '../store';
import type { StreamService } from '../streams';

/** How many recent events a snapshot carries. */
export const DEFAULT_SNAPSHOT_EVENT_LIMIT = 200;

/** The top bar's project: `name` shown, `path` on hover. From the daemon's repo root, never the browser. */
export interface FeedProjectInfo {
  name: string;
  path: string;
}

/** What the always-on top bar renders. */
export interface FeedStatusInfo {
  /** Pending gates + open questions: the Needs-you count. */
  needs_you: number;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  hil: HilRequest[];
  /** Open questions (answered ones are history); empty with no `QuestionService`. */
  questions: Question[];
  /** Absent when no project root was supplied. */
  project?: FeedProjectInfo;
  status: FeedStatusInfo;
}

export function buildSnapshot(
  store: StateStore,
  gates: GateService,
  eventLimit: number = DEFAULT_SNAPSHOT_EVENT_LIMIT,
  /** Without it, `questions` is empty. */
  questions?: QuestionService,
  /** The repo root; without it, no `project`. */
  projectRoot?: string,
): FeedSnapshot {
  const events = store.listEvents().slice(-eventLimit);
  // Resolved gates are history: only pending ones ship.
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

/** One row of the stream tree (§9.2): title, nesting, and the status pair the dot is derived from client-side. */
export interface CockpitStreamRow {
  id: string;
  title: string;
  parent?: string;
  agent_status: Stream['agent']['status'];
  human_status: Stream['human']['status'];
}

/** The cockpit's live frame: inbox and stream tree, pushed on connect and after every event batch (§3.3). */
export interface CockpitFrame {
  type: 'cockpit';
  inbox: InboxItem[];
  streams: CockpitStreamRow[];
}

export function buildCockpitFrame(streams: StreamService, inbox?: InboxService): CockpitFrame {
  return {
    type: 'cockpit',
    inbox: inbox?.list() ?? [],
    streams: streams.list().map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
      agent_status: s.agent.status,
      human_status: s.human.status,
    })),
  };
}
