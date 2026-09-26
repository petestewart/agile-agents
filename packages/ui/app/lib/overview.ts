/**
 * T387: a project's Overview, the first tab on its root node's page: what
 * the project is doing at a glance. The counts by status (your move first),
 * the nodes grouped the same way, and which of the event log's events are
 * this project's. Pure: no DOM, covered by `bun test`.
 */

import type { RoutedEvent } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import { type NodeStatusKey, type StatusInput, statusKey } from './status';
import { subtreeIds } from './tree';

// ---------------------------------------------------------------- buckets

/**
 * What a node's status amounts to on the Overview: `you` (waits on your
 * answer, is stuck, or finished with nothing to merge), `ready` (to merge),
 * `working`, `idle` (open, nothing running) and `done` (merged, closed, or
 * finished with nothing to merge).
 */
export type OverviewBucket = 'you' | 'ready' | 'working' | 'idle' | 'done';

/** The summary's order: your move first. */
export const OVERVIEW_BUCKETS: readonly OverviewBucket[] = [
  'you',
  'ready',
  'working',
  'idle',
  'done',
];

const BUCKET_OF: Record<NodeStatusKey, OverviewBucket> = {
  needs_you: 'you',
  blocked: 'you',
  no_changes: 'you',
  ready: 'ready',
  working: 'working',
  pr_open: 'working',
  waiting: 'idle',
  not_started: 'idle',
  stopped: 'idle',
  idle: 'idle',
  done: 'done',
  merged: 'done',
  closed: 'done',
};

/** Within a bucket: the most pressing status first. */
const STATUS_RANK: Record<NodeStatusKey, number> = {
  needs_you: 0,
  blocked: 1,
  no_changes: 2,
  ready: 3,
  working: 4,
  pr_open: 5,
  waiting: 6,
  idle: 7,
  done: 8,
  stopped: 9,
  not_started: 10,
  merged: 11,
  closed: 12,
};

export function bucketOf(row: StatusInput): OverviewBucket {
  const key = statusKey(row);
  // A conversation that replied goes on (it reads "Replied"): it is open, not done.
  if (key === 'done' && row.role === 'conversation') return 'idle';
  return BUCKET_OF[key];
}

function rankOf(row: StatusInput): number {
  const key = statusKey(row);
  if (key === 'done' && row.role === 'conversation') return STATUS_RANK.idle;
  return STATUS_RANK[key];
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

/** How many of `nodes` are on `repo` and not done: "2 open nodes" on the repo's row. */
export function openNodesOn(nodes: readonly CockpitStreamRow[], repo: string): number {
  return nodes.filter((n) => n.repo === repo && bucketOf(n) !== 'done').length;
}

// ---------------------------------------------------------------- the summary

export interface OverviewCount {
  bucket: OverviewBucket;
  count: number;
  /** "2 need you", "1 ready to merge", "3 working", "4 idle", "5 done". */
  text: string;
}

function countWords(bucket: OverviewBucket, n: number): string {
  switch (bucket) {
    case 'you':
      return `${n} ${n === 1 ? 'needs' : 'need'} you`;
    case 'ready':
      return `${n} ready to merge`;
    case 'working':
      return `${n} working`;
    case 'idle':
      return `${n} idle`;
    case 'done':
      return `${n} done`;
  }
}

/** The counts that are not zero, your move first. */
export function overviewCounts(nodes: readonly StatusInput[]): OverviewCount[] {
  const counts = new Map<OverviewBucket, number>();
  for (const node of nodes) {
    const bucket = bucketOf(node);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return OVERVIEW_BUCKETS.filter((b) => (counts.get(b) ?? 0) > 0).map((bucket) => {
    const count = counts.get(bucket) ?? 0;
    return { bucket, count, text: countWords(bucket, count) };
  });
}

/** "2 need you · 1 ready to merge · 3 working · 5 done"; "No nodes yet" for none. */
export function overviewSummary(nodes: readonly StatusInput[]): string {
  const counts = overviewCounts(nodes);
  return counts.length === 0 ? 'No nodes yet' : counts.map((c) => c.text).join(' · ');
}

// ---------------------------------------------------------------- the list

export type OverviewGroupKey = 'you' | 'working' | 'idle' | 'done';

export interface OverviewGroup<T> {
  key: OverviewGroupKey;
  title: string;
  rows: T[];
}

const GROUP_OF: Record<OverviewBucket, OverviewGroupKey> = {
  you: 'you',
  ready: 'you',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

const GROUP_TITLE: Record<OverviewGroupKey, string> = {
  you: 'Your move',
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
};

const GROUP_ORDER: readonly OverviewGroupKey[] = ['you', 'working', 'idle', 'done'];

/**
 * The list under the summary: your move, working, idle, then done (the
 * page folds it). Within a group the most pressing status comes first, then
 * the tree's order. `only` keeps one bucket (a count was clicked). Empty
 * groups are left out.
 */
export function overviewGroups<T extends StatusInput & { updated_at?: string }>(
  nodes: readonly T[],
  only?: OverviewBucket,
): OverviewGroup<T>[] {
  const order = new Map(nodes.map((n, i) => [n, i]));
  const kept = only === undefined ? nodes : nodes.filter((n) => bucketOf(n) === only);
  // T395: then the most recently changed first (an older daemon's rows: the tree's order).
  const recent = (a: T, b: T): number =>
    a.updated_at !== undefined && b.updated_at !== undefined && a.updated_at !== b.updated_at
      ? a.updated_at < b.updated_at
        ? 1
        : -1
      : 0;
  return GROUP_ORDER.map((key) => ({
    key,
    title: GROUP_TITLE[key],
    rows: kept
      .filter((n) => GROUP_OF[bucketOf(n)] === key)
      .sort(
        (a, b) =>
          rankOf(a) - rankOf(b) || recent(a, b) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
      ),
  })).filter((g) => g.rows.length > 0);
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
