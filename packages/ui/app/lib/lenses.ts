/**
 * T368: the words and the ordering behind the lenses (Repos, Running,
 * Dependencies) and the event log. Pure: no DOM, covered by `bun test`.
 * The grouping itself (`groupByRepo`, `runningRows`, `dependencyEdges`)
 * stays in `lib/streams.ts`; this file says what those lists read as.
 */

import type { RoutedEvent, RoutedEventType, RoutingEntry } from '@agile-agents/shared';
import { dayLabel } from './chat';
import type { CockpitRepoRow, CockpitStreamRow } from './feed-types';
import { type NodeStatusKey, statusKey } from './status';
import { dependencyEdges, eventLabel } from './streams';

// ---------------------------------------------------------------- Repos

/** A repo's delivery mode in words: what pressing Merge does there. */
export function deliveryWords(delivery: CockpitRepoRow['delivery']): string {
  return delivery === 'pr' ? 'Opens pull requests' : 'Merges directly';
}

/** One sentence for the delivery badge's tooltip. */
export function deliveryHint(
  delivery: CockpitRepoRow['delivery'],
  opts: { autoMerge?: boolean; main?: string } = {},
): string {
  const main = opts.main ?? 'main';
  if (delivery === 'direct') return `Merge puts a node's branch straight into ${main}.`;
  return `Merge pushes the branch and opens a pull request into ${main}; the agent looks after it until it merges.${
    opts.autoMerge ? ' Auto-merge is on: it merges once its checks pass.' : ''
  }`;
}

// ---------------------------------------------------------------- Running

/** Your move first, then working, then the rest; alphabetical within each. */
const RUNNING_RANK: Partial<Record<NodeStatusKey, number>> = {
  needs_you: 0,
  blocked: 0,
  ready: 0,
  no_changes: 0,
  working: 1,
};

export function sortRunning(rows: readonly CockpitStreamRow[]): CockpitStreamRow[] {
  return [...rows].sort(
    (a, b) =>
      (RUNNING_RANK[statusKey(a)] ?? 2) - (RUNNING_RANK[statusKey(b)] ?? 2) ||
      a.title.localeCompare(b.title),
  );
}

