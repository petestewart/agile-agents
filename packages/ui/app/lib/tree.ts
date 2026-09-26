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
 * markdown's heading, list or quote markers, cut at a word boundary at most
 * `max` characters long. T413: no ellipsis character: the title is stored
 * as it reads, and a narrow place truncates it with CSS.
 */
export function titleFromGoal(goal: string, max = 60): string {
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
  // After the last word that ends within `max`; a very long word is cut at `max`.
  const space = line.lastIndexOf(' ', max);
  const cut = space > max / 2 ? line.slice(0, space) : line.slice(0, max);
  return cut.replace(/[\s,;:–—-]+$/, '');
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

/**
 * T426: the option typing `typed` lands on: the first whose text starts
 * with it, else the first that contains it (ignoring case); a repeated
 * single letter ("ll") cycles through the options starting with it.
 */
export function typeAheadMatch<T extends { text: string }>(
  options: readonly T[],
  typed: string,
): T | undefined {
  const q = typed.toLowerCase();
  if (q.trim() === '') return undefined;
  const same = q.length > 1 && [...q].every((c) => c === q[0]);
  if (same) {
    const starting = options.filter((o) => o.text.toLowerCase().startsWith(q[0] ?? ''));
    if (starting.length > 0) return starting[(q.length - 1) % starting.length];
  }
  return (
    options.find((o) => o.text.toLowerCase().startsWith(q)) ??
    options.find((o) => o.text.toLowerCase().includes(q))
  );
}

/**
 * T435 (audit r6 #7): which option a searchable picker highlights, so Enter
 * picks what you typed. With no query, the current value (when it can be
 * picked), else the first. With one, the first match that isn't pinned (Top
 * level, No repository stay listed whatever you type) — or the first match
 * at all when a pinned option's own text matches.
 */
export function pickHighlight<
  T extends { value: string; text: string; pinned?: boolean; disabled?: boolean },
>(options: readonly T[], query: string, current: string): string | undefined {
  const pickable = options.filter((o) => !o.disabled);
  const q = query.trim().toLowerCase();
  if (q === '') {
    return pickable.some((o) => o.value === current) ? current : pickable[0]?.value;
  }
  const matches = pickable.filter((o) => o.text.toLowerCase().includes(q));
  const first = matches.some((o) => o.pinned) ? matches[0] : matches.find((o) => !o.pinned);
  return (first ?? pickable[0])?.value;
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
  'no_changes',
  'merged_outside',
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
    case 'no_changes':
      return { ...base, agent_status: 'done', nothing_to_merge: true };
    case 'merged_outside':
      return { ...base, agent_status: 'done', merged_outside: true };
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
  no_changes: 'Finished with nothing to merge; close it',
  merged_outside: 'Its branch is already in; mark it merged',
  blocked: 'Stuck; needs a hand',
  working: 'The agent is on it',
  pr_open: 'Merges on GitHub',
  waiting: 'On a plan, or another node’s merge',
  not_started: 'Its agent never ran',
  stopped: 'You stopped its agent',
  idle: 'Nothing running right now',
  done: 'Finished; nothing to merge',
  merged: 'Its work is in',
  closed: 'Closed without merging',
};

/** T424: the legend's marks: the overlap button, and that rows drag. */
export const OVERLAP_NOTE = 'Overlaps another node; click to open it';
export const DRAG_NOTE = 'Drag a row to move it (or ⋯ → Move to…)';

/** The legend's one-line gloss per kind of node. */
export const ROLE_NOTE: Record<NonNullable<StatusInput['role']>, string> = {
  project: 'The root and its settings',
  coordinating: 'Splits work into parts',
  work: 'Code on its own branch',
  conversation: 'Talks and researches; no repo',
};

// ---------------------------------------------------------------- overlaps (T424)

/** T227's overlap pairs as the frame sends them (`CockpitOverlap`). */
export interface OverlapPair {
  nodes: readonly [string, string] | readonly string[];
  files: readonly string[];
}

/** Where an overlap mark leads: a node to open, and what it says about it. */
export interface OverlapTarget {
  id: string;
  title: string;
  /** The shared files in words, for the menu's hint: "src/ledger.ts and 1 more file". */
  files: string;
  /** One line for its tooltip: "Overlaps Fix rounding in totals on src/ledger.ts". */
  line: string;
}

/**
 * What a row's overlap mark says and where it leads. `own`: the node's own
 * changes overlap others' (it opens them). `inside`: its subtree is folded
 * and a node inside it overlaps (it opens that one). An open parent, or a
 * project, shows no mark: the rows under it carry their own.
 */
export interface OverlapMark {
  kind: 'own' | 'inside';
  /** Each target once, in the frame's order. */
  targets: OverlapTarget[];
  /** The tooltip and the accessible name: one line per overlap. */
  text: string;
}

/** "src/ledger.ts", "a.ts and b.ts", "a.ts and 2 more files". */
export function filesText(files: readonly string[]): string {
  const [first, second] = files;
  if (first === undefined) return 'the same files';
  if (second === undefined) return first;
  if (files.length === 2) return `${first} and ${second}`;
  return `${first} and ${files.length - 1} more files`;
}

/**
 * T424 (finding 17): the mark on row `id`, or `undefined` for none. `folded`
 * is whether its subtree is hidden (a folded parent, or project, speaks for
 * the nodes inside it). Titles come from `rows`; a node the cockpit no
 * longer knows reads "another node".
 */
export function overlapMark(
  id: string,
  overlaps: readonly OverlapPair[],
  rows: readonly Row[],
  folded: boolean,
): OverlapMark | undefined {
  const titleOf = (node: string): string =>
    rows.find((r) => r.id === node)?.title ?? 'another node';
  const targets: OverlapTarget[] = [];
  const lines: string[] = [];
  const add = (target: string, files: readonly string[], line: string): void => {
    if (!lines.includes(line)) lines.push(line);
    if (targets.some((t) => t.id === target)) return;
    targets.push({ id: target, title: titleOf(target), files: filesText(files), line });
  };

  for (const pair of overlaps) {
    if (!pair.nodes.includes(id)) continue;
    for (const other of pair.nodes) {
      if (other === id) continue;
      add(other, pair.files, `Overlaps ${titleOf(other)} on ${filesText(pair.files)}`);
    }
  }
  if (targets.length > 0) return { kind: 'own', targets, text: lines.join('\n') };
  if (!folded) return undefined;

  const inside = new Set(subtreeIds(rows, id).slice(1));
  for (const pair of overlaps) {
    const [a, b] = pair.nodes;
    if (a === undefined || b === undefined) continue;
    // Said once per pair, from the side inside the fold (the first when both are).
    const [node, other] = inside.has(a) ? [a, b] : inside.has(b) ? [b, a] : [];
    if (node === undefined || other === undefined) continue;
    const line = `${titleOf(node)} overlaps ${titleOf(other)} on ${filesText(pair.files)}`;
    add(node, pair.files, line);
    if (inside.has(other)) add(other, pair.files, line);
  }
  return targets.length > 0 ? { kind: 'inside', targets, text: lines.join('\n') } : undefined;
}
