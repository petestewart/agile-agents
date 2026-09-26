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
  type ProjectSessionDefaults,
  type Question,
  type RepoEntry,
  type RepoRemote,
  type ReposConfig,
  type SessionRef,
  type SessionRole,
  type StatusCard,
  type Stream,
  type TrackerSettings,
  isAgentRole,
  liveChildrenOf,
  nodeRole,
  validateEvent,
} from '@agile-agents/shared';
import { stoppedByHuman } from '../events/wake';
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
  /**
   * Read events only up to this byte of `events.jsonl`. The `/ws` connect
   * snapshot passes the live tailer's offset, so every line is either in the
   * snapshot or published afterwards by the tailer, never both.
   */
  eventsEndOffset?: number,
  /** T404: the newest events, kept by `RecentEvents`; the log is not read when given. */
  recent?: readonly Event[],
): FeedSnapshot {
  const events = (recent ?? store.listEvents(eventsEndOffset)).slice(-eventLimit);
  // T389: a deleted (archived) node's asks wait with it, as Needs me leaves them out.
  const archived = new Set(
    store
      .listStreams()
      .filter((s) => s.archived === true)
      .map((s) => s.id),
  );
  // Resolved gates are history: only pending ones ship.
  const hil = gates
    .list()
    .filter((request) => request.status === 'pending' && !archived.has(request.stream));
  const openQuestions = (questions?.listOpen() ?? []).filter((q) => !archived.has(q.stream));

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

/**
 * T404: the newest events up to the feed tailer's seam, kept in memory. The
 * log is read once when the server starts, then each batch the tailer reads
 * is added, so a `/ws` connect no longer re-reads and re-validates the whole
 * `events.jsonl`. Its events are exactly the log's up to the tailer's offset,
 * so a line is either in a connect's snapshot or published afterwards, never both.
 */
export class RecentEvents {
  private events: Event[] = [];

  constructor(private readonly limit: number = DEFAULT_SNAPSHOT_EVENT_LIMIT) {}

  /** The log up to `endOffset`. A corrupt log throws, with its path, as `listEvents` does. */
  load(store: StateStore, endOffset: number): void {
    this.events = store.listEvents(endOffset).slice(-this.limit);
  }

  /** One tailer batch. A line that isn't an event is reported and left out. */
  add(batch: readonly unknown[], onError?: (err: Error) => void): void {
    for (const raw of batch) {
      try {
        this.events.push(validateEvent(raw));
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
    // Trimmed in batches: at most a quarter over the limit between trims.
    if (this.events.length > this.limit + Math.ceil(this.limit / 4)) {
      this.events = this.events.slice(-this.limit);
    }
  }

  /** The newest events, oldest first, at most the limit. */
  list(): Event[] {
    return this.events.slice(-this.limit);
  }
}

function diffStatRow(stat: CockpitStreamRow['diff_stat']): Pick<CockpitStreamRow, 'diff_stat'> {
  return stat !== undefined ? { diff_stat: { ...stat } } : {};
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
  /** T336: a part not yet started because its coordinator's plan is not approved. */
  waiting_for_plan?: true;
  /** T341: its PR is open, so it merges on GitHub (not the operator's move here). */
  pr_open?: true;
  /** T380: its agent finished and its branch has no commits beyond its target: nothing to merge. */
  nothing_to_merge?: true;
  /** T410: a finished node's change, what Merge would bring: files, lines added and removed. */
  diff_stat?: { files: number; added: number; removed: number };
  /** T395: its last change (ISO): the latest of its creation, its agent's last status and its thread's last line. */
  updated_at?: string;
  /** T361: a work node or conversation whose agent never ran (made with "Start later"). */
  never_started?: true;
  /** T361: its agent ran and the human stopped it; nothing is live and the node is still open. */
  stopped?: true;
  /** T382: the live session Running names (`liveAgent`); absent when nothing is live. */
  live_agent?: CockpitLiveAgent;
}

/** T382: what a live node runs: its session's role, vendor, model and effort. */
export interface CockpitLiveAgent {
  role: SessionRole;
  vendor: string;
  model: string;
  /** Absent for a vendor with no effort mapping (the session records none). */
  effort?: SessionRef['effort'];
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
  /** T283 (§14.5): the status cards of child nodes, shown on the parent's page. */
  cards: CockpitCard[];
  /** T338: every contract's title and owning node, so the cockpit names contracts, not ids. */
  contracts: CockpitContractRow[];
  /** T361: deleted (archived) nodes the cockpit can restore, most recently deleted first. */
  archived?: CockpitArchivedRow[];
}

/** T361: one deleted node: its parent is not deleted, so Restore can bring it back. */
export interface CockpitArchivedRow {
  id: string;
  title: string;
  project?: string;
  parent?: string;
}

/** T361: how many deleted nodes the frame lists. */
export const COCKPIT_ARCHIVED_MAX = 200;

export interface CockpitContractRow {
  id: string;
  title: string;
  node: string;
}

/** A card, or the refusal of a corrupt one (path:line) so the rest still render. */
export type CockpitCard = StatusCard | { node: string; error: string };

/** One registered repo (T209). `delivery` is `direct` unless repos.yaml says otherwise. */
export interface CockpitRepoRow {
  name: string;
  delivery: 'direct' | 'pr';
  /** T362: where its remote (`remote`, else `origin`) lives; absent for a local-only repo, or not read yet. */
  remote?: RepoRemote;
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
  /** T338: the project's repos and tracker settings (the root node's project controls). */
  repos?: string[];
  tracker?: TrackerSettings;
  /** T379: the project's own session defaults (P5), between a flag and the repo's. */
  session?: ProjectSessionDefaults;
}

/** The latest of some ISO times (they compare as strings); the first when the rest are missing. */
function latest(first: string, ...rest: Array<string | undefined>): string {
  let at = first;
  for (const t of rest) if (t !== undefined && t > at) at = t;
  return at;
}

export function buildCockpitFrame(
  streams: StreamService,
  inbox?: InboxService,
  projects?: ProjectService,
  repos: ReposConfig = {},
  cardOf?: (node: string) => StatusCard | undefined,
  contracts?: { list(): CockpitContractRow[] },
  waitingForPlan?: (node: Stream) => boolean,
  /** T362: a repo's remote, from a cache: the frame never waits on git. */
  remoteOf?: (entry: RepoEntry) => RepoRemote | undefined,
  /** T380: a finished node with nothing to merge, from a cache (`NothingToMergeCache`). */
  nothingToMerge?: (node: Stream) => boolean,
  /** T395: when a node's thread last changed (`StateStore.threadUpdatedAt`). */
  threadUpdatedAt?: (node: string) => string | undefined,
  /** T410: a finished node's change size, from the same cache as `nothingToMerge`. */
  diffStatOf?: (node: Stream) => CockpitStreamRow['diff_stat'],
): CockpitFrame {
  // One read of the home: the archived ones are only for Restore (T361).
  const everything = streams.list({ include_archived: true });
  const all = everything.filter((s) => s.archived !== true);
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
      role: nodeRole(s, liveChildrenOf(s.id, all), all),
      agent_status: s.agent.status,
      human_status: s.human.status,
      ...(s.repo !== undefined ? { repo: s.repo } : {}),
      ...(s.sessions.some((x) => LIVE_SESSION.has(x.status)) ? { live: true as const } : {}),
      ...waitsOn(s),
      ...(marked.has(s.id) ? { overlap: true as const } : {}),
      ...(visibilityAdvisory(s, repos) ? { visibility_advisory: true as const } : {}),
      ...(waitingForPlan?.(s) === true ? { waiting_for_plan: true as const } : {}),
      ...(s.delivery_state?.status === 'pr_open' ? { pr_open: true as const } : {}),
      ...(nothingToMerge?.(s) === true ? { nothing_to_merge: true as const } : {}),
      ...diffStatRow(diffStatOf?.(s)),
      updated_at: latest(s.created_at, s.agent.updated_at, threadUpdatedAt?.(s.id)),
      ...startState(s, all),
      ...liveAgent(s),
    })),
    projects: (projects?.list() ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      autonomy: p.autonomy,
      repos: p.repos,
      ...(p.tracker !== undefined ? { tracker: p.tracker } : {}),
      ...(p.session !== undefined ? { session: p.session } : {}),
    })),
    repos: Object.entries(repos).map(([name, entry]) => {
      const remote = remoteOf?.(entry);
      return {
        name,
        delivery: entry.delivery ?? 'direct',
        ...(remote !== undefined ? { remote } : {}),
      };
    }),
    overlaps,
    cards: all.flatMap((s): CockpitCard[] => {
      if (s.parent === undefined || cardOf === undefined) return [];
      try {
        const card = cardOf(s.id);
        return card !== undefined ? [card] : [];
      } catch (err) {
        return [{ node: s.id, error: err instanceof Error ? err.message : String(err) }];
      }
    }),
    contracts: (contracts?.list() ?? []).map((c) => ({ id: c.id, title: c.title, node: c.node })),
    ...archivedRows(everything),
  };
}

