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
  EventDeliveryStatus,
  HilRequest,
  InboxItem,
  NodeRole,
  ProjectSessionDefaults,
  Question,
  RepoRemote,
  RoutedEvent,
  RoutingEntry,
  KnowledgeItem as Rule,
  Stream,
  ThreadEntry,
  TrackerSettings,
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
  /** T208: the node's project and derived role (P1). */
  project?: string;
  role: NodeRole;
  agent_status: Stream['agent']['status'];
  human_status: Stream['human']['status'];
  /** T209: the repo a work node is on. */
  repo?: string;
  /** T209: a session is starting, running or idle. */
  live?: true;
  /** T209: the nodes this one still waits on. */
  waits_on?: string[];
  /** T227: this node, or a descendant, overlaps another live node. */
  overlap?: true;
  /** T229: a hookless vendor is live and a private repo is hidden from this node. */
  visibility_advisory?: true;
  /** T336: a part not yet started because its coordinator's plan is not approved. */
  waiting_for_plan?: true;
  /** T341: its PR is open, so it merges on GitHub. */
  pr_open?: true;
  /** T361: a work node or conversation whose agent never ran. Absent from an older daemon. */
  never_started?: true;
  /** T361: the human stopped its agent; nothing is live and it is still open. Absent from an older daemon. */
  stopped?: true;
}

/** T160: mirror of `feed/snapshot.ts`'s `CockpitFrame` — the inbox and the tree, pushed on connect and after every event batch. */
export interface CockpitFrame {
  type: 'cockpit';
  inbox: InboxItem[];
  streams: CockpitStreamRow[];
  /** T208: the live projects (the rail's switcher). */
  projects: CockpitProjectRow[];
  /** T209: the registered repos and their delivery mode. */
  repos: CockpitRepoRow[];
  /** T227: live work nodes on one repo sharing changed files. Absent from an older daemon. */
  overlaps?: CockpitOverlap[];
  /** T283: the child nodes' status cards. Absent from an older daemon. */
  cards?: Array<CockpitStatusCard | CockpitCardError>;
  /** T338: every contract's title and owning node, so text names contracts, not ids. Absent from an older daemon. */
  contracts?: CockpitContractRow[];
  /** T361: deleted nodes that can be restored, most recently deleted first (≤200). Absent when none. */
  archived?: CockpitArchivedRow[];
}

/** T361: mirror of `feed/snapshot.ts`'s `CockpitArchivedRow`. */
export interface CockpitArchivedRow {
  id: string;
  title: string;
  project?: string;
  parent?: string;
}

/** T338: mirror of `feed/snapshot.ts`'s `CockpitContractRow`. */
export interface CockpitContractRow {
  id: string;
  title: string;
  node: string;
}

/** T283: a corrupt card file, refused with its path:line. */
export interface CockpitCardError {
  node: string;
  error: string;
}

/** T283: mirror of shared `StatusCard` (projects-design §14.5). */
export interface CockpitStatusCard {
  node: string;
  doing: string;
  state: 'working' | 'question' | 'blocked' | 'done' | 'idle';
  files: string[];
  exports_changed: string[];
  relies_on: string[];
  updated_at: string;
}

/** T227: mirror of `sync/overlap.ts`'s `Overlap`. */
export interface CockpitOverlap {
  repo: string;
  nodes: [string, string];
  files: string[];
}

/** T209: mirror of `feed/snapshot.ts`'s `CockpitRepoRow`. */
export interface CockpitRepoRow {
  name: string;
  delivery: 'direct' | 'pr';
  /** T362: where its remote lives (the repo icon); absent for a local-only repo. */
  remote?: RepoRemote;
}

/** T208: mirror of `feed/snapshot.ts`'s `CockpitProjectRow`. */
export interface CockpitProjectRow {
  id: string;
  name: string;
  root: string;
  /** T282: the project's autonomy levels (the root node's Autonomy picker). */
  autonomy?: {
    coordinator: 'advise' | 'organise' | 'run';
    director: 'advise' | 'organise' | 'run';
  };
  /** T338: the project's repos and tracker settings. Absent from an older daemon. */
  repos?: string[];
  tracker?: TrackerSettings;
  /** T379: the project's own session defaults (P5). Absent when it names none, or from an older daemon. */
  session?: ProjectSessionDefaults;
}

/** T161: mirror of `delivery/service.ts`'s `LandPreflight` — the Merge button's "before". */
export interface LandPreflight {
  ready: boolean;
  reason?: string;
  branch?: string;
  target?: string;
  ahead?: number;
  gated?: true;
  /** T166: already merged into the target outside `land`. */
  merged?: true;
  /** T176: the last land conflicted in these files; Resolve offers a worker. */
  conflicts?: string[];
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
  rollup?: { merged: number; total: number };
}

/** T245: mirror of `events/service.ts`'s `ActivityEntry` (`GET /api/streams/:id/activity`). */
export interface ActivityEntry {
  event: RoutedEvent;
  because: RoutingEntry['because'];
  status: EventDeliveryStatus;
  delivered_at?: string;
  session?: string;
  digest?: string;
}

/** T161: mirror of `delivery/service.ts`'s `StreamDiff` (`GET /api/streams/:id/diff`). */
export interface StreamDiff {
  stream: string;
  branch: string;
  target: string;
  worktree?: string;
  stat: string;
  patch: string;
  truncated: boolean;
}

/** T161: mirror of `delivery/service.ts`'s `LandOutcome` — the Merge button's "after". */
export type LandOutcome =
  | { status: 'gated'; gate: HilRequest; line: string }
  /** T347: `held` is a ship-check or waits-on hold: news, not a failure. */
  | { status: 'refused'; reason: string; line: string; held?: true }
  | { status: 'blocked'; target: string; conflicts: string[]; line: string }
  | { status: 'landed'; target: string; sha: string; line: string }
  /** PR mode: the branch was pushed and its PR opened (or updated). A success. */
  | { status: 'pr_open'; target: string; pr: { number: number; url: string }; line: string };

/** T163: mirror of `rules/report.ts`'s `RuleReportRow` (§5.7). */
export interface RuleReportRow {
  id: string;
  name?: string;
  tier: string;
  status: Rule['status'];
  fired: number;
  violated: number;
  routed: number;
  last_fired?: string;
  flag: 'never fired' | 'never violated' | 'routes often' | '-';
  flag_detail: string;
}

/** T163: `GET /api/rules` — every rule, the pruning report, and whether evals can run. */
export interface RulesPayload {
  rules: Rule[];
  report: { days: number; generated_at: string; rows: RuleReportRow[] };
  evals: { available: boolean; timeout_ms?: number };
}

/** T163: mirror of `rules/evals.ts`'s `RuleEvalReport` (§5.6). No confidence (D14). */
export interface RuleEvalReport {
  generated_at: string;
  rules: Array<{
    id: string;
    question: string;
    examples: Array<{
      action: string;
      expected_violates: boolean;
      expected_band: 'allow' | 'deny';
      probability?: number;
      band?: 'allow' | 'route' | 'deny';
      agree: boolean;
      error?: string;
    }>;
    agreed: number;
    disagreed: number;
    errors: number;
  }>;
  total: number;
  agreed: number;
  disagreed: number;
  errors: number;
  agreement_rate?: number;
}
