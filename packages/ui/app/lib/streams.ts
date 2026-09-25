/**
 * Pure helpers over the cockpit's stream rows (T160): the tree the left
 * rail renders, the dot that says who must act (design/cockpit-design.md
 * §9.2), and the grouping the inbox uses. No DOM, so plain `bun test`
 * covers them.
 */

import type { InboxItem, NodeRole, SessionRef, Stream } from '@agile-agents/shared';
import type { CockpitProjectRow, CockpitRepoRow, CockpitStreamRow } from './feed-types';

/** §9.2's five dots. */
export type StreamDot = 'amber' | 'blue' | 'grey' | 'green' | 'red';

/**
 * Reads the two-writer pair (§2.2) directly — there is no derived status
 * field to keep in sync. The human half wins: a stream that waits on the
 * operator is amber whatever the agent thinks, and a landed one is green.
 * `done` with the human half still `open` is "waiting for me to review and
 * land" (§2.2), which is the operator's move, so it is amber too.
 */
export function streamDot(
  row: Pick<CockpitStreamRow, 'agent_status' | 'human_status'> &
    Partial<Pick<CockpitStreamRow, 'role' | 'project' | 'pr_open'>>,
): StreamDot {
  if (row.human_status === 'waiting_on_you') return 'amber';
  if (row.human_status === 'landed') return 'green';
  if (row.human_status === 'closed') return 'grey';
  switch (row.agent_status) {
    case 'question':
      return 'amber';
    case 'done':
      // T341: as Needs me (T336): nothing to land here, so not the operator's move.
      return nothingToLand(row) ? 'grey' : 'amber';
    case 'blocked':
      return 'red';
    case 'working':
      return 'blue';
    default:
      return 'grey';
  }
}

/**
 * A coordinating node, a project root, a project's conversation (no branch),
 * or a node whose PR is open (it merges on GitHub): `done` is not your move.
 */
function nothingToLand(
  row: Partial<Pick<CockpitStreamRow, 'role' | 'project' | 'pr_open'>>,
): boolean {
  return (
    row.pr_open === true ||
    row.role === 'coordinating' ||
    row.role === 'project' ||
    (row.role === 'conversation' && row.project !== undefined)
  );
}

export const DOT_LABEL: Record<StreamDot, string> = {
  amber: 'waiting on you',
  blue: 'agent working',
  grey: 'idle',
  green: 'landed',
  red: 'blocked',
};

export interface StreamTreeNode {
  row: CockpitStreamRow;
  children: StreamTreeNode[];
}

/** Nests the flat rows. A row whose parent is not in the set surfaces at the root rather than disappearing (same rule as `StreamService.tree`). */
export function buildStreamTree(rows: readonly CockpitStreamRow[]): StreamTreeNode[] {
  const nodes = new Map<string, StreamTreeNode>(rows.map((row) => [row.id, { row, children: [] }]));
  const roots: StreamTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.row.parent !== undefined ? nodes.get(node.row.parent) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * T331: whether anything below `node` (not `node` itself) waits on the
 * operator — an amber dot. A collapsed row shows it so a question is never
 * hidden inside a folded subtree.
 */
export function subtreeNeedsYou(node: StreamTreeNode): boolean {
  return node.children.some((child) => streamDot(child.row) === 'amber' || subtreeNeedsYou(child));
}

/** T331: the rail's collapsed nodes, read back from storage; anything malformed is an empty set. */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * T162: the tree's filter. Keeps the rows whose title contains `query`
 * (case-insensitive) plus their ancestors, so a match still reads under
 * its path. An empty query keeps everything.
 */
export function filterStreamRows(
  rows: readonly CockpitStreamRow[],
  query: string,
): readonly CockpitStreamRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keep = new Set<string>();
  for (const row of rows) {
    if (!row.title.toLowerCase().includes(q)) continue;
    let at: CockpitStreamRow | undefined = row;
    while (at && !keep.has(at.id)) {
      keep.add(at.id);
      at = at.parent !== undefined ? byId.get(at.parent) : undefined;
    }
  }
  return rows.filter((row) => keep.has(row.id));
}

export interface InboxGroup {
  /** The stream id, or `''` for items that belong to no stream (a global `rule_accept`). */
  key: string;
  /** "ledger-lite / import CSV / parser" (§3.2), or "No stream". */
  label: string;
  items: InboxItem[];
}

/**
 * §9.1: grouped by stream. The inbox arrives oldest first (§3.3), and the
 * groups keep that order — a group sits where its oldest item would — so
 * the oldest ask is still the first thing on the page.
 */
