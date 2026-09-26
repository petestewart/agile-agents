/**
 * T429: replies you haven't read. You ask a question (Ask, D42) and go back
 * to what you were doing; when the answer lands you should hear of it
 * without watching the rail. A finished work node already has its Merge
 * card in Needs me; a node whose agent *answered* — a conversation, a
 * project root, a coordinating node — has no card (T336, T341), so this is
 * where it shows: a "Replies" list at the top of Needs me, a dot in the
 * sidebar, and a notification while you're away.
 *
 * Read is per browser (localStorage, like the theme and the fold state):
 * a node is read up to its row's `updated_at` while its page is open and
 * the tab visible. Everything before this browser first opened the cockpit
 * counts as read, so a first visit starts clean. Pure, so `bun test`
 * covers it; the store and hooks are in `use-unread.ts`.
 */

import type { CockpitStreamRow } from './feed-types';

/** How many nodes' read marks are kept (the oldest go first). */
export const SEEN_MAX = 400;

export interface SeenState {
  /** Before this, everything counts as read. */
  since: string;
  /** Per node: the last change you saw (its row's `updated_at`). */
  nodes: Record<string, string>;
}

/** The stored state, or a fresh one starting `now` when there is none (or it is corrupt). */
export function parseSeen(raw: string | null | undefined, now: string): SeenState {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { since?: unknown; nodes?: unknown };
      if (typeof parsed.since === 'string' && typeof parsed.nodes === 'object' && parsed.nodes) {
        const nodes: Record<string, string> = {};
        for (const [id, at] of Object.entries(parsed.nodes as Record<string, unknown>)) {
          if (typeof at === 'string') nodes[id] = at;
        }
        return { since: parsed.since, nodes };
      }
    } catch {
      // Corrupt: start again.
    }
  }
  return { since: now, nodes: {} };
}

type ReplyRow = Pick<
  CockpitStreamRow,
  'id' | 'role' | 'agent_status' | 'human_status' | 'updated_at' | 'answered_at'
>;

/**
 * A node whose agent answered and whose answer has no Needs me card: it is
 * open, its agent is done, and it is not a work node (whose finish is a
 * Merge card).
 */
export function answersYou(row: ReplyRow): boolean {
  // T437: only a turn that answered something you said (`answered_at`); one woken by
  // new knowledge or an event is not a reply to you.
  return (
    row.human_status === 'open' &&
    row.agent_status === 'done' &&
    row.role !== 'work' &&
    row.answered_at !== undefined
  );
}

/** When `id` was last read (or `since`, whichever is later). */
function readUpTo(seen: SeenState, id: string): string {
  const at = seen.nodes[id];
  return at !== undefined && at > seen.since ? at : seen.since;
}

/** The replies not read yet, newest first; the node open now (`open`) is being read. */
export function unreadReplies<R extends ReplyRow>(
  rows: readonly R[],
  seen: SeenState,
  open?: string,
): R[] {
  return rows
    .filter(
      (row) =>
        row.id !== open && answersYou(row) && (row.answered_at as string) > readUpTo(seen, row.id),
    )
    .sort((a, b) => ((b.answered_at as string) > (a.answered_at as string) ? 1 : -1));
}

/** `id` read up to `at`. The same state when nothing changes; the oldest marks drop past `SEEN_MAX`. */
export function markSeen(seen: SeenState, id: string, at: string): SeenState {
  if (readUpTo(seen, id) >= at) return seen;
  const nodes = { ...seen.nodes, [id]: at };
  const ids = Object.keys(nodes);
  if (ids.length > SEEN_MAX) {
    const oldest = ids.sort((a, b) => ((nodes[a] ?? '') < (nodes[b] ?? '') ? -1 : 1));
    for (const drop of oldest.slice(0, ids.length - SEEN_MAX)) delete nodes[drop];
  }
  return { since: seen.since, nodes };
}

/** Every reply read up to its last change (Needs me's "Mark all read"). */
export function markAllSeen(seen: SeenState, rows: readonly ReplyRow[]): SeenState {
  let next = seen;
  for (const row of rows) {
    const at = row.updated_at ?? row.answered_at;
    if (at !== undefined) next = markSeen(next, row.id, at);
  }
  return next;
}

/** The titles above `id`, its root first (a reply's path in Needs me). */
export function ancestorTitles(
  rows: readonly Pick<CockpitStreamRow, 'id' | 'title' | 'parent'>[],
  id: string,
): string[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: string[] = [];
  let at = byId.get(id)?.parent;
  for (let hops = 0; at !== undefined && hops < 1000; hops++) {
    const row = byId.get(at);
    if (!row) break;
    out.unshift(row.title);
    at = row.parent;
  }
  return out;
}

/** T433: the Director's read mark, beside the nodes' (a node id is a ULID, so they never clash). */
export const DIRECTOR_READ_KEY = 'director';

/** T433: the Director replied since you last read its thread (`reading`: its page is on screen now). */
export function directorUnread(
  repliedAt: string | undefined,
  seen: SeenState,
  reading: boolean,
): boolean {
  return !reading && repliedAt !== undefined && repliedAt > readUpTo(seen, DIRECTOR_READ_KEY);
}
