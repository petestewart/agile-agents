/**
 * The feed snapshot, built fresh on every `GET /api/snapshot` and new
 * `/ws` connection so a client catches up without replaying the log: the
 * event tail, pending gates, open questions and the project block. Plus
 * the cockpit frame (inbox and stream tree).
 */

import { basename } from 'node:path';
import {
  type Event,
  type HilRequest,
  type InboxItem,
  type NodeRole,
  type Question,
  type ReposConfig,
  type Stream,
  liveChildrenOf,
  nodeRole,
} from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { InboxService } from '../inbox';
import { canReadRepo } from '../permissions/visibility';
import type { ProjectService } from '../projects';
import type { QuestionService } from '../questions';
import type { StateStore } from '../store';
import type { StreamService } from '../streams';
import { type Overlap, findOverlaps, overlapMarked } from '../sync';

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
  /** T208: the node's project, and its derived role (P1). */
  project?: string;
  role: NodeRole;
  agent_status: Stream['agent']['status'];
  human_status: Stream['human']['status'];
  /** T209: the repo a work node is on (the repo view groups by it). */
  repo?: string;
  /** T209: a session is starting, running or idle (the Running lens). */
  live?: true;
  /** T209: the nodes this one still waits on (the Dependencies lens). */
  waits_on?: string[];
  /** T227: this node, or a descendant, shares a changed file with another live node. */
  overlap?: true;
  /** T229 (P13): a live session's vendor has no pre-tool-use hook, and a private repo is hidden from this node: the deny is advisory only. */
  visibility_advisory?: true;
}

/** Vendors whose tool calls pass the `agile hook` path check (Claude's hook, Pi's extension). */
const HOOKED_VENDORS = new Set(['claude', 'pi']);

function visibilityAdvisory(s: Stream, repos: ReposConfig): boolean {
  const hookless = s.sessions.some(
    (x) => LIVE_SESSION.has(x.status) && !HOOKED_VENDORS.has(x.vendor),
  );
  return hookless && Object.keys(repos).some((name) => !canReadRepo(repos, name, s.project));
}

/** The cockpit's live frame: inbox and stream tree, pushed on connect and after every event batch (§3.3). */
export interface CockpitFrame {
  type: 'cockpit';
  inbox: InboxItem[];
  streams: CockpitStreamRow[];
  /** T208: the live projects, for the rail's switcher and grouping. */
  projects: CockpitProjectRow[];
  /** T209: the registered repos and their delivery mode (the repo view). */
  repos: CockpitRepoRow[];
  /** T227: live work nodes on one repo that changed the same files (§4.3). */
  overlaps: Overlap[];
}

/** One registered repo (T209). `delivery` is `direct` unless repos.yaml says otherwise. */
export interface CockpitRepoRow {
  name: string;
  delivery: 'direct' | 'pr';
}

const LIVE_SESSION = new Set(['starting', 'running', 'idle']);

/** One entry of the rail's project switcher (T208). */
export interface CockpitProjectRow {
  id: string;
  name: string;
  root: string;
  /** T282: the project's autonomy levels (the root node's Autonomy picker). */
  autonomy?: {
    coordinator: 'advise' | 'organise' | 'run';
    director: 'advise' | 'organise' | 'run';
  };
}

export function buildCockpitFrame(
  streams: StreamService,
  inbox?: InboxService,
  projects?: ProjectService,
  repos: ReposConfig = {},
): CockpitFrame {
  const all = streams.list();
  const overlaps = findOverlaps(all);
  const marked = overlapMarked(overlaps, all);
  return {
    type: 'cockpit',
    inbox: inbox?.list() ?? [],
    streams: all.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
      ...(s.project !== undefined ? { project: s.project } : {}),
      role: nodeRole(s, liveChildrenOf(s.id, all)),
      agent_status: s.agent.status,
      human_status: s.human.status,
      ...(s.repo !== undefined ? { repo: s.repo } : {}),
      ...(s.sessions.some((x) => LIVE_SESSION.has(x.status)) ? { live: true as const } : {}),
      ...waitsOn(s),
      ...(marked.has(s.id) ? { overlap: true as const } : {}),
      ...(visibilityAdvisory(s, repos) ? { visibility_advisory: true as const } : {}),
    })),
    projects: (projects?.list() ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      autonomy: p.autonomy,
    })),
    repos: Object.entries(repos).map(([name, entry]) => ({
      name,
      delivery: entry.delivery ?? 'direct',
    })),
    overlaps,
  };
}

function waitsOn(s: Stream): { waits_on?: string[] } {
  const open = (s.waits_on ?? []).filter((w) => w.satisfied_at === undefined).map((w) => w.node);
  return open.length > 0 ? { waits_on: open } : {};
}