export function groupInbox(items: readonly InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const item of items) {
    const key = item.stream ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: item.stream_path.length > 0 ? item.stream_path.join(' / ') : 'No stream',
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

// ---- T161: the stream page (§9.3) ----------------------------------------

/** A session that is still attached: it can be prompted, and Stop stops it. */
export function isLiveSession(session: Pick<SessionRef, 'status'>): boolean {
  return session.status === 'starting' || session.status === 'running' || session.status === 'idle';
}

/**
 * The thread's thinking indicator: a session is mid-turn — a worker or a
 * reviewer `starting`/`running`. An `idle` session is waiting on the human
 * (an open question or gate), so it is not thinking; the inbox card says
 * what it waits for.
 */
export function isThinking(stream: Pick<Stream, 'sessions'>): boolean {
  return stream.sessions.some(
    (session) =>
      session.role !== 'lessons' && (session.status === 'starting' || session.status === 'running'),
  );
}

/** Who wrote a thread line, in words: `you`, `daemon`, or the session's role and vendor. */
export function threadAuthorLabel(by: string, sessions: readonly SessionRef[]): string {
  if (by === 'human') return 'you';
  if (by === 'daemon') return 'daemon';
  const id = by.startsWith('agent:') ? by.slice('agent:'.length) : by;
  const session = sessions.find((each) => each.id === id);
  return session ? `${session.role} · ${session.vendor}` : 'agent';
}

/**
 * T341: how an Activity row's delivery reads — the session by its role, not
 * its id (the id is the row's hover title), and "in a digest" rather than
 * the digest's id.
 */
export function activityDelivery(
  entry: { status: string; session?: string; digest?: string },
  sessions: readonly Pick<SessionRef, 'id' | 'role'>[],
  owner?: string,
): string {
  const role =
    entry.session === undefined
      ? undefined
      : (owner ?? sessions.find((s) => s.id === entry.session)?.role ?? 'agent');
  return `${entry.status}${role !== undefined ? ` to the ${role} session` : ''}${
    entry.digest !== undefined ? ' in a digest' : ''
  }`;
}

/** T341: an event time as "YYYY-MM-DD HH:MM" (UTC), as the event log shows it. */
export function eventTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/** One line of a unified diff, classified for colouring. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * T169: the rule a thread entry reports a hit on — the hook writes a
 * daemon `event` whose body starts `rule_hit:` and whose `ref` is the rule
 * id — or `undefined` for any other entry. The stream page renders a hit
 * as a "blocked by rule" card linking to the rule on the Rules screen.
 */
export function ruleHitOf(entry: {
  by: string;
  kind: string;
  body: string;
  ref?: string;
}): string | undefined {
  if (entry.by !== 'daemon' || entry.kind !== 'event') return undefined;
  if (!entry.body.startsWith('rule_hit:')) return undefined;
  return entry.ref !== undefined && /^K-[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.ref)
    ? entry.ref
    : undefined;
}

/** T208: the rail's role glyphs and their labels (projects-design, P1). */
export const ROLE_ICON: Record<NodeRole, string> = {
  project: '\u25A0',
  coordinating: '\u25C6',
  work: '\u25CF',
  conversation: '\u25CB',
};

/** T208: the rows the rail shows for the switcher's choice (`undefined` is "All"). */
export function rowsInProject(
  rows: readonly CockpitStreamRow[],
  project: string | undefined,
): readonly CockpitStreamRow[] {
  return project === undefined ? rows : rows.filter((row) => row.project === project);
}

/**
 * T208: where a new node (New stream, quick capture) files. The switcher's
 * project; on "All", the open stream's project; failing that, the only
 * project if there is exactly one. `undefined` means the operator must pick.
 */
export function projectForNew(
  current: string | undefined,
  selected: string | undefined,
  rows: readonly CockpitStreamRow[],
  projects: readonly CockpitProjectRow[],
): string | undefined {
  if (current !== undefined) return current;
  const open = selected !== undefined ? rows.find((row) => row.id === selected) : undefined;
  if (open?.project !== undefined) return open.project;
  return projects.length === 1 ? projects[0]?.id : undefined;
}

// ---- T209: the repo view and lenses ----------------------------------------

/** T209: the titles of a row's ancestors, root first (the project node is the root). */
export function ancestorTitles(row: CockpitStreamRow, rows: readonly CockpitStreamRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  const seen = new Set<string>([row.id]);
  let parent = row.parent !== undefined ? byId.get(row.parent) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    out.unshift(parent.title);
    parent = parent.parent !== undefined ? byId.get(parent.parent) : undefined;
  }
  return out;
}

/** A node still in play: not landed or closed. */
export function isLiveNode(row: Pick<CockpitStreamRow, 'human_status'>): boolean {
  return row.human_status !== 'landed' && row.human_status !== 'closed';
}

export interface RepoGroup {
  repo: string;
  /** `direct` unless repos.yaml names another mode. */
  delivery: CockpitRepoRow['delivery'];
  rows: CockpitStreamRow[];
}

/**
 * T209: live work nodes grouped by repo, across projects. Every registered
 * repo gets a group (an empty one says so); a node on an unregistered repo
 * still shows, as `direct`.
 */
export function groupByRepo(
  rows: readonly CockpitStreamRow[],
  repos: readonly CockpitRepoRow[],
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const r of repos) groups.set(r.name, { repo: r.name, delivery: r.delivery, rows: [] });
  for (const row of rows) {
    if (row.repo === undefined || row.role !== 'work' || !isLiveNode(row)) continue;
    let group = groups.get(row.repo);
    if (!group) {
      group = { repo: row.repo, delivery: 'direct', rows: [] };
      groups.set(row.repo, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** T209: the Running lens — nodes with a live session. */
export function runningRows(rows: readonly CockpitStreamRow[]): CockpitStreamRow[] {
  return rows.filter((row) => row.live === true);
}

export interface DependencyEdge {
  from: CockpitStreamRow;
  /** The waited-on node, or just its id when it is not in the tree. */
  on: CockpitStreamRow | string;
}

/** T209: the Dependencies lens — every open `waits_on` edge, as a list. */
export function dependencyEdges(rows: readonly CockpitStreamRow[]): DependencyEdge[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.flatMap((from) =>
    (from.waits_on ?? []).map((id) => ({ from, on: byId.get(id) ?? id })),
  );
}