/**
 * T361: `never_started` for a work node or conversation that has never had
 * a worker (or coordinator); `stopped` for a node whose agent ran and the
 * human stopped (`stoppedByHuman`), with nothing live, still open.
 */
function startState(s: Stream, all: readonly Stream[]): { never_started?: true; stopped?: true } {
  if (s.human.status === 'closed' || s.human.status === 'landed') return {};
  if (s.sessions.some((x) => LIVE_SESSION.has(x.status))) return {};
  if (!s.sessions.some((x) => isAgentRole(x.role))) {
    const role = nodeRole(s, liveChildrenOf(s.id, all), all);
    return role === 'work' || role === 'conversation' ? { never_started: true } : {};
  }
  return stoppedByHuman(s) ? { stopped: true } : {};
}

/** T382: whose session a row names — the node's own agent first; a reviewer, then the lessons pass, only when it is all that runs. */
const LIVE_AGENT_RANK: Record<SessionRole, number> = {
  worker: 0,
  coordinator: 0,
  reviewer: 1,
  lessons: 2,
};

/**
 * T382: the node's live session for the Running lens. Its own agent (a
 * worker or coordinator) when one is live; else a live reviewer, else the
 * lessons pass — so a node listed as running always says what runs. The
 * newest session wins a tie.
 */
