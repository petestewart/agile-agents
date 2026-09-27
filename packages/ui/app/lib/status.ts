/**
 * T360: what a node's status *reads as* (design/cockpit-ui.md §6). One
 * mapping from a cockpit row (or a stream record shaped like one) to a key,
 * a word and a tone, so the rail, the page header, the lenses and the cards
 * never disagree about what a node is doing. T447: the dot's `data-dot`
 * colour follows the key (`statusDot` in lib/streams.ts), and a coordinating
 * node's key rolls up its parts (`withParts`).
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
  | 'no_changes'
  | 'merged_outside'
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
  Partial<
    Pick<
      CockpitStreamRow,
      | 'role'
      | 'project'
      | 'pr_open'
      | 'live'
      | 'waiting_for_plan'
      | 'nothing_to_merge'
      | 'merged_outside'
      | 'repo'
      | 'pending_decision'
    >
  > & {
    never_started?: true;
    stopped?: true;
    /** Unsatisfied "waits on" links (the row's `waits_on`). */
    waits_on?: readonly string[];
    /** T447: a coordinating node's (or a project root's) parts, rolled up by `withParts`. */
    parts?: PartsRollup;
  };

/**
 * T447 (audit r7 #2): a node's parts at a glance — its children that are
 * work or coordinating (not conversations), each by its own status, which
 * for a coordinating part is itself rolled up. Derived in the UI from the
 * frame's rows (`withParts`), never stored.
 */
export interface PartsRollup {
  /** Every part, closed ones included. */
  total: number;
  /** Merged, or a coordinating part whose own parts are all finished. */
  merged: number;
  closed: number;
  /** Parts not merged or closed. */
  open: number;
  /** The most urgent open part: the node reads as it does. */
  lead?: { id: string; title: string; key: NodeStatusKey };
}

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
  no_changes: {
    label: 'No changes',
    tone: 'amber',
    hint: 'The agent finished without committing anything, so there is nothing to merge. Close the node, or reply to ask for more.',
  },
  merged_outside: {
    label: 'Already merged',
    tone: 'amber',
    hint: 'Its branch is already in its target (merged outside the cockpit). Mark it merged to finish it.',
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
    // T437: a work node that gained a part keeps its own branch: still a merge.
    (row.role === 'coordinating' && row.repo === undefined) ||
    row.role === 'project' ||
    (row.role === 'conversation' && row.project !== undefined)
  );
}

/**
 * A finished branch, by what the merge check found: T380, no commits beyond
 * its target is still your move (close it); T412, already in its target is
 * your move too (mark it merged); a branch that waits on another node's merge
 * is waiting, not ready (its Merge would be refused).
 */
function readyOrEmpty(row: StatusInput): 'ready' | 'no_changes' | 'merged_outside' | 'waiting' {
  if (row.merged_outside === true) return 'merged_outside';
  if (row.nothing_to_merge === true) return 'no_changes';
  if ((row.waits_on ?? []).length > 0) return 'waiting';
  return 'ready';
}

/**
 * T447: what the node itself reads as, leaving its parts out: its own
 * question, agent and branch. The Delivery panel reads this (a part's
 * merge is not the coordinator's); everything else reads `statusKey`.
 */
export function ownStatusKey(row: StatusInput): NodeStatusKey {
  if (row.human_status === 'landed') return 'merged';
  if (row.human_status === 'closed') return 'closed';
  // T437: a plan, a gate or a proposal of this node's waiting on you is your move too.
  if (
    row.human_status === 'waiting_on_you' ||
    row.agent_status === 'question' ||
    row.pending_decision === true
  ) {
    // A finished branch waits on you as "ready", not as a question.
    if (row.agent_status === 'done' && !nothingToMerge(row)) return readyOrEmpty(row);
    return 'needs_you';
  }
  if (row.agent_status === 'blocked') return 'blocked';
  if (row.agent_status === 'done') {
    if (row.pr_open) return 'pr_open';
    return nothingToMerge(row) ? 'done' : readyOrEmpty(row);
  }
  if (row.waiting_for_plan) return 'waiting';
  if (row.agent_status === 'working') return 'working';
  if (row.live) return 'idle';
  if (row.never_started) return 'not_started';
  if (row.stopped) return 'stopped';
  if ((row.waits_on ?? []).length > 0) return 'waiting';
  return 'idle';
}

