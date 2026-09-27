/**
 * T368: the words and the ordering behind the lenses (Repos, Running,
 * Dependencies) and the event log. Pure: no DOM, covered by `bun test`.
 * The grouping itself (`groupByRepo`, `runningRows`, `dependencyEdges`)
 * stays in `lib/streams.ts`; this file says what those lists read as.
 */

import type { RoutedEvent, RoutedEventType, RoutingEntry } from '@agile-agents/shared';
import { agentLabel, dayLabel, sessionIdText } from './chat';
import type { CockpitRepoRow, CockpitStreamRow } from './feed-types';
import { overviewCounts } from './overview';
import {
  type NodeStatus,
  type NodeStatusKey,
  type StatusInput,
  nodeStatus,
  statusKey,
} from './status';
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

/** Your move first, then working, then the rest; (T395) most recently changed first within each, then alphabetical. */
const RUNNING_RANK: Partial<Record<NodeStatusKey, number>> = {
  needs_you: 0,
  blocked: 0,
  ready: 0,
  no_changes: 0,
  merged_outside: 0,
  working: 1,
};

export function sortRunning(rows: readonly CockpitStreamRow[]): CockpitStreamRow[] {
  return [...rows].sort(
    (a, b) =>
      (RUNNING_RANK[statusKey(a)] ?? 2) - (RUNNING_RANK[statusKey(b)] ?? 2) ||
      (b.updated_at ?? '').localeCompare(a.updated_at ?? '') ||
      a.title.localeCompare(b.title),
  );
}

/**
 * "1 needs you · 1 blocked · 2 working" — the Running page's subtitle: one
 * count per status, in the Overview's words and order (T424), so a count
 * never mixes two statuses; empty parts left out.
 */
export function runningSummary(rows: readonly CockpitStreamRow[]): string {
  return overviewCounts(rows)
    .map((c) => c.text)
    .join(' · ');
}

/**
 * T424 (finding 37): the titles above a lens row, outermost first — without
 * its project's root when the view shows one project, where it would say
 * the same on every row.
 */
export function lensPath(
  row: CockpitStreamRow,
  rows: readonly CockpitStreamRow[],
  oneProject: boolean,
): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const above: CockpitStreamRow[] = [];
  const seen = new Set<string>([row.id]);
  let at = row.parent !== undefined ? byId.get(row.parent) : undefined;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    above.unshift(at);
    at = at.parent !== undefined ? byId.get(at.parent) : undefined;
  }
  if (oneProject && above[0]?.role === 'project') above.shift();
  return above.map((r) => r.title);
}

/** T382: what runs on a Running row, in words, with the raw ids for its tooltip. */
export interface RunningAgent {
  /** "Claude Opus 5.5 · low"; "Reviewer · …" when a reviewer is all that runs. */
  text: string;
  /** "Worker: claude/claude-opus-5-5 · low effort". */
  title: string;
}

const SESSION_ROLE_WORD: Record<string, string> = {
  worker: 'Worker',
  coordinator: 'Coordinator',
  reviewer: 'Reviewer',
  lessons: 'Lessons pass',
};