function liveAgent(s: Stream): { live_agent?: CockpitLiveAgent } {
  let pick: SessionRef | undefined;
  for (const x of s.sessions) {
    if (!LIVE_SESSION.has(x.status)) continue;
    if (pick === undefined || LIVE_AGENT_RANK[x.role] <= LIVE_AGENT_RANK[pick.role]) pick = x;
  }
  if (pick === undefined) return {};
  return {
    live_agent: {
      role: pick.role,
      vendor: pick.vendor,
      model: pick.model,
      ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
    },
  };
}

/** T361: the deleted nodes Restore can bring back (a parent not deleted), newest delete first. */
function archivedRows(all: readonly Stream[]): { archived?: CockpitArchivedRow[] } {
  const deleted = new Set(all.filter((s) => s.archived === true).map((s) => s.id));
  const rows = all
    .filter((s) => s.archived === true && s.parent !== undefined && !deleted.has(s.parent))
    // A delete's id is a ulid: its order is the order of the deletes (older records: creation).
    .sort((a, b) => {
      const [x, y] = [a.archive_id ?? a.id, b.archive_id ?? b.id];
      return x < y ? 1 : x > y ? -1 : 0;
    })
    .slice(0, COCKPIT_ARCHIVED_MAX)
    .map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.project !== undefined ? { project: s.project } : {}),
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
    }));
  return rows.length > 0 ? { archived: rows } : {};
}

function waitsOn(s: Stream): { waits_on?: string[] } {
  const open = (s.waits_on ?? []).filter((w) => w.satisfied_at === undefined).map((w) => w.node);
  return open.length > 0 ? { waits_on: open } : {};
}
