/**
 * Pure helpers over the cockpit's stream rows (T160): the tree the left
 * rail renders, the dot that says who must act (design/cockpit-design.md
 * §9.2), and the grouping the inbox uses. No DOM, so plain `bun test`
 * covers them.
 */

import type { NodeRole, RoutedEvent, SessionRef, Stream } from '@agile-agents/shared';
import type {
  CockpitCardError,
  CockpitProjectRow,
  CockpitRepoRow,
  CockpitStatusCard,
  CockpitStreamRow,
} from './feed-types';
import { type NodeStatusKey, statusKey } from './status';

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
    Partial<Pick<CockpitStreamRow, 'role' | 'project' | 'pr_open' | 'pending_decision'>>,
): StreamDot {
  if (row.human_status === 'waiting_on_you') return 'amber';
  // T447 (audit r7 #9): a plan, a gate or a proposal waiting on you is your move too.
  if (row.pending_decision === true && row.human_status === 'open') return 'amber';
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
 * T447 (audit r7 #9): the dot's colour from the status the node reads as
 * (`lib/status.ts`), so the dot and the word never disagree: amber for your
 * move, red when stuck, blue while it works or its PR is open, green once
 * merged, grey otherwise. `StatusDot` draws this; `streamDot` stays for a
 * bare two-writer pair.
 */
export function statusDot(key: NodeStatusKey): StreamDot {
  switch (key) {
    case 'needs_you':
    case 'ready':
    case 'no_changes':
    case 'merged_outside':
      return 'amber';
    case 'blocked':
      return 'red';
    case 'working':
    case 'pr_open':
      return 'blue';
    case 'merged':
      return 'green';
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

/**
 * T413: a node's children for its details panel: every child row, in tree
 * order, with the agent's last status card when it posted one (its progress
 * line and files) or the card's read error. The status itself is the row's
 * (`nodeStatus`), never the card's.
 */
export interface ChildEntry {
  row: CockpitStreamRow;
  card?: CockpitStatusCard;
  error?: string;
}

export function childEntries(
  rows: readonly CockpitStreamRow[],
  parent: string,
  cards: ReadonlyArray<CockpitStatusCard | CockpitCardError>,
): ChildEntry[] {
  const byNode = new Map(cards.map((c) => [c.node, c]));
  return rows
    .filter((row) => row.parent === parent)
    .map((row) => {
      const card = byNode.get(row.id);
      if (card === undefined) return { row };
      return 'error' in card ? { row, error: card.error } : { row, card };
    });
}

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
  return node.children.some(
    (child) => statusDot(statusKey(child.row)) === 'amber' || subtreeNeedsYou(child),
  );
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

/**
 * T447 (audit r7 #20): a rail title in two parts for middle truncation: the
 * head gives way (it ends in "…") and the tail — the last word or two, at
 * most `TAIL_MAX` characters — always shows, so alike titles ("Schema change
 * for onboarding emails", "Schema change for data retention") stay apart
 * however narrow the rail. The row's tooltip has the whole title.
 * `undefined` for a title short enough never to need it.
 */
export const TAIL_MAX = 16;

export function splitTitle(title: string): { head: string; tail: string } | undefined {
  const t = title.trim();
  if (t.length <= 20) return undefined;
  const words = t.split(/(\s+)/);
  let tail = '';
  // Whole words from the end while they fit; the last one always.
  for (let i = words.length - 1; i >= 0; i--) {
    const next = `${words[i]}${tail}`;
    if (tail !== '' && next.trim().length > TAIL_MAX) break;
    tail = next;
  }
  tail = tail.trimStart();
  // One long last word: its end only.
  if (tail.length > TAIL_MAX) tail = tail.slice(-Math.round(TAIL_MAX * 0.75));
  const head = t.slice(0, t.length - tail.length);
  if (head.trim() === '') return undefined;
  return { head, tail };
}

// ---- T161: the stream page (§9.3) ----------------------------------------

/** A session that is still attached: it can be prompted, and Stop stops it. */
export function isLiveSession(session: Pick<SessionRef, 'status'>): boolean {
  return session.status === 'starting' || session.status === 'running' || session.status === 'idle';
}

/**
 * T350 (D36 D4): the sessions strip. Coordinators wake on every child event,
 * so ended sessions pile up; two or more of them fold into one "N earlier
 * sessions" row. Live sessions are always shown, and a lone ended session
 * stays on show (its ended reason is often the thing to read). Order is kept.
 */
export function sessionRows<T extends Pick<SessionRef, 'status'>>(
  sessions: readonly T[],
): { shown: T[]; earlier: T[] } {
  const ended = sessions.filter((s) => !isLiveSession(s));
  if (ended.length < 2) return { shown: [...sessions], earlier: [] };
  return { shown: sessions.filter(isLiveSession), earlier: ended };
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

/** T413: who an Activity row's event went to, by the session's role ("the agent"). */
const DELIVERED_TO: Record<string, string> = {
  worker: 'agent',
  coordinator: 'coordinator',
  reviewer: 'reviewer',
  lessons: 'lessons pass',
};

/**
 * T341, reworded in T413: whether the agent has seen an Activity row's
 * event, in words — "Seen by the agent", "Not seen by the agent yet" — by
 * the session's role, never its id (the id is the row's hover title), and a
 * digest as "batched". `owner` names the reader outright ("Director").
 */
export function activityDelivery(
  entry: { status: string; session?: string; digest?: string },
  sessions: readonly Pick<SessionRef, 'id' | 'role'>[],
  owner?: string,
): string {
  const role =
    entry.session === undefined ? undefined : sessions.find((s) => s.id === entry.session)?.role;
  const who = `the ${owner ?? (role !== undefined ? (DELIVERED_TO[role] ?? role) : 'agent')}`;
  switch (entry.status) {
    case 'pending':
      return `Not seen by ${who} yet`;
    case 'delivered':
      return `Seen by ${who}${entry.digest !== undefined ? ' (batched)' : ''}`;
    case 'superseded':
      return 'Replaced by a newer event';
    case 'expired':
      return `Expired before ${who} saw it`;
    // T446: a record (a change applied on its own): on the Activity, never sent to an agent.
    case 'recorded':
      return 'For the record';
    default:
      return entry.status.replace(/_/g, ' ');
  }
}

/** T413: a worktree folder by its name, without the node id: `…/.worktrees/01h…-add-csv` → `add-csv`. */
export function worktreeName(path: string): string {
  const base =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path;
  return base.replace(/^[0-9a-z]{26}-/i, '');
}

/**
 * T347 (D36 D5): an event's type in words. A direct merge is also a
 * `pr_merged` event (the routing type), but it had no PR: it reads "merged".
 */
export function eventLabel(event: Pick<RoutedEvent, 'type' | 'payload'>): string {
  if (event.type === 'pr_merged' && event.payload.pr === undefined) return 'merged';
  // T390: a line you typed, in your words rather than the event's type.
  if (event.type === 'human_line') return 'you wrote';
  return event.type.replace(/_/g, ' ');
}

/** T341: an event time as "YYYY-MM-DD HH:MM" in the viewer's local time; unparseable input as given. */
export function eventTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
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
