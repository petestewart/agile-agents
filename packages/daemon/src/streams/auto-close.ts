/**
 * T478: a node set to auto-close (`auto_close`) closes itself when its goal
 * is met, so finished work leaves Needs me without the operator.
 *
 * - A node whose agent reported `goal_met` in the turn that just ended
 *   closes when there is nothing to merge: no commits beyond its target,
 *   no recorded conflict and no uncommitted change in its worktree. With
 *   commits it stays Ready to merge; merging it lands it.
 * - A coordinating node closes once every part is merged or closed (and it
 *   has nothing of its own to merge), whatever its agent said.
 *
 * Never a project's root, a node with no goal, an archived one, or one
 * whose agent is running. Runs from the stream service's `onUpdated`, off
 * the write that triggered it; a failure is logged, never thrown. A close
 * is `StreamService.close` as the daemon, with its reason on the thread;
 * that close is itself an update, so a parent set to auto-close follows.
 */

import type { Stream } from '@agile-agents/shared';

/** What `DeliveryService.preflight` says about a node, as far as this needs. */
export interface AutoClosePreflight {
  ahead?: number;
  merged?: boolean;
  conflicts?: string[];
}

export interface AutoCloseStreams {
  get(id: string): Stream;
  list(): Stream[];
  close(principal: 'daemon', id: string, note?: string): Promise<Stream>;
}

export interface AutoCloseOptions {
  streams: AutoCloseStreams;
  /** The node's branch against its target; throws when it has none to check. */
  preflight: (id: string) => AutoClosePreflight;
  /** True when the node's worktree has uncommitted tracked changes (or can't be read). */
  uncommitted: (node: Stream) => boolean;
  log?: (message: string) => void;
}

/** The thread reason for a node whose agent met its goal. */
export const MET_NOTE = 'auto-closed: its goal is met and there is nothing to merge';
/** The thread reason for a coordinating node whose parts are all done. */
export const PARTS_NOTE = 'auto-closed: every part is merged or closed';

const ENDED: ReadonlySet<Stream['human']['status']> = new Set(['landed', 'closed']);

/** The newest worker or coordinator session: the one whose turn set `agent.status`. */
function lastAgentSession(node: Stream): string | undefined {
  for (let i = node.sessions.length - 1; i >= 0; i--) {
    const s = node.sessions[i];
    if (s !== undefined && (s.role === 'worker' || s.role === 'coordinator')) return s.id;
  }
  return undefined;
}

export class AutoClose {
  constructor(private readonly options: AutoCloseOptions) {}

  /** The `onUpdated` hook. Never throws. */
  async onUpdated(before: Stream, after: Stream): Promise<void> {
    try {
      if (this.justMetGoal(before, after)) await this.closeIfNothingToMerge(after, MET_NOTE);
      if (
        after.parent !== undefined &&
        ENDED.has(after.human.status) &&
        !ENDED.has(before.human.status)
      ) {
        await this.closeIfPartsDone(after.parent);
      }
    } catch (err) {
      this.options.log?.(`auto-close ${after.id} failed: ${String(err)}`);
    }
  }

  /** Its turn just ended `done`, having said `goal_met` in that same session. */
  private justMetGoal(before: Stream, after: Stream): boolean {
    if (after.agent.status !== 'done' || before.agent.status === 'done') return false;
    const met = after.agent.goal_met;
    return met !== undefined && met.session === lastAgentSession(after);
  }

  /** Whether `node` may close itself at all. */
  private eligible(node: Stream): boolean {
    return (
      node.auto_close === true &&
      node.goal !== undefined &&
      node.parent !== undefined &&
      node.human.status === 'open' &&
      node.archived !== true &&
      node.agent.status !== 'working'
    );
  }

  /** Nothing on its branch to merge, no conflict, nothing uncommitted. */
  private nothingToMerge(node: Stream): boolean {
    if (node.branch === undefined) return node.worktree === undefined;
    const pre = this.options.preflight(node.id);
    if (pre.conflicts !== undefined || node.land_conflict !== undefined) return false;
    // Fails closed: a preflight that couldn't count the branch (a live agent, no target)
    // says nothing, and nothing said is not "nothing to merge".
    if (pre.merged !== true && pre.ahead !== 0) return false;
    return !this.options.uncommitted(node);
  }

  private async closeIfNothingToMerge(node: Stream, note: string): Promise<void> {
    if (!this.eligible(node)) return;
    // A coordinating node waits for its parts (`closeIfPartsDone`).
    if (this.openParts(node.id).length > 0) return;
    if (!this.nothingToMerge(node)) return;
    await this.options.streams.close('daemon', node.id, note);
  }

  private async closeIfPartsDone(parentId: string): Promise<void> {
    const parent = this.options.streams.get(parentId);
    if (!this.eligible(parent)) return;
    const parts = this.parts(parentId);
    if (parts.length === 0 || parts.some((p) => !ENDED.has(p.human.status))) return;
    if (!this.nothingToMerge(parent)) return;
    await this.options.streams.close('daemon', parent.id, PARTS_NOTE);
  }

  private parts(parentId: string): Stream[] {
    return this.options.streams.list().filter((s) => s.parent === parentId && s.archived !== true);
  }

  private openParts(parentId: string): Stream[] {
    return this.parts(parentId).filter((p) => !ENDED.has(p.human.status));
  }
}
