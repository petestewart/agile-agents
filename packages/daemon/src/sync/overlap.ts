/**
 * T227 (projects-design §4.3, §14.6): overlap tracking. Every live work
 * node keeps `touched` (merge-base diff plus uncommitted and untracked
 * files), recomputed after edit hooks, after commits and every 60 s. Two
 * live work nodes on the same repo, in any project, sharing a file are an
 * overlap. Overlaps are derived from `touched`, never stored, so one clears
 * as soon as either node stops being live (merged, landed, closed) or stops
 * touching the file.
 */

import { isAbsolute, join } from 'node:path';
import type { ReposConfig, Stream, TouchedSummary } from '@agile-agents/shared';
import { liveChildrenOf, nodeRole } from '@agile-agents/shared';
import { git } from '../delivery/git';
import { mainBranch } from '../delivery/service';
import { type EmitRouted, trimFiles } from '../events/producers';
import type { StreamService } from '../streams/service';

export const OVERLAP_RECOMPUTE_MS = 60_000;
const TOUCHED_MAX_FILES = 2_000;
const ENDED_DELIVERY = new Set(['merged', 'closed_unmerged']);

/** A work node with a repo, still open, not delivered. */
export function isLiveWorkNode(s: Stream, all: readonly Stream[]): boolean {
  if (s.archived === true || s.repo === undefined) return false;
  if (s.human.status === 'landed' || s.human.status === 'closed') return false;
  if (s.delivery_state !== undefined && ENDED_DELIVERY.has(s.delivery_state.status)) return false;
  return nodeRole(s, liveChildrenOf(s.id, all)) === 'work';
}

export interface Overlap {
  repo: string;
  nodes: [string, string];
  files: string[];
}

/** Every pair of live work nodes on one repo whose `touched` files intersect. */
export function findOverlaps(all: readonly Stream[]): Overlap[] {
  const live = all.filter((s) => s.touched !== undefined && isLiveWorkNode(s, all));
  const out: Overlap[] = [];
  for (let i = 0; i < live.length; i++) {
    const a = live[i] as Stream;
    const aFiles = new Set(a.touched?.files);
    for (const b of live.slice(i + 1)) {
      if (b.repo !== a.repo) continue;
      const files = (b.touched?.files ?? []).filter((f) => aFiles.has(f));
      if (files.length > 0) out.push({ repo: a.repo as string, nodes: [a.id, b.id], files });
    }
  }
  return out;
}

/** The overlapping nodes and all their ancestors (where the warning shows). */
export function overlapMarked(overlaps: readonly Overlap[], all: readonly Stream[]): Set<string> {
  const byId = new Map(all.map((s) => [s.id, s]));
  const marked = new Set<string>();
  for (const o of overlaps) {
    for (const id of o.nodes) {
      let cur: string | undefined = id;
      while (cur !== undefined && !marked.has(cur)) {
        marked.add(cur);
        cur = byId.get(cur)?.parent;
      }
    }
  }
  return marked;
}

/** `touched` for a worktree against `main`; `undefined` when git can't answer. */
export function computeTouched(
  worktree: string,
  repoRoot: string,
  main: string,
  now: Date = new Date(),
): TouchedSummary | undefined {
  const base = git(['merge-base', 'HEAD', main], worktree, repoRoot);
  if (base.exitCode !== 0 || base.stdout === '') return undefined;
  // `diff <base>` covers commits since the base plus staged and unstaged edits.
  const diff = git(['diff', '--name-only', base.stdout], worktree, repoRoot);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], worktree, repoRoot);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) return undefined;
  const files = [
    ...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean)),
  ]
    .sort()
    .slice(0, TOUCHED_MAX_FILES);
  return { files, base: base.stdout, at: now.toISOString() };
}

export interface OverlapTrackerOptions {
  streams: StreamService;
  repos: () => ReposConfig;
  /** 0 disables the periodic sweep. */
  intervalMs?: number;
  now?: () => Date;
  /** T244: `overlap` when this node starts sharing a file with another live node. */
  emit?: EmitRouted;
}

/** Keeps `touched` current for live work nodes; writes only on a change. */
export class OverlapTracker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: OverlapTrackerOptions) {}

  start(): void {
    const ms = this.options.intervalMs ?? OVERLAP_RECOMPUTE_MS;
    if (ms <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.recomputeAll().catch((err) => console.error('overlap sweep failed:', err));
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async recomputeAll(): Promise<void> {
    const all = this.options.streams.list();
    for (const s of all) {
      if (isLiveWorkNode(s, all)) await this.recompute(s.id);
    }
  }

  /** Recomputes one node's `touched`; a node that isn't live, or has no worktree yet, is skipped. */
  async recompute(id: string): Promise<void> {
    const all = this.options.streams.list();
    const s = all.find((x) => x.id === id);
    if (s === undefined || s.worktree === undefined || !isLiveWorkNode(s, all)) return;
    const entry = this.options.repos()[s.repo as string];
    if (entry === undefined) return;
    const worktree = isAbsolute(s.worktree) ? s.worktree : join(entry.path, s.worktree);
    const touched = computeTouched(
      worktree,
      entry.path,
      mainBranch(entry, entry.path),
      this.options.now?.() ?? new Date(),
    );
    if (touched === undefined) return;
    const prev = s.touched;
    if (
      prev !== undefined &&
      prev.base === touched.base &&
      prev.files.join('\n') === touched.files.join('\n')
    ) {
      return;
    }
    await this.options.streams.update('daemon', id, { touched });
    await this.emitNew(id, all);
  }

  /** One `overlap` per pair with this node that was not an overlap before this update. */
  private async emitNew(id: string, before: readonly Stream[]): Promise<void> {
    const emit = this.options.emit;
    if (emit === undefined) return;
    const other = (o: Overlap) => (o.nodes[0] === id ? o.nodes[1] : o.nodes[0]);
    const had = new Set(
      findOverlaps(before)
        .filter((o) => o.nodes.includes(id))
        .map(other),
    );
    const after = this.options.streams.list();
    const byId = new Map(after.map((s) => [s.id, s]));
    for (const o of findOverlaps(after)) {
      if (!o.nodes.includes(id) || had.has(other(o))) continue;
      const peer = other(o);
      const project = byId.get(peer)?.project;
      const own = byId.get(id)?.project;
      await emit({
        type: 'overlap',
        subject: id,
        repo: o.repo,
        ...(own !== undefined ? { project: own } : {}),
        by: 'daemon',
        parties: [peer],
        payload: {
          other: peer,
          ...(project !== undefined ? { other_project: project } : {}),
          files: trimFiles(o.files),
        },
      });
    }
  }
}
