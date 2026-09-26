/**
 * T387: a project's Overview, the first tab on its root node's page: what
 * the project is doing at a glance. The counts by status (your move first),
 * the nodes grouped the same way, and which of the event log's events are
 * this project's. T424: each count is one status, with its own dot and
 * word, and the counts are the list's own grouping. Pure: no DOM, covered
 * by `bun test`.
 */

import type { RoutedEvent } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import { type NodeStatusKey, type StatusInput, statusKey, statusOf } from './status';
import { subtreeIds } from './tree';

// ---------------------------------------------------------------- statuses and groups

/**
 * T424: what the Overview counts and lists a node as — its status key from
 * `lib/status.ts`, with a conversation that replied (the key `done`, read
 * "Replied") told apart from finished work: it goes on, so it is not
 * finished. Each count over the list is one of these, with its own dot and
 * word, so a count and the rows it filters always agree.
 */
export type OverviewStatus = NodeStatusKey | 'replied';

export function overviewStatus(row: StatusInput): OverviewStatus {
  const key = statusKey(row);
  // T374: a conversation goes on after a turn; it reads "Replied", not "Done".
  return key === 'done' && row.role === 'conversation' ? 'replied' : key;
}

/**
 * The list's groups: your move (waits on your answer, is stuck, or finished
 * with something for you to do), in progress, not running (open, nothing
 * running) and finished (the page folds it). None is named after one of the
 * statuses in it, so a heading never reads like a count.
 */
export type OverviewGroupKey = 'you' | 'in_progress' | 'not_running' | 'finished';

const GROUP_OF: Record<OverviewStatus, OverviewGroupKey> = {
  needs_you: 'you',
  blocked: 'you',
  no_changes: 'you',
  merged_outside: 'you',
  ready: 'you',
  working: 'in_progress',
  pr_open: 'in_progress',
  waiting: 'not_running',
  replied: 'not_running',
  idle: 'not_running',
  stopped: 'not_running',
  not_started: 'not_running',
  done: 'finished',
  merged: 'finished',
  closed: 'finished',
};

/** The counts' and the rows' order: your move first; within a group, the most pressing first. */
export const OVERVIEW_ORDER: readonly OverviewStatus[] = [
  'needs_you',
  'blocked',
  'no_changes',
  'merged_outside',
  'ready',
  'working',
  'pr_open',
  'waiting',
  'replied',
  'idle',
  'stopped',
  'not_started',
  'done',
  'merged',
  'closed',
];

const GROUP_TITLE: Record<OverviewGroupKey, string> = {
  you: 'Your move',
  in_progress: 'In progress',
  not_running: 'Not running',
  finished: 'Finished',
};

const GROUP_ORDER: readonly OverviewGroupKey[] = ['you', 'in_progress', 'not_running', 'finished'];

/** The group a node is listed under. */
export function overviewGroupOf(row: StatusInput): OverviewGroupKey {
  return GROUP_OF[overviewStatus(row)];
}

// ---------------------------------------------------------------- the project's nodes

/** The nodes under `root` (not the root itself), in the tree's reading order. */
export function projectNodes(rows: readonly CockpitStreamRow[], root: string): CockpitStreamRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return subtreeIds(rows, root)
    .slice(1)
    .map((id) => byId.get(id))
    .filter((r): r is CockpitStreamRow => r !== undefined);
}

/** The titles between `root` and `row`, outermost first: where the node sits in the project. */
export function pathUnder(
  row: CockpitStreamRow,
  rows: readonly CockpitStreamRow[],
  root: string,
): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  const seen = new Set<string>([row.id]);
  let at = row.parent !== undefined ? byId.get(row.parent) : undefined;
  while (at && at.id !== root && !seen.has(at.id)) {
    seen.add(at.id);
    out.unshift(at.title);
    at = at.parent !== undefined ? byId.get(at.parent) : undefined;
  }
  return out;
}

// ---------------------------------------------------------------- repos

/**
 * The repos the project works on: its own list, then any other repo one of
 * its nodes is on (a node may add a repo from outside the list).
 */
export function projectRepoNames(
  listed: readonly string[] | undefined,
  nodes: readonly Pick<CockpitStreamRow, 'repo'>[],
): string[] {
  const out = [...(listed ?? [])];
  for (const node of nodes) {
    if (node.repo !== undefined && !out.includes(node.repo)) out.push(node.repo);
  }
  return out;
}

/** How many of `nodes` are on `repo` and not finished: "2 open nodes" on the repo's row. */
export function openNodesOn(nodes: readonly CockpitStreamRow[], repo: string): number {
  return nodes.filter((n) => n.repo === repo && overviewGroupOf(n) !== 'finished').length;
}

// ---------------------------------------------------------------- the counts and the list

/** One status's nodes: a count over the list, and the rows it filters to. */
export interface OverviewCount<T = StatusInput> {
  status: OverviewStatus;
  group: OverviewGroupKey;
  /** Its nodes, the most recently changed first (an older daemon's rows: the tree's order). */
  rows: T[];
  count: number;
  /** "2 need you", "1 blocked", "1 ready to merge", "3 not started", "1 closed". */
  text: string;
}