/** T382: the row's live session in words (`agentLabel`); `undefined` from a daemon that does not say. */
export function runningAgent(row: Pick<CockpitStreamRow, 'live_agent'>): RunningAgent | undefined {
  const agent = row.live_agent;
  if (agent === undefined) return undefined;
  const role = SESSION_ROLE_WORD[agent.role] ?? agent.role;
  const label = agentLabel(agent);
  // The node's own agent goes without saying; anything else says what it is.
  const own = agent.role === 'worker' || agent.role === 'coordinator';
  return { text: own ? label : `${role} · ${label}`, title: `${role}: ${sessionIdText(agent)}` };
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
  autonomy_applied: 'coordination',
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
  if (event.type === 'autonomy_applied') return appliedTitle(event.payload);
  const words = eventLabel(event).replace(/\b(pr|ci)\b/g, (w) => w.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------- what the agents did (T446)

/** T446: a structural change in words, after who made it ("Coordinator added a part"). */
const APPLIED_VERB: Record<string, string> = {
  add_child: 'added a part',
  add_waits_on: 'linked two nodes',
  set_owner: 'set who owns what',
  approve_contract: 'approved a contract change',
  create_tree: 'created a node and its parts',
  create_project: 'created a project',
  create_node: 'created a node',
  start_node: 'started a node',
  restart_node: 'restarted a node',
  reorder: 'reordered parts',
  merge_siblings: 'merged parts',
};

const APPLIED_WHO: Record<string, string> = {
  coordinator: 'Coordinator',
  director: 'Director',
  human: 'You',
};

/**
 * T446 (audit r7 #7): an `autonomy_applied` event's title: who, then what
 * they did — "Coordinator added a part", "Director created a node and its
 * parts", "You approved a contract change" (a proposal you applied).
 */
export function appliedTitle(payload: Record<string, unknown>): string {
  const who = APPLIED_WHO[String(payload.principal)] ?? 'An agent';
  const action = String(payload.action ?? '');
  // A child with no repo is a node (a conversation), not a part: its summary names no "(repo)".
  if (action === 'add_child' && !/\(\S+\)$/.test(String(payload.summary ?? ''))) {
    return `${who} added a node`;
  }
  return `${who} ${APPLIED_VERB[action] ?? action.replace(/_/g, ' ')}`;
}

/** T446: the nodes an applied change created (its links and its Undo). */
export function appliedNodes(event: Pick<RoutedEvent, 'type' | 'payload'>): string[] {
  return event.type === 'autonomy_applied' ? list(event.payload, 'nodes') : [];
}

/** T446: what Undo needs of a created node's row. */
export type UndoRow = Pick<CockpitStreamRow, 'id' | 'parent' | 'never_started' | 'human_status'>;

/**
 * T446: the nodes Undo deletes (each subtree's top: a part goes with its
 * node), or `undefined` when there is nothing to undo — no node was made,
 * one is gone already, or one has started (its agent ran, or it is closed
 * or merged). `rows` are the frame's open nodes.
 */
export function undoTargets(
  event: Pick<RoutedEvent, 'type' | 'payload'>,
  rows: readonly UndoRow[],
): string[] | undefined {
  const nodes = appliedNodes(event);
  if (nodes.length === 0) return undefined;
  const made = new Set(nodes);
  const found = nodes.map((id) => rows.find((r) => r.id === id));
  if (found.some((r) => r === undefined || r.never_started !== true || r.human_status !== 'open')) {
    return undefined;
  }
  return (found as UndoRow[])
    .filter((r) => r.parent === undefined || !made.has(r.parent))
    .map((r) => r.id);
}

/** Why an event went to a node, in words (a chip) and one sentence (its tooltip). */
export const ROUTE_REASON: Record<RoutingEntry['because'], { label: string; hint: string }> = {
  self: { label: 'itself', hint: 'The event is about this node.' },
  // T413: from the reader's side: a node under it is what the event is about.
  ancestor: {
    label: 'a part of it changed',
    hint: 'The event is about a node under it.',
  },
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

/** The daemon's stand-in for a missing progress line, in events written before T436. */
const NO_PROGRESS = 'no progress line';

/** A node status as the rest of a sentence about it: "is ready to merge", "replied". */
function statusPhrase(status: NodeStatus): string {
  if (status.label === 'Replied') return 'replied';
  if (status.key === 'no_changes') return 'finished with no changes';
  if (status.key === 'pr_open') return 'has its pull request open';
  if (status.key === 'needs_you') return 'needs you';
  return `is ${status.label.toLowerCase()}`;
}

/**
 * T436 (audit r6 #15): what a `child_status` event says the node became, in
 * `lib/status.ts`'s words rather than the daemon's enum: a finished work
 * node "is ready to merge" (or "finished with no changes"), a conversation
 * "replied", a coordinator "is done", a stuck one "is blocked". `row` is the
 * node as the frame has it now (its role, whether its branch has commits);
 * without it (a deleted node) a finished one just "finished".
 */
export function childStatusPhrase(status: string, row?: StatusInput): string {
  if (status === 'question') return 'is asking a question';
  if (status === 'blocked')
    return statusPhrase(nodeStatus({ agent_status: 'blocked', human_status: 'open' }));
  if (status !== 'done') return `is ${status.replace(/_/g, ' ')}`;
  if (row === undefined) return 'finished';
  // The event is about the moment it finished: the node as it was then, open, its agent done.
  return statusPhrase(nodeStatus({ ...row, agent_status: 'done', human_status: 'open' }));
}

/**
 * T368: what an event says, in one short muted line under its label — the
 * message, the PR, the files. Ids read as titles through `titleOf`; T436:
 * `rowOf` gives a node's row, for a status in the status words.
 * `undefined` when there is nothing to add.
 */
export function eventDetail(
  event: Pick<RoutedEvent, 'type' | 'payload'>,
  titleOf: (id: string) => string = (id) => id,
  rowOf: (id: string) => StatusInput | undefined = () => undefined,
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
        const child = str(p, 'child');
        const title = str(p, 'title') ?? titleOf(child ?? '');
        const progress = str(p, 'progress');
        const said = progress !== undefined && progress !== NO_PROGRESS ? ` — ${progress}` : '';
        const row = child !== undefined ? rowOf(child) : undefined;
        return `${title} ${childStatusPhrase(str(p, 'status') ?? '', row)}${said}`;
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
      case 'autonomy_applied':
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
  const matches = eventMatcher(filter, titleOf, label);
  return events.filter(matches);
}

/** T383: `filterEvents`' test for one event (a search of older pages stops at a match). */
export function eventMatcher(
  filter: EventFilter,
  titleOf: (id: string) => string,
  label: (event: RoutedEvent) => string,
): (event: RoutedEvent) => boolean {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return (event) => {
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
  };
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

// ---------------------------------------------------------------- Event log pages (T383)

/** One page as the daemon sends it: newest first, whether older ones exist, and how many in all. */
export interface LogPage<T> {
  events: T[];
  more: boolean;
  total: number;
}

/**
 * What the Events page holds of the log: the newest events, unbroken,
 * newest first (the daemon's order; the last one is the cursor for the
 * next page), and how many pages that took.
 */
export interface LoadedLog<T> extends LogPage<T> {
  pages: number;
}

export function firstPage<T>(page: LogPage<T>): LoadedLog<T> {
  return { events: page.events, more: page.more, total: page.total, pages: 1 };
}

/**
 * The next older page under what is loaded. It was read from `cursor`; if
 * that is no longer the oldest event loaded (the log started again, or the
 * repo changed), the page no longer follows on and is dropped.
 */
export function appendOlder<T extends { id: string }>(
  log: LoadedLog<T>,
  page: LogPage<T>,
  cursor: string,
): LoadedLog<T> {
  if (log.events.at(-1)?.id !== cursor) return log;
  const have = new Set(log.events.map((e) => e.id));
  return {
    events: [...log.events, ...page.events.filter((e) => !have.has(e.id))],
    more: page.more,
    total: page.total,
    pages: log.pages + 1,
  };
}

/**
 * Live events on top: a fresh newest page over what is loaded. What sits
 * above the first event already loaded is new. When none of the page is
 * loaded, more arrived than a page holds, so the loaded pages no longer join
 * on: the log starts again from the fresh page. Unchanged, it is the same
 * object (nothing re-renders).
 */
export function mergeNewest<T extends { id: string }>(
  log: LoadedLog<T>,
  head: LogPage<T>,
): LoadedLog<T> {
  const have = new Set(log.events.map((e) => e.id));
  const fresh: T[] = [];
  for (const event of head.events) {
    if (!have.has(event.id)) {
      fresh.push(event);
      continue;
    }
    if (fresh.length === 0 && head.total === log.total) return log;
    return { ...log, events: [...fresh, ...log.events], total: head.total };
  }
  if (fresh.length === 0 && log.events.length === 0 && head.total === log.total) return log;
  return firstPage(head);
}

/** What is loaded, and how much of it the type filter and the search let through. */
export interface LogView {
  loaded: number;
  total: number;
  more: boolean;
  pages: number;
  /** How many loaded events pass the type filter and the search. */
  matched: number;
  /** The type filter or the search is on (the repo filter is the daemon's, so `total` counts it). */
  narrowed: boolean;
}

const count = (n: number): string => n.toLocaleString('en-US');
const eventsWord = (n: number): string => `${count(n)} ${n === 1 ? 'event' : 'events'}`;

/** The toolbar's count: how much of the log is showing, and of how much. */
export function logCount(v: LogView): string {
  if (!v.narrowed)
    return v.more ? `${count(v.loaded)} of ${eventsWord(v.total)}` : eventsWord(v.total);
  return v.more
    ? `${count(v.matched)} of ${count(v.loaded)} loaded`
    : `${count(v.matched)} of ${eventsWord(v.total)}`;
}

/** Under the list: a button for the next page (with what it will do), the end of the log, or nothing. */
export type LogFooter =
  | { kind: 'more'; label: string; note?: string }
  | { kind: 'end'; note: string }
  | { kind: 'none' };

export function logFooter(v: LogView, pageSize: number): LogFooter {
  if (v.more && !v.narrowed) {
    const next = Math.min(pageSize, v.total - v.loaded);
    return { kind: 'more', label: next > 0 ? `Show ${count(next)} more` : 'Show more' };
  }
  if (v.more) {
    return {
      kind: 'more',
      label: 'Search older events',
      note: `Searched the latest ${count(v.loaded)} of ${eventsWord(v.total)}.`,
    };
  }
  if (v.narrowed) {
    return {
      kind: 'end',
      note: `${v.total === 1 ? 'Searched the only event' : `Searched all ${eventsWord(v.total)}`}. That’s everything.`,
    };
  }
  return v.pages > 1 ? { kind: 'end', note: 'That’s everything.' } : { kind: 'none' };
}

/** The empty state when the filters let nothing through: older pages may still hold a match. */
export function noMatchWords(v: LogView): { title: string; body: string } {
  if (v.more) {
    return {
      title: `No matches in the latest ${eventsWord(v.loaded)}`,
      body: 'Older events may match. Search further back, or clear the filters.',
    };
  }
  return {
    title: 'No events match',
    body: `Nothing in the ${v.total === 1 ? 'one event' : eventsWord(v.total)} matches these filters.`,
  };
}
