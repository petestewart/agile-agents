/**
 * Pure helpers over the cockpit's stream rows (T160): the tree the left
 * rail renders, the dot that says who must act (design/cockpit-design.md
 * §9.2), and the grouping the inbox uses. No DOM, so plain `bun test`
 * covers them.
 */

import type { InboxItem, SessionRef, Stream } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';

/** §9.2's five dots. */
export type StreamDot = 'amber' | 'blue' | 'grey' | 'green' | 'red';

/**
 * Reads the two-writer pair (§2.2) directly — there is no derived status
 * field to keep in sync. The human half wins: a stream that waits on the
 * operator is amber whatever the agent thinks, and a landed one is green.
 * `done` with the human half still `open` is "waiting for me to review and
 * land" (§2.2), which is the operator's move, so it is amber too.
 */
export function streamDot(row: Pick<CockpitStreamRow, 'agent_status' | 'human_status'>): StreamDot {
  if (row.human_status === 'waiting_on_you') return 'amber';
  if (row.human_status === 'landed') return 'green';
  if (row.human_status === 'closed') return 'grey';
  switch (row.agent_status) {
    case 'question':
    case 'done':
      return 'amber';
    case 'blocked':
      return 'red';
    case 'working':
      return 'blue';
    default:
      return 'grey';
  }
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
      (session.role === 'worker' || session.role === 'reviewer') &&
      (session.status === 'starting' || session.status === 'running'),
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