export interface OverviewGroup<T> {
  key: OverviewGroupKey;
  title: string;
  /** Its statuses that have nodes, in order: the counts, and the rows in the same order. */
  counts: OverviewCount<T>[];
  rows: T[];
}

/** A count in words: the status's own word, lower-cased, after the number. */
function countWords(status: OverviewStatus, n: number): string {
  switch (status) {
    case 'needs_you':
      return `${n} ${n === 1 ? 'needs' : 'need'} you`;
    case 'no_changes':
      return `${n} with no changes`;
    case 'pr_open':
      return `${n} ${n === 1 ? 'PR' : 'PRs'} open`;
    case 'replied':
      return `${n} replied`;
    default:
      return `${n} ${statusOf(status).label.toLowerCase()}`;
  }
}

/**
 * The list under the counts: your move, in progress, not running, then
 * finished (the page folds it), each status's nodes together in
 * `OVERVIEW_ORDER`, the most recently changed first, then the tree's order.
 * `only` keeps one status (its count was clicked). Empty groups are left
 * out. The counts are this same grouping (`overviewCounts`), so a count
 * always equals the rows it filters to.
 */
export function overviewGroups<T extends StatusInput & { updated_at?: string }>(
  nodes: readonly T[],
  only?: OverviewStatus,
): OverviewGroup<T>[] {
  const order = new Map(nodes.map((n, i) => [n, i]));
  // T395: the most recently changed first (an older daemon's rows: the tree's order).
  const recent = (a: T, b: T): number =>
    a.updated_at !== undefined && b.updated_at !== undefined && a.updated_at !== b.updated_at
      ? a.updated_at < b.updated_at
        ? 1
        : -1
      : (order.get(a) ?? 0) - (order.get(b) ?? 0);
  const byStatus = new Map<OverviewStatus, T[]>();
  for (const node of nodes) {
    const status = overviewStatus(node);
    if (only !== undefined && status !== only) continue;
    const list = byStatus.get(status) ?? [];
    list.push(node);
    byStatus.set(status, list);
  }
  return GROUP_ORDER.map((key): OverviewGroup<T> => {
    const counts = OVERVIEW_ORDER.filter((s) => GROUP_OF[s] === key && byStatus.has(s)).map(
      (status): OverviewCount<T> => {
        const rows = [...(byStatus.get(status) ?? [])].sort(recent);
        return {
          status,
          group: key,
          rows,
          count: rows.length,
          text: countWords(status, rows.length),
        };
      },
    );
    return { key, title: GROUP_TITLE[key], counts, rows: counts.flatMap((c) => c.rows) };
  }).filter((g) => g.rows.length > 0);
}

/** The counts that are not zero, one per status, your move first: the list's own grouping. */
export function overviewCounts<T extends StatusInput & { updated_at?: string }>(
  nodes: readonly T[],
): OverviewCount<T>[] {
  return overviewGroups(nodes).flatMap((g) => g.counts);
}

/** "1 needs you · 1 blocked · 1 ready to merge · 2 working"; "No nodes yet" for none. */
export function overviewSummary(nodes: readonly StatusInput[]): string {
  const counts = overviewCounts(nodes);
  return counts.length === 0 ? 'No nodes yet' : counts.map((c) => c.text).join(' · ');
}

// ---------------------------------------------------------------- age

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** When a node was made, from its ULID id (the first ten characters are the time); `undefined` for another id. */
export function createdAt(id: string): number | undefined {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return undefined;
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(ch);
  return ms;
}

/**
 * T395: when a row last changed (ISO), for "updated 3m ago": the row's
 * `updated_at`, else (an older daemon) when it was made.
 */
export function lastChange(row: { id: string; updated_at?: string }): string | undefined {
  if (row.updated_at !== undefined) return row.updated_at;
  const born = createdAt(row.id);
  return born !== undefined ? new Date(born).toISOString() : undefined;
}

// ---------------------------------------------------------------- recent activity

/** How many events the Overview shows. */
export const RECENT_EVENTS = 8;

/**
 * The project's events: those about one of its nodes (the root included),
 * and those about no node (a repo's main moved) that name the project or
 * were routed to one of its nodes.
 */
export function isProjectEvent(
  event: Pick<RoutedEvent, 'subject' | 'project' | 'routing'>,
  project: string,
  nodes: ReadonlySet<string>,
): boolean {
  if (event.subject !== undefined) return nodes.has(event.subject);
  return event.project === project || event.routing.some((r) => nodes.has(r.node));
}

/**
 * `incoming` (a page of the log) merged into `current` (what is shown):
 * the project's events only, each once, newest first, at most `limit`.
 * Unchanged, it is the same array (nothing re-renders).
 */
export function recentProjectEvents<T extends RoutedEvent>(
  current: readonly T[],
  incoming: readonly T[],
  project: string,
  nodes: ReadonlySet<string>,
  limit = RECENT_EVENTS,
): readonly T[] {
  const have = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => !have.has(e.id) && isProjectEvent(e, project, nodes));
  if (fresh.length === 0 && current.length <= limit) return current;
  const next = [...current, ...fresh]
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, limit);
  if (next.length === current.length && next.every((e, i) => e === current[i])) return current;
  return next;
}