/**
 * T447 (audit r7 #2): how urgent a status is when a node's own state and its
 * parts' are weighed together — Needs you > Blocked > Ready to merge >
 * Working > Not started. Finished parts don't take part.
 */
const URGENCY: Record<NodeStatusKey, number> = {
  needs_you: 0,
  blocked: 1,
  ready: 2,
  no_changes: 2,
  merged_outside: 2,
  working: 3,
  pr_open: 4,
  waiting: 5,
  not_started: 6,
  stopped: 7,
  idle: 8,
  done: 9,
  merged: 10,
  closed: 10,
};

/** The node's own states that still count once it has parts: it asks, is stuck, works, or its branch waits. */
const OWN_COUNTS: ReadonlySet<NodeStatusKey> = new Set([
  'needs_you',
  'blocked',
  'ready',
  'no_changes',
  'merged_outside',
  'working',
  'pr_open',
  'waiting',
]);

/** Merged, closed, or (a coordinating part) done: nothing left to do there. */
export function isFinishedKey(key: NodeStatusKey): boolean {
  return key === 'merged' || key === 'closed' || key === 'done';
}

/**
 * T447 (audit r7 #2): a coordinating node (or a project root) with parts is
 * Done only when every part is merged or closed. Until then it reads as the
 * most urgent of its own state and its open parts'. Merged and closed stay
 * its own; a node without parts reads as before.
 */
function rolledUp(own: NodeStatusKey, parts: PartsRollup | undefined): NodeStatusKey {
  if (parts === undefined || parts.total === 0) return own;
  if (own === 'merged' || own === 'closed') return own;
  const mine = OWN_COUNTS.has(own) ? own : undefined;
  const lead = parts.lead?.key;
  if (lead === undefined) return mine ?? 'done';
  if (mine === undefined) return lead;
  return URGENCY[lead] < URGENCY[mine] ? lead : mine;
}

export function statusKey(row: StatusInput): NodeStatusKey {
  return rolledUp(ownStatusKey(row), row.parts);
}

/** T447: the status comes from a part (the lead), not from the node itself. */
export function statusFromPart(row: StatusInput): boolean {
  const lead = row.parts?.lead;
  if (lead === undefined) return false;
  const own = ownStatusKey(row);
  return statusKey(row) === lead.key && !(OWN_COUNTS.has(own) && own === lead.key);
}

const PART_HINT: Partial<Record<NodeStatusKey, (title: string) => string>> = {
  needs_you: (t) => `A part waits on you: ${t}.`,
  blocked: (t) => `A part is stuck: ${t}.`,
  ready: (t) => `A part is ready to merge: ${t}.`,
  no_changes: (t) => `A part finished with nothing to merge: ${t}.`,
  merged_outside: (t) => `A part is already merged outside the cockpit: ${t}.`,
  working: (t) => `Its parts are working (${t} among them).`,
  pr_open: (t) => `A part's pull request is open: ${t}.`,
  waiting: (t) => `Its open parts wait on a plan or another node (${t} among them).`,
  not_started: (t) => `Its open parts haven't started (${t} among them).`,
  stopped: (t) => `Its open parts are stopped (${t} among them).`,
  idle: (t) => `Its open parts are idle (${t} among them).`,
};

