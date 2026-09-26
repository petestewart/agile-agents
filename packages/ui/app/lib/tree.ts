/**
 * T365: pure helpers for the rail (the project tree) and the dialogs it
 * opens — New node's defaults and title, Move to…'s targets, Delete's
 * count, a drag's refusal in words, the legend. No DOM, so plain
 * `bun test` covers them. The older tree helpers (`buildStreamTree`,
 * `filterStreamRows`, …) stay in `streams.ts`.
 */

import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';
import type { NodeStatusKey, StatusInput } from './status';
import { type StreamTreeNode, buildStreamTree } from './streams';

/** Rows the rail helpers read. */
type Row = Pick<CockpitStreamRow, 'id' | 'title' | 'parent' | 'project' | 'role'>;

/**
 * New node: the title a goal suggests — its first non-empty line, without
 * markdown's heading, list or quote markers, cut at a word boundary near
 * `max` characters (with an ellipsis).
 */
export function titleFromGoal(goal: string, max = 80): string {
  const line =
    goal
      .split('\n')
      .map((l) =>
        l
          .trim()
          .replace(/^(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
          .trim(),
      )
      .find((l) => l !== '') ?? '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** `id` and every node under it, depth first, `id` first. */
export function subtreeIds(rows: readonly Row[], id: string): string[] {
  const kids = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent === undefined) continue;
    const list = kids.get(row.parent) ?? [];
    list.push(row.id);
    kids.set(row.parent, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (at: string): void => {
    if (seen.has(at)) return;
    seen.add(at);
    out.push(at);
    for (const child of kids.get(at) ?? []) walk(child);
  };
  walk(id);
  return out;
}

/** Delete's question: "Delete 'X'?" or "Delete 'X' and its 3 nodes?" (the nodes under it). */
export function deleteQuestion(title: string, below: number): string {
  if (below <= 0) return `Delete “${title}”?`;
  return `Delete “${title}” and the ${below === 1 ? 'node' : `${below} nodes`} under it?`;
}

export type MoveCheck =
  | { ok: true }
  /** Nothing to do (onto itself, or onto where it already is): no message. */
  | { ok: false; quiet: true }
  | { ok: false; quiet?: undefined; reason: string };

/**
 * T333/T365: whether the rail lets `moving` go under `target`, and if not,
 * why in words. The rules are D34's as the rail can see them (not into its
 * own subtree, not across projects, a project root never moves); the
 * daemon has the last word (a plan awaiting approval, say).
 */
export function checkMove(rows: readonly Row[], moving: string, target: string): MoveCheck {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const from = byId.get(moving);
  const to = byId.get(target);
  if (!from || !to || moving === target || from.parent === target)
    return { ok: false, quiet: true };
  if (from.role === 'project') {
    return { ok: false, reason: 'A project’s root node stays where it is.' };
  }
  if (from.project !== to.project) {
    return {
      ok: false,
      reason: `Nodes can’t move between projects. “${from.title}” belongs to another project.`,
    };
  }
  for (let at: string | undefined = target, hops = 0; at && hops < 10_000; hops++) {
    if (at === moving) {
      return { ok: false, reason: `“${from.title}” can’t move under a node inside itself.` };
    }
    at = byId.get(at)?.parent;
  }
  return { ok: true };
}

/** One row of a picker: a node and how deep it sits under its root. */
export interface OutlineRow {
  row: CockpitStreamRow;
  depth: number;
}

/** The tree flattened in reading order (parents before children), with depth. */
export function outline(rows: readonly CockpitStreamRow[]): OutlineRow[] {
  const out: OutlineRow[] = [];
  const walk = (nodes: readonly StreamTreeNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ row: node.row, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildStreamTree(rows), 0);
  return out;
}

/** A project's nodes in reading order, its root first (`undefined`: the nodes in no project). */
export function projectOutline(
  rows: readonly CockpitStreamRow[],
  project: string | undefined,
): OutlineRow[] {
  return outline(rows.filter((r) => r.project === project));
}

/**
 * Move to…: where `id` may go — its project's nodes outside its own
 * subtree, root first. Its current parent is kept (the dialog marks it);
 * the daemon still decides.
 */
export function moveTargets(rows: readonly CockpitStreamRow[], id: string): OutlineRow[] {
  const self = rows.find((r) => r.id === id);
  if (!self || self.role === 'project') return [];
  const inside = new Set(subtreeIds(rows, id));
  return projectOutline(rows, self.project).filter((o) => !inside.has(o.row.id));
}

/** A picker's search: the rows whose title contains `query` (case-insensitive); all of them when empty. */
export function searchOutline(list: readonly OutlineRow[], query: string): OutlineRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...list];
  return list.filter((o) => o.row.title.toLowerCase().includes(q));
}

/** Repos for a picker: the project's own first, then the others, each by name. */
export function splitRepos<T extends { name: string }>(
  repos: readonly T[],
  projectRepos: readonly string[] | undefined,
): { inProject: T[]; others: T[] } {
  const own = new Set(projectRepos ?? []);
  const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  return {
    inProject: sorted.filter((r) => own.has(r.name)),
    others: sorted.filter((r) => !own.has(r.name)),
  };
}

/** Where a new node goes, and whether the dialog needs to ask (a Project field). */
export interface NewNodeDefaults {
  /** The project it files into; `undefined` when there is none to pick. */
  project: string | undefined;
  /** The open node, a `+` on a row, or the filter decided it: no Project field. */
  implied: boolean;
  /** The parent node id, `''` for the project's top level. */
  parent: string;
}

/**
 * T365: New node's starting point, in order: a `+` on a row (`preset`),
 * the open node (T353: it is the parent), the rail's project filter, the
 * only project, then the last project used, then the first.
 */
export function newNodeDefaults(input: {
  preset?: { parent?: string; project?: string } | undefined;
  selected: string | undefined;
  filter: string | undefined;
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
  lastUsed?: string | undefined;
}): NewNodeDefaults {
  const { preset, selected, filter, rows, projects, lastUsed } = input;
  const known = (id: string | undefined): id is string =>
    id !== undefined && projects.some((p) => p.id === id);
  const underNode = (id: string): NewNodeDefaults | undefined => {
    const row = rows.find((r) => r.id === id);
    if (!row) return undefined;
    // A project's root is its top level.
    const top = row.role === 'project' && row.project !== undefined;
    return { project: row.project, implied: true, parent: top ? '' : row.id };
  };
  if (preset?.parent !== undefined) {
    const at = underNode(preset.parent);
    if (at) return at;
  }
  if (known(preset?.project)) return { project: preset.project, implied: true, parent: '' };
  if (selected !== undefined) {
    const at = underNode(selected);
    if (at) return at;
  }
  if (known(filter)) return { project: filter, implied: true, parent: '' };
  if (projects.length === 1) return { project: projects[0]?.id, implied: true, parent: '' };
  if (known(lastUsed)) return { project: lastUsed, implied: false, parent: '' };
  return { project: projects[0]?.id, implied: false, parent: '' };
}

/** The legend's entries, in reading order: the human's move first. */
export const LEGEND_ORDER: readonly NodeStatusKey[] = [
  'needs_you',
  'ready',
  'blocked',
  'working',
  'pr_open',
  'waiting',
  'not_started',
  'stopped',
  'idle',
  'done',
  'merged',
  'closed',
];

/** A row that reads as `key`, so the legend's dot is drawn by `StatusDot` like the rail's. */
export function legendRow(key: NodeStatusKey): StatusInput {
  const base: StatusInput = { agent_status: 'idle', human_status: 'open', role: 'work' };
  switch (key) {
    case 'merged':
      return { ...base, agent_status: 'done', human_status: 'landed' };
    case 'closed':
      return { ...base, human_status: 'closed' };
    case 'needs_you':
      return { ...base, agent_status: 'question', human_status: 'waiting_on_you' };
    case 'blocked':
      return { ...base, agent_status: 'blocked' };
    case 'pr_open':
      return { ...base, agent_status: 'done', pr_open: true };
    case 'ready':
      return { ...base, agent_status: 'done' };
    case 'done':
      return { ...base, agent_status: 'done', role: 'coordinating' };
    case 'waiting':
      return { ...base, waiting_for_plan: true };
    case 'working':
      return { ...base, agent_status: 'working', live: true };
    case 'not_started':
      return { ...base, never_started: true };
    case 'stopped':
      return { ...base, stopped: true };
    case 'idle':
      return { ...base, live: true };
  }
}

/** The legend's one-line gloss per status (the dot's tooltip keeps the full hint). */
export const LEGEND_NOTE: Record<NodeStatusKey, string> = {
  needs_you: 'Answer or decide',
  ready: 'Review the changes, then merge',
  blocked: 'Stuck; needs a hand',
  working: 'The agent is on it',
  pr_open: 'Merges on GitHub',
  waiting: 'On a plan or another node',
  not_started: 'Its agent never ran',
  stopped: 'You stopped its agent',
  idle: 'Nothing running right now',
  done: 'Finished; nothing to merge',
  merged: 'Its work is in',
  closed: 'Closed without merging',
};

/** The legend's one-line gloss per kind of node. */
export const ROLE_NOTE: Record<NonNullable<StatusInput['role']>, string> = {
  project: 'The root and its settings',
  coordinating: 'Splits work into parts',
  work: 'Code on its own branch',
  conversation: 'Talks and researches; no repo',
};
