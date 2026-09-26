/**
 * T360: what a node's status *reads as* (design/cockpit-ui.md §6). One
 * mapping from a cockpit row (or a stream record shaped like one) to a key,
 * a word and a tone, so the rail, the page header, the lenses and the cards
 * never disagree about what a node is doing. `streamDot` (lib/streams.ts)
 * stays as it was for the dot's `data-dot` colour the e2e suites read.
 *
 * Pure: no DOM, covered by plain `bun test`.
 */

import type { CockpitStreamRow } from './feed-types';

export type NodeStatusKey =
  | 'merged'
  | 'closed'
  | 'needs_you'
  | 'blocked'
  | 'pr_open'
  | 'ready'
  | 'done'
  | 'waiting'
  | 'working'
  | 'not_started'
  | 'stopped'
  | 'idle';

export type StatusTone = 'amber' | 'blue' | 'green' | 'purple' | 'red' | 'gray';

export interface NodeStatus {
  key: NodeStatusKey;
  /** What the UI says: "Needs you", "Ready to merge". */
  label: string;
  tone: StatusTone;
  /** One sentence for a tooltip: what it means and whose move it is. */
  hint: string;
}

/** The row fields the mapping reads. T361 adds `never_started` and `stopped` to the frame. */
export type StatusInput = Pick<CockpitStreamRow, 'agent_status' | 'human_status'> &
  Partial<Pick<CockpitStreamRow, 'role' | 'project' | 'pr_open' | 'live' | 'waiting_for_plan'>> & {
    never_started?: true;
    stopped?: true;
    /** Unsatisfied "waits on" links (the row's `waits_on`). */
    waits_on?: readonly string[];
  };

const STATUS: Record<NodeStatusKey, Omit<NodeStatus, 'key'>> = {
  merged: { label: 'Merged', tone: 'purple', hint: 'Its work is merged. Nothing left to do.' },
  closed: { label: 'Closed', tone: 'gray', hint: 'Closed without merging.' },
  needs_you: {
    label: 'Needs you',
    tone: 'amber',
    hint: 'The agent is waiting on your answer or decision.',
  },
  blocked: { label: 'Blocked', tone: 'red', hint: 'The agent is stuck and needs a hand.' },
  pr_open: {
    label: 'PR open',
    tone: 'blue',
    hint: 'A pull request is open; the agent looks after it until it merges.',
  },
  ready: {
    label: 'Ready to merge',
    tone: 'amber',
    hint: 'The agent finished. Review the changes and merge.',
  },
  done: { label: 'Done', tone: 'green', hint: 'The agent finished; there is nothing to merge.' },
  waiting: { label: 'Waiting', tone: 'gray', hint: 'Waiting on a plan or another node.' },
  working: { label: 'Working', tone: 'blue', hint: 'The agent is working.' },
  not_started: {
    label: 'Not started',
    tone: 'gray',
    hint: 'No agent has run here yet. Send a message or press Start.',
  },
  stopped: {
    label: 'Stopped',
    tone: 'gray',
    hint: 'You stopped its agent. Send a message or press Start to resume.',
  },
  idle: { label: 'Idle', tone: 'gray', hint: 'Nothing is running; the agent wakes on new events.' },
};

/**
 * A coordinating node, a project root, a project's conversation (no branch),
 * or a node whose PR is open (it merges on GitHub): `done` is not a merge.
 * Same rule as `streamDot`'s.
 */
function nothingToMerge(row: StatusInput): boolean {
  return (
    row.pr_open === true ||
    row.role === 'coordinating' ||
    row.role === 'project' ||
    (row.role === 'conversation' && row.project !== undefined)
  );
}

export function statusKey(row: StatusInput): NodeStatusKey {
  if (row.human_status === 'landed') return 'merged';
  if (row.human_status === 'closed') return 'closed';
  if (row.human_status === 'waiting_on_you' || row.agent_status === 'question') {
    // A finished branch waits on you as "ready", not as a question.
    if (row.agent_status === 'done' && !nothingToMerge(row)) return 'ready';
    return 'needs_you';
  }
  if (row.agent_status === 'blocked') return 'blocked';
  if (row.agent_status === 'done') {
    if (row.pr_open) return 'pr_open';
    return nothingToMerge(row) ? 'done' : 'ready';
  }
  if (row.waiting_for_plan) return 'waiting';
  if (row.agent_status === 'working') return 'working';
  if (row.live) return 'idle';
  if (row.never_started) return 'not_started';
  if (row.stopped) return 'stopped';
  if ((row.waits_on ?? []).length > 0) return 'waiting';
  return 'idle';
}

export function nodeStatus(row: StatusInput): NodeStatus {
  const key = statusKey(row);
  // T374: a conversation goes on after a turn: its agent replied, it isn't "done".
  if (key === 'done' && row.role === 'conversation') {
    return {
      key,
      ...STATUS.done,
      label: 'Replied',
      hint: 'The agent answered. Reply to continue the conversation.',
    };
  }
  return { key, ...STATUS[key] };
}

export function statusOf(key: NodeStatusKey): NodeStatus {
  return { key, ...STATUS[key] };
}

/** Statuses that are the human's move: the rail and a folded subtree call them out. */
export function isYourMove(key: NodeStatusKey): boolean {
  return key === 'needs_you' || key === 'ready' || key === 'blocked';
}

/** Role names in words, for badges and tooltips (design/cockpit-ui.md §2). */
export const ROLE_LABEL: Record<NonNullable<StatusInput['role']>, string> = {
  project: 'Project',
  coordinating: 'Coordinating',
  work: 'Work',
  conversation: 'Conversation',
};

export const ROLE_HINT: Record<NonNullable<StatusInput['role']>, string> = {
  project: 'The project root: its settings and top-level nodes.',
  coordinating: 'Splits the work into parts, writes the plan, tracks them.',
  work: 'Writes code on its own branch in one repo, then delivers it.',
  conversation: 'Talks, researches and explains. No repo.',
};

/** "3m", "2h", "5d": a compact age for lists; "now" under a minute. */
export function ago(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