/** "2 of 4 merged · waiting for web part": a coordinating node's parts in one line. */
export function partsSummary(parts: PartsRollup | undefined): string | undefined {
  if (parts === undefined || parts.total === 0) return undefined;
  const counted = parts.total - parts.closed;
  const out = [`${parts.merged} of ${counted} merged`];
  if (parts.closed > 0) out.push(`${parts.closed} closed`);
  const lead = parts.lead;
  if (lead !== undefined) {
    const more = parts.open > 1 ? ` and ${parts.open - 1} more` : '';
    switch (lead.key) {
      case 'needs_you':
        out.push(`${lead.title} needs you`);
        break;
      case 'blocked':
        out.push(`${lead.title} is blocked`);
        break;
      case 'ready':
        out.push(`${lead.title} is ready to merge`);
        break;
      default:
        out.push(`waiting for ${lead.title}${more}`);
    }
  } else {
    out.push('every part finished');
  }
  return out.join(' · ');
}

type PartRow = StatusInput & Pick<CockpitStreamRow, 'id' | 'title' | 'parent' | 'role'>;

/** A child that is one of its parent's parts: work or coordinating, not a conversation. */
function isPart(row: Pick<CockpitStreamRow, 'role'>): boolean {
  return row.role === 'work' || row.role === 'coordinating';
}

/**
 * T447 (audit r7 #2): the rows with each coordinating node's and project
 * root's `parts` rolled up, bottom-up, so every place that reads a row's
 * status (the rail, the header, the Overview, Children) reads the same
 * honest one. Rows without parts come back as they were (same object).
 */
export function withParts<R extends PartRow>(rows: readonly R[]): R[] {
  const kids = new Map<string, R[]>();
  for (const row of rows) {
    if (row.parent === undefined || !isPart(row)) continue;
    const list = kids.get(row.parent) ?? [];
    list.push(row);
    kids.set(row.parent, list);
  }
  if (kids.size === 0) return [...rows];
  const done = new Map<string, R>();
  const visiting = new Set<string>();
  const resolve = (row: R): R => {
    const known = done.get(row.id);
    if (known !== undefined) return known;
    const children = (row.role === 'coordinating' || row.role === 'project') && kids.get(row.id);
    if (!children || visiting.has(row.id)) {
      done.set(row.id, row);
      return row;
    }
    visiting.add(row.id);
    const parts: PartsRollup = { total: 0, merged: 0, closed: 0, open: 0 };
    let leadRank = Number.POSITIVE_INFINITY;
    for (const child of children) {
      const part = resolve(child);
      const key = statusKey(part);
      parts.total += 1;
      if (key === 'closed') parts.closed += 1;
      else if (key === 'merged' || key === 'done') parts.merged += 1;
      else {
        parts.open += 1;
        if (URGENCY[key] < leadRank) {
          leadRank = URGENCY[key];
          // A coordinating part that reads as one of its own parts names that one: the node to open.
          const deeper = statusFromPart(part) ? part.parts?.lead : undefined;
          // T446's part names ("<node> · <repo>") read as just the repo under their node.
          const short = child.title.startsWith(`${row.title} · `)
            ? child.title.slice(row.title.length + 3)
            : child.title;
          parts.lead = deeper ?? { id: child.id, title: short || child.title, key };
        }
      }
    }
    visiting.delete(row.id);
    const out = { ...row, parts };
    done.set(row.id, out);
    return out;
  };
  return rows.map(resolve);
}

export function nodeStatus(row: StatusInput): NodeStatus {
  const key = statusKey(row);
  if (statusFromPart(row) && row.parts?.lead !== undefined) {
    const hint = PART_HINT[key]?.(row.parts.lead.title);
    if (hint !== undefined) return { key, ...STATUS[key], hint };
  }
  if (key === 'done' && row.parts !== undefined && row.parts.total > 0) {
    return { key, ...STATUS.done, hint: 'Every part is merged or closed.' };
  }
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
  return (
    key === 'needs_you' ||
    key === 'ready' ||
    key === 'no_changes' ||
    key === 'merged_outside' ||
    key === 'blocked'
  );
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
