/**
 * T471: the trash. A deleted node (Move to trash, `archiveTree`) is in the
 * trash until it is restored or deleted forever. Delete forever removes the
 * node and everything below it: each record, thread, status card and event
 * queue (`StateStore.removeStream`), its questions, gates and plan, other
 * nodes' waits on it, its session logs and its worktree. A branch whose
 * commits are all in its target goes too; one with unmerged commits is kept
 * unless the operator asks for it to go (`deleteBranches`).
 *
 * Git runs through the injected `git`, as delivery runs it. A node whose
 * repo is no longer registered, or whose worktree is already gone, is
 * removed all the same: the record is what makes a node.
 */

import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  type Stream,
  UlidSchema,
  validateHilRequest,
  validatePlan,
  validateQuestion,
} from '@agile-agents/shared';
import type { StateStore } from '../store';
import type { StreamService } from './service';

export interface TrashGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TrashOptions {
  store: StateStore;
  streams: StreamService;
  /** The state home: `sessions/<id>/` holds each session's logs. */
  home: string;
  git: (args: string[], cwd: string, repoRoot: string) => TrashGitResult;
  /** The branch a node's branch merges into (its host's for a helper, else the repo's main). */
  targetOf: (node: Stream, repoRoot: string) => string | undefined;
}

/** A branch Delete forever would keep: it has commits its target doesn't. */
export interface TrashBranch {
  node: string;
  title: string;
  branch: string;
  /** Commits on the branch that its target doesn't have; -1 when it couldn't be counted. */
  unmerged: number;
}

export interface TrashPreview {
  /** What goes, the node first. */
  nodes: Array<{ id: string; title: string }>;
  /** Branches with unmerged commits (kept unless asked). */
  branches: TrashBranch[];
  /** Titles of nodes whose worktree has uncommitted changes (lost). */
  uncommitted: string[];
}

export interface PurgeResult {
  deleted: string[];
  /** Branches kept because they have unmerged commits. */
  kept_branches: string[];
}

export class TrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrashError';
  }
}

export class TrashService {
  constructor(private readonly options: TrashOptions) {}

  /** Nodes in the trash that were deleted on their own (their parent is not in it), newest first. */
  roots(): Stream[] {
    const all = this.options.streams.list({ include_archived: true });
    const byId = new Map(all.map((s) => [s.id, s]));
    return all
      .filter(
        (s) =>
          s.archived === true && s.parent !== undefined && byId.get(s.parent)?.archived !== true,
      )
      .reverse();
  }

  /** What Delete forever on `id` would remove, and what it would keep or lose. */
  preview(id: string): TrashPreview {
    const tree = this.tree(id);
    const branches: TrashBranch[] = [];
    const uncommitted: string[] = [];
    for (const node of tree) {
      const root = this.repoRoot(node);
      if (root === undefined) continue;
      const unmerged = this.unmerged(node, root);
      if (unmerged !== 0 && node.branch !== undefined && this.branchExists(node.branch, root)) {
        branches.push({ node: node.id, title: node.title, branch: node.branch, unmerged });
      }
      if (this.dirty(node, root)) uncommitted.push(node.title);
    }
    return { nodes: tree.map((s) => ({ id: s.id, title: s.title })), branches, uncommitted };
  }

  /** Delete forever: `id` and everything below it, leaves first. */
  async purge(id: string, options: { deleteBranches?: boolean } = {}): Promise<PurgeResult> {
    const tree = this.tree(id);
    const gone = new Set(tree.map((s) => s.id));
    const kept: string[] = [];
    for (const node of [...tree].reverse()) {
      const root = this.repoRoot(node);
      if (root !== undefined) {
        this.removeWorktree(node, root);
        const branch = this.removeBranch(node, root, options.deleteBranches === true);
        if (branch !== undefined) kept.push(branch);
      }
      await this.dropRecordsOf(node.id);
      await this.dropWaitsOn(node.id, gone);
      this.removeSessionLogs(node);
      await this.options.store.removeStream(node.id);
    }
    const top = tree[0];
    if (top?.parent !== undefined && !gone.has(top.parent)) {
      await this.options.streams.appendThread('daemon', top.parent, {
        kind: 'event',
        body: `deleted forever: ${top.title}${tree.length > 1 ? ` with ${tree.length - 1} below it` : ''}`.slice(
          0,
          800,
        ),
      });
    }
    return { deleted: tree.map((s) => s.id), kept_branches: kept };
  }

  /** Empty trash: every trash root, deleted forever. */
  async empty(options: { deleteBranches?: boolean } = {}): Promise<PurgeResult> {
    const out: PurgeResult = { deleted: [], kept_branches: [] };
    for (const root of this.roots()) {
      const one = await this.purge(root.id, options);
      out.deleted.push(...one.deleted);
      out.kept_branches.push(...one.kept_branches);
    }
    return out;
  }

