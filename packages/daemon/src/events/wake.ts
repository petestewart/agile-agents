/**
 * The wake policy (T243, projects-design P11): which routed events start a
 * session for a node that has none live.
 *
 * - A coordinating node with an agent is woken by any event routed to it.
 * - A work node whose session has ended is woken by `WORK_WAKE_TYPES`;
 *   other events wait for its next turn. A parent's `coordinator_note`
 *   (`note_child`, T287) is one of them (T290), so a child always gets its
 *   coordinator's distilled note, within the same stop rule and budget.
 * - A conversation node is woken by `human_line` and `answer`, and (D36
 *   D10, T351) by `knowledge_accepted`, so an accepted decision reaches a
 *   conversation whose turn ended at once. One item wakes at most
 *   `KNOWLEDGE_WAKE_FANOUT` conversations (`WakeFanout`); the rest get it
 *   on their next turn.
 * - A project root is woken like a coordinating node once it has had a
 *   coordinator (P20, T280); before that it has no agent and never wakes.
 * - A node the human stopped is never woken; its events stay pending.
 * - A wake budget (default 20 per node per hour) stops event loops: past
 *   it the node goes to the inbox and its events stay pending.
 */

import {
  type NodeRole,
  type RoutedEventType,
  type Stream,
  isAgentRole,
} from '@agile-agents/shared';

export const DEFAULT_WAKE_BUDGET_PER_HOUR = 20;

const WORK_WAKE_TYPES: ReadonlySet<RoutedEventType> = new Set<RoutedEventType>([
  'human_line',
  'answer',
  'pr_review',
  'ci_failed',
  'ship_findings',
  'pr_behind',
  'sync_conflict',
  'contract_changed',
  'coordinator_note',
]);

const CONVERSATION_WAKE_TYPES: ReadonlySet<RoutedEventType> = new Set<RoutedEventType>([
  'human_line',
  'answer',
  'knowledge_accepted',
]);

/**
 * T351: how many conversations one accepted item may wake. A global or
 * project item is routed to every live node in scope, and each woken
 * conversation is a vendor session started at once; past the cap the item
 * waits for those conversations' next turn, as it did before D36 D10.
 */
export const KNOWLEDGE_WAKE_FANOUT = 5;

/** P11's table: does an event of `type` wake a node of `role` with no live session? */
export function wakesRole(role: NodeRole, type: RoutedEventType): boolean {
  switch (role) {
    case 'coordinating':
      return true;
    case 'work':
      return WORK_WAKE_TYPES.has(type);
    case 'conversation':
      return CONVERSATION_WAKE_TYPES.has(type);
    case 'project':
      // P20 (T280): a project root's coordinator, like a coordinating node's.
      return true;
  }
}

/**
 * The `ended_reason` prefix of a session the daemon stopped on purpose
 * (T213: a reshape), as opposed to a human's detach, which records none.
 */
export const DAEMON_STOP_PREFIX = 'stopped: ';

/**
 * Stopped by the human: archived, closed or landed, or its agent left
 * `idle` with no live worker (`agile detach`, or created with "Start later").
 * An `idle` the daemon set when it stopped the last worker for its own
 * reason (a reshape) is not the human's stop, so it does not count.
 */
export function stoppedByHuman(node: Stream): boolean {
  if (node.archived === true) return true;
  if (node.human.status === 'closed' || node.human.status === 'landed') return true;
  if (node.agent.status !== 'idle') return false;
  const lastWorker = node.sessions.filter((s) => isAgentRole(s.role)).at(-1);
  return !(
    lastWorker?.status === 'stopped' &&
    lastWorker.ended_reason?.startsWith(DAEMON_STOP_PREFIX) === true
  );
}

/** Why a node is or is not woken. `budget` means it should go to the inbox. */
export type WakeVerdict = 'wake' | 'no_trigger' | 'stopped' | 'no_agent' | 'budget';

/** Per-node sliding-hour wake budget, in memory (a restart starts a fresh hour). */
export class WakeBudget {
  private readonly wakes = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records a wake if the node is under `limit` in the last hour; false when spent. */
  take(node: string, limit: number): boolean {
    const t = this.now();
    const recent = (this.wakes.get(node) ?? []).filter((at) => t - at < 3_600_000);
    if (recent.length >= limit) {
      this.wakes.set(node, recent);
      return false;
    }
    recent.push(t);
    this.wakes.set(node, recent);
    return true;
  }
}

/**
 * T351: the events that would wake a conversation when only accepted
 * knowledge does (no `human_line` or `answer` among them); empty otherwise.
 * Those wakes count against the item's fan-out.
 */
export function fanoutTriggers<E extends { type: RoutedEventType }>(
  role: NodeRole,
  pending: readonly E[],
): E[] {
  if (role !== 'conversation') return [];
  if (pending.some((e) => e.type === 'human_line' || e.type === 'answer')) return [];
  return pending.filter((e) => e.type === 'knowledge_accepted');
}

/** T351: wakes per accepted-knowledge event, in memory (a restart starts afresh). */
export class WakeFanout {
  private readonly woken = new Map<string, number>();
  constructor(private readonly limit: number = KNOWLEDGE_WAKE_FANOUT) {}

  /** Takes a wake from the first of `events` with one left; false when all are spent. */
  take(events: readonly { id: string }[]): boolean {
    const open = events.find((e) => (this.woken.get(e.id) ?? 0) < this.limit);
    if (open === undefined) return false;
    this.woken.set(open.id, (this.woken.get(open.id) ?? 0) + 1);
    return true;
  }
}

/**
 * The decision for a node with pending events and no live session, before
 * the budget. A coordinating node has "an agent" once it has had a worker or coordinator session.
 */
export function wakeVerdict(
  node: Stream,
  role: NodeRole,
  pending: readonly { type: RoutedEventType }[],
): Exclude<WakeVerdict, 'budget'> {
  // A project root has "an agent" once it has had a coordinator (P20).
  if (role === 'project' && !node.sessions.some((s) => s.role === 'coordinator')) {
    return 'no_agent';
  }
  if (role === 'coordinating' && !node.sessions.some((s) => isAgentRole(s.role))) {
    return 'no_agent';
  }
  if (stoppedByHuman(node)) return 'stopped';
  return pending.some((e) => wakesRole(role, e.type)) ? 'wake' : 'no_trigger';
}
