/**
 * Pure helpers over the cockpit's stream rows (T160): the tree the left
 * rail renders, the dot that says who must act (design/cockpit-design.md
 * §9.2), and the grouping the inbox uses. No DOM, so plain `bun test`
 * covers them.
 */

import type { InboxItem } from '@agile-agents/shared';
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

/** The id and every descendant id of `id` — what "narrow the inbox to this stream" covers. */
export function subtreeIds(rows: readonly CockpitStreamRow[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parent !== undefined && out.has(row.parent) && !out.has(row.id)) {
        out.add(row.id);
        grew = true;
      }
    }
  }
  return out;
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
