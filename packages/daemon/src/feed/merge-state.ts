/**
 * T380: "finished with nothing to merge", for the cockpit frame.
 *
 * A work node whose agent finished without committing reads *Ready to merge*
 * unless the frame says otherwise, and whether a branch has commits beyond
 * its target is a git question. Like the repo remotes (T362) the frame never
 * waits on git: `peek` answers from the cache and, when the node's answer is
 * stale, schedules a check off the frame's path; a changed answer calls
 * `onChange` so the frame is pushed again.
 *
 * The answer is keyed on what can change it: the agent's last status change
 * (a worker commits only while it runs), the branch and a recorded conflict.
 * A commit made by hand in the worktree is picked up within `ttlMs`.
 *
 * T410: the same check measures a ready node's change ("3 files · +120 −14"),
 * so its Merge card says how much it merges.
 */

import type { Stream } from '@agile-agents/shared';
import type { DiffStat } from '../delivery';

/** What `DeliveryService.preflight` says about a node, as far as this needs. */
export interface MergePreflight {
  ahead?: number;
  merged?: boolean;
  conflicts?: string[];
}

export interface NothingToMergeCacheOptions {
  preflight: (streamId: string) => MergePreflight;
  /** T410: the size of a node's change, measured when it has commits to merge. */
  stat?: (streamId: string) => DiffStat | undefined;
  ttlMs?: number;
  now?: () => number;
  /** Runs a check off the frame's path; `setTimeout(fn, 0)` by default. */
  schedule?: (fn: () => void) => void;
  onChange?: () => void;
}

export const NOTHING_TO_MERGE_TTL_MS = 30_000;

interface Cached {
  sig: string;
  value: boolean;
  stat?: DiffStat;
  at: number;
}

const sameStat = (a: DiffStat | undefined, b: DiffStat | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.files === b.files &&
    a.added === b.added &&
    a.removed === b.removed);

/** Only a finished, open work node on a branch can be "ready to merge". */
export function mayBeReady(stream: Stream): boolean {
  return (
    stream.agent.status === 'done' &&
    stream.human.status === 'open' &&
    stream.archived !== true &&
    stream.repo !== undefined &&
    stream.branch !== undefined &&
    stream.delivery_state?.status !== 'pr_open'
  );
}

function signature(stream: Stream): string {
  return [
    stream.agent.updated_at,
    stream.branch ?? '',
    stream.land_conflict ? 'conflict' : '',
  ].join('\0');
}

export class NothingToMergeCache {
  private readonly cache = new Map<string, Cached>();
  private readonly queued = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly preflight: (streamId: string) => MergePreflight;
  private readonly stat: ((streamId: string) => DiffStat | undefined) | undefined;
  onChange: (() => void) | undefined;

  constructor(options: NothingToMergeCacheOptions) {
    this.preflight = options.preflight;
    this.stat = options.stat;
    this.ttlMs = options.ttlMs ?? NOTHING_TO_MERGE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));
    this.onChange = options.onChange;
  }

  /**
   * True when the node's branch is known to have no commits beyond its
   * target (and was not merged by hand). Never runs git itself.
   */
  peek(stream: Stream): boolean {
    return this.peekState(stream).nothingToMerge;
  }

  /**
   * T410: `peek`, and the size of the node's change when it has one to
   * merge (`undefined` until measured). Never runs git itself.
   */
  peekState(stream: Stream): { nothingToMerge: boolean; stat?: DiffStat } {
    if (!mayBeReady(stream)) {
      this.cache.delete(stream.id);
      return { nothingToMerge: false };
    }
    const sig = signature(stream);
    const hit = this.cache.get(stream.id);
    const known = hit !== undefined && hit.sig === sig;
    if (!known || this.now() - hit.at >= this.ttlMs) this.queue(stream.id, sig);
    if (!known) return { nothingToMerge: false };
    return { nothingToMerge: hit.value, ...(hit.stat !== undefined ? { stat: hit.stat } : {}) };
  }

  private queue(id: string, sig: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.schedule(() => {
      this.queued.delete(id);
      let value = false;
      let stat: DiffStat | undefined;
      try {
        const pre = this.preflight(id);
        value = pre.ahead === 0 && pre.merged !== true && pre.conflicts === undefined;
        if (this.stat !== undefined && (pre.ahead ?? 0) > 0) stat = this.stat(id);
      } catch {
        // A node that can't be checked keeps its Merge: the click says why.
      }
      const before = this.cache.get(id);
      this.cache.set(id, { sig, value, ...(stat !== undefined ? { stat } : {}), at: this.now() });
      if ((before?.value ?? false) !== value || !sameStat(before?.stat, stat)) {
        try {
          this.onChange?.();
        } catch {
          // A failed re-push is the listener's problem, not the cache's.
        }
      }
    });
  }
}