/** "1 needs you · 2 working · 1 idle" — the Running page's subtitle; empty parts left out. */
export function runningSummary(rows: readonly CockpitStreamRow[]): string {
  let you = 0;
  let working = 0;
  let other = 0;
  for (const row of rows) {
    const rank = RUNNING_RANK[statusKey(row)] ?? 2;
    if (rank === 0) you += 1;
    else if (rank === 1) working += 1;
    else other += 1;
  }
  return [
    you > 0 ? `${you} need${you === 1 ? 's' : ''} you` : '',
    working > 0 ? `${working} working` : '',
    other > 0 ? `${other} idle` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------- Dependencies

export interface DependencyGroup {
  /** The node that waits. */
  from: CockpitStreamRow;
  /** What it waits on: a row, or just the id when that node is not in the tree. */
  on: Array<CockpitStreamRow | string>;
}

/** T368: the Dependencies lens — every open "waits on" link, grouped by the node that waits. */
export function dependencyGroups(rows: readonly CockpitStreamRow[]): DependencyGroup[] {
  const groups = new Map<string, DependencyGroup>();
  for (const edge of dependencyEdges(rows)) {
    let group = groups.get(edge.from.id);
    if (!group) {
      group = { from: edge.from, on: [] };
      groups.set(edge.from.id, group);
    }
    group.on.push(edge.on);
  }
  return [...groups.values()];
}

/** A waited-on node that merged (or closed) no longer holds anything up. */
export function isSatisfied(on: CockpitStreamRow | string): boolean {
  return typeof on !== 'string' && (on.human_status === 'landed' || on.human_status === 'closed');
}

// ---------------------------------------------------------------- Events

export type EventFamily = 'messages' | 'delivery' | 'coordination' | 'knowledge';

/** Every routed event type, in one of four families for the log's filter. */
export const EVENT_FAMILY: Record<RoutedEventType, EventFamily> = {
  human_line: 'messages',
  answer: 'messages',
  director_request: 'messages',
  coordinator_note: 'messages',
  sibling_ask: 'messages',
  sibling_reply: 'messages',
  child_question: 'messages',
  tangent_summary: 'messages',
  pr_review: 'delivery',
  ci_failed: 'delivery',
  pr_behind: 'delivery',
  pr_merged: 'delivery',
  pr_closed: 'delivery',
  main_changed: 'delivery',
  sync_conflict: 'delivery',
  ship_findings: 'delivery',
  child_delivered: 'delivery',
  child_status: 'coordination',
  overlap: 'coordination',
  symbol_changed: 'coordination',
  contract_changed: 'coordination',
  contract_proposal: 'coordination',
  dependency_satisfied: 'coordination',
  plan_changed: 'coordination',
  external_changed: 'coordination',
  knowledge_accepted: 'knowledge',
};

export const EVENT_FAMILIES: ReadonlyArray<{ id: EventFamily | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'delivery', label: 'Merges and PRs' },
  { id: 'coordination', label: 'Coordination' },
  { id: 'knowledge', label: 'Knowledge' },
];

export function eventFamily(type: string): EventFamily {
  return EVENT_FAMILY[type as RoutedEventType] ?? 'coordination';
}

/**
 * An event's label as a title: `eventLabel`'s words (the Activity tab's),
 * capitalised, with PR and CI in capitals — "PR merged", "Main changed".
 */
export function eventTitle(event: Pick<RoutedEvent, 'type' | 'payload'>): string {
  const words = eventLabel(event).replace(/\b(pr|ci)\b/g, (w) => w.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why an event went to a node, in words (a chip) and one sentence (its tooltip). */
export const ROUTE_REASON: Record<RoutingEntry['because'], { label: string; hint: string }> = {
  self: { label: 'itself', hint: 'The event is about this node.' },
  ancestor: { label: 'above it', hint: 'It sits above the node the event is about.' },
  waits_on: { label: 'waits on it', hint: 'It waits on the node the event is about.' },
  same_repo: { label: 'same repo', hint: 'It works on the same repo.' },
  party: { label: 'involved', hint: 'It is one of the nodes the event names.' },
  sibling: { label: 'sibling', hint: 'A sibling part under the same coordinator.' },
};

/** First line of `text`, at most `max` characters. */
export function clip(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const short = (sha: string): string => sha.slice(0, 7);

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function list(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function files(names: readonly string[]): string {
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const REVIEW_STATE: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'asked for changes',
  commented: 'commented',
  dismissed: 'dismissed a review',
};

/**
 * T368: what an event says, in one short muted line under its label — the
 * message, the PR, the files. Ids read as titles through `titleOf`.
 * `undefined` when there is nothing to add.
 */
export function eventDetail(
  event: Pick<RoutedEvent, 'type' | 'payload'>,
  titleOf: (id: string) => string = (id) => id,
): string | undefined {
  const p = event.payload;
  const pr = num(p, 'pr');
  const prName = pr !== undefined ? `PR #${pr}` : undefined;
  const out = ((): string | undefined => {
    switch (event.type) {
      case 'human_line':
      case 'coordinator_note':
      case 'director_request':
      case 'sibling_reply':
        return str(p, 'body');
      case 'answer':
        return str(p, 'answer');
      case 'sibling_ask':
        return str(p, 'question');
      case 'child_question':
        return [str(p, 'title'), str(p, 'question')].filter(Boolean).join(': ');
      case 'tangent_summary':
        return [str(p, 'title'), str(p, 'summary')].filter(Boolean).join(': ');
      case 'child_status': {
        const status = str(p, 'status') ?? '';
        const title = str(p, 'title') ?? titleOf(str(p, 'child') ?? '');
        const progress = str(p, 'progress');
        return `${title} is ${status === 'question' ? 'asking a question' : status}${progress ? ` — ${progress}` : ''}`;
      }
      case 'child_delivered': {
        const sha = str(p, 'sha');
        return `${str(p, 'title') ?? 'A part'} merged into ${str(p, 'repo') ?? 'its repo'}${sha ? ` at ${short(sha)}` : ''}`;
      }
      case 'pr_review': {
        const state = str(p, 'state') ?? '';
        const comments = list(p, 'comments');
        return `${str(p, 'login') ?? 'Someone'} ${REVIEW_STATE[state] ?? state.replace(/_/g, ' ')} on ${prName ?? 'the PR'}${comments[0] ? `: ${comments[0]}` : ''}`;
      }
      case 'ci_failed':
        return `${str(p, 'check') ?? 'A check'} failed on ${prName ?? 'the PR'}`;
      case 'pr_behind': {
        const conflicting = str(p, 'state') === 'conflicting';
        const changed = list(p, 'files');
        return `${prName ?? 'The PR'} ${conflicting ? 'has conflicts' : 'is behind main'}${changed.length > 0 ? ` in ${files(changed)}` : ''}`;
      }
      case 'pr_merged': {
        const sha = str(p, 'sha');
        return `${prName ? `${prName} merged` : 'Merged'} into ${str(p, 'repo') ?? 'main'}${sha ? ` at ${short(sha)}` : ''}`;
      }
      case 'pr_closed':
        return `${prName ?? 'The PR'} closed${str(p, 'login') ? ` by ${str(p, 'login')}` : ''} without merging`;
      case 'main_changed': {
        const sha = str(p, 'sha');
        const outcome = str(p, 'outcome');
        const words =
          outcome === 'synced'
            ? 'nodes on it synced'
            : outcome === 'conflict'
              ? 'a sync conflicted'
              : 'not synced yet';
        return `${str(p, 'repo') ?? 'main'} main moved${sha ? ` to ${short(sha)}` : ''} · ${words}`;
      }
      case 'sync_conflict':
        return `Syncing main conflicted in ${files(list(p, 'files'))}`;
      case 'overlap': {
        const other = str(p, 'other');
        return `Changes the same files as ${other ? titleOf(other) : 'another node'}: ${files(list(p, 'files'))}`;
      }
      case 'symbol_changed':
        return `${str(p, 'symbol') ?? 'A symbol'} changed in ${str(p, 'file') ?? 'a file'}`;
      case 'contract_changed':
        return `${str(p, 'title') ?? 'A contract'} is now version ${num(p, 'version') ?? '?'}`;
      case 'contract_proposal':
        return str(p, 'reason') ?? str(p, 'body');
      case 'knowledge_accepted':
        return str(p, 'text');
      case 'dependency_satisfied': {
        const title = str(p, 'title') ?? titleOf(str(p, 'node') ?? '');
        return `${title} ${str(p, 'outcome') === 'closed' ? 'closed' : 'merged'}; nothing waits on it now`;
      }
      case 'plan_changed':
        return str(p, 'summary');
      case 'external_changed':
        return [str(p, 'key'), str(p, 'summary')].filter(Boolean).join(': ');
      case 'ship_findings': {
        const found = list(p, 'findings');
        const more = found.length - 1 + (num(p, 'more_findings') ?? 0);
        return found[0] ? `${found[0]}${more > 0 ? ` (+${more} more)` : ''}` : undefined;
      }
      default:
        return undefined;
    }
  })();
  return out === undefined || out.trim() === '' ? undefined : clip(out);
}

export interface EventFilter {
  family: EventFamily | 'all';
  query: string;
  /** A repo name, or `undefined` for every repo. */
  repo?: string;
}

/** Newest first by time; the log's own order breaks ties. */
export function sortNewestFirst<T extends Pick<RoutedEvent, 'at'>>(events: readonly T[]): T[] {
  return events
    .map((event, i) => ({ event, i, t: new Date(event.at).getTime() || 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.event);
}

/** The log's filter: a family, a repo, and words that must all appear in what a row says. */
export function filterEvents(
  events: readonly RoutedEvent[],
  filter: EventFilter,
  titleOf: (id: string) => string,
  label: (event: RoutedEvent) => string,
): RoutedEvent[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((event) => {
    if (filter.family !== 'all' && eventFamily(event.type) !== filter.family) return false;
    if (filter.repo !== undefined && event.repo !== filter.repo) return false;
    if (words.length === 0) return true;
    const hay = [
      label(event),
      event.subject !== undefined ? titleOf(event.subject) : '',
      event.repo ?? '',
      eventDetail(event, titleOf) ?? '',
      ...event.routing.map((r) => titleOf(r.node)),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export interface EventDay<T> {
  day: string;
  events: T[];
}

/**
 * Consecutive events of one day under one heading (the input is already
 * newest first). Days read as the chat's do: "Today", "Yesterday", a date.
 */
export function groupByDay<T extends Pick<RoutedEvent, 'at'>>(
  events: readonly T[],
  now: number = Date.now(),
): EventDay<T>[] {
  const out: EventDay<T>[] = [];
  for (const event of events) {
    const day = dayLabel(event.at, now) || event.at;
    const last = out[out.length - 1];
    if (last && last.day === day) last.events.push(event);
    else out.push({ day, events: [event] });
  }
  return out;
}