  /** `id` and its subtree; refused unless every one is in the trash, and never a project's root. */
  private tree(id: string): Stream[] {
    const node = this.options.streams.get(id);
    if (node.parent === undefined) {
      throw new TrashError("a project's root goes with its project, not on its own");
    }
    if (node.archived !== true) {
      throw new TrashError(`${node.title} is not in the trash; move it to the trash first`);
    }
    const tree = this.options.streams.subtree(id);
    const live = tree.find((s) => s.archived !== true);
    if (live !== undefined) {
      throw new TrashError(`${live.title} under it is not in the trash`);
    }
    return tree;
  }

  private repoRoot(node: Stream): string | undefined {
    if (node.repo === undefined) return undefined;
    const path = this.options.store.getRepos()[node.repo]?.path;
    return path !== undefined && existsSync(path) ? path : undefined;
  }

  private branchExists(branch: string, root: string): boolean {
    return (
      this.options.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, root)
        .exitCode === 0
    );
  }

  /** Commits on the node's branch its target doesn't have: 0 none (or no branch), -1 unknown. */
  private unmerged(node: Stream, root: string): number {
    if (node.branch === undefined || !this.branchExists(node.branch, root)) return 0;
    const target = this.options.targetOf(node, root);
    if (target === undefined || !this.branchExists(target, root)) return -1;
    const count = this.options.git(
      ['rev-list', '--count', `${target}..${node.branch}`],
      root,
      root,
    );
    const n = Number(count.stdout.trim());
    return count.exitCode === 0 && Number.isInteger(n) ? n : -1;
  }

  /** Uncommitted tracked changes in its worktree (untracked scratch is not work). */
  private dirty(node: Stream, root: string): boolean {
    if (node.worktree === undefined || !existsSync(node.worktree)) return false;
    const status = this.options.git(['status', '--porcelain=v1'], node.worktree, root);
    if (status.exitCode !== 0) return false;
    return status.stdout.split('\n').some((l) => l.length > 0 && !l.startsWith('??'));
  }

  /**
   * Only a worktree under the repo's `.worktrees/` (where every node's is
   * made) is removed: a record pointing anywhere else, the repo itself
   * above all, is left alone.
   */
  private removeWorktree(node: Stream, root: string): void {
    if (node.worktree === undefined) return;
    const inside = resolve(node.worktree).startsWith(`${resolve(root, '.worktrees')}${sep}`);
    if (inside && existsSync(node.worktree)) {
      this.options.git(['worktree', 'remove', '--force', node.worktree], root, root);
      if (existsSync(node.worktree)) rmSync(node.worktree, { recursive: true, force: true });
    }
    this.options.git(['worktree', 'prune'], root, root);
  }

  /** Deletes a merged branch, or any with `force`; returns a branch it kept. */
  private removeBranch(node: Stream, root: string, force: boolean): string | undefined {
    if (node.branch === undefined || !this.branchExists(node.branch, root)) return undefined;
    if (this.unmerged(node, root) !== 0 && !force) return node.branch;
    this.options.git(['branch', '-D', node.branch], root, root);
    return undefined;
  }

  /** Its questions, gates and plan: nothing else reads them once the node is gone. */
  private async dropRecordsOf(id: string): Promise<void> {
    const { store } = this.options;
    for (const q of store.listEntities('questions', validateQuestion)) {
      if (q.stream === id) await store.deleteEntity(`questions/${q.id}.yaml`);
    }
    for (const g of store.listEntities('gates', validateHilRequest)) {
      if (g.stream === id) await store.deleteEntity(`gates/${g.id}.yaml`);
    }
    for (const p of store.listEntities('plans', validatePlan)) {
      if (p.node === id) await store.deleteEntity(`plans/${id}.yaml`);
    }
  }

  /** Other nodes stop waiting on it. */
  private async dropWaitsOn(id: string, gone: ReadonlySet<string>): Promise<void> {
    for (const s of this.options.streams.list({ include_archived: true })) {
      if (gone.has(s.id) || !(s.waits_on ?? []).some((w) => w.node === id)) continue;
      await this.options.store.updateStream('daemon', s.id, (before) => {
        const { waits_on, ...rest } = before;
        const left = (waits_on ?? []).filter((w) => w.node !== id);
        return left.length > 0 ? { ...rest, waits_on: left } : rest;
      });
    }
  }

  private removeSessionLogs(node: Stream): void {
    for (const session of node.sessions) {
      if (!UlidSchema.safeParse(session.id).success) continue;
      rmSync(join(this.options.home, 'sessions', session.id), { recursive: true, force: true });
    }
  }
}
