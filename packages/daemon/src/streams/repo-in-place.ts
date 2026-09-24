/**
 * T205: "+ Repo" in place (projects-design §7). The node keeps its thread;
 * the tree is reshaped behind it:
 *
 *   - conversation + repo → work node: its branch and worktree are cut now;
 *   - work (repo A) + repo B → coordinating: the branch, worktree and
 *     session history move to a new child "A part", and a "B part" child
 *     is created;
 *   - switch on a work node with nothing committed → as above, and the
 *     empty "A part" is closed.
 *
 * New parts start with a pointer to the thread so far; docs, rules and the
 * goal chain reach them as ancestors'. A session live on the node is
 * stopped before the reshape and restarted after it, so it runs in the
 * right place: in the new worktree (work) or the session dir as the
 * coordinator (coordinating, D20). Parts are not started: they are work
 * nodes whose agent the coordinator or the human starts.
 */

import { type SessionRef, type Stream, liveChildrenOf, nodeRole } from '@agile-agents/shared';
import { git, removeWorktreeSafely } from '../delivery/git';
import { mainBranch } from '../delivery/service';
import { createWorktree, slugify } from '../runner/worktrees';
import type { StateStore } from '../store/store';
import { type StreamService, UnknownRepoError } from './service';

/** The slice of `AttachService` a reshape needs (kept structural: no import cycle). */
export interface ReshapeSessions {
  attach(streamId: string): Promise<unknown>;
  stop(streamId: string): Promise<string[]>;
}

/** A reshape the node's state doesn't allow (-32602 at the edge). */
export class RepoInPlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoInPlaceError';
  }
}

export interface RepoInPlaceResult {
  node: Stream;
  /** The children the reshape created, in order ("A part", "B part"). */
  parts: Stream[];
}

export class RepoInPlaceService {
  constructor(
    private readonly store: StateStore,
    private readonly streams: StreamService,
    private readonly sessions: ReshapeSessions,
  ) {}

  /** `node.add_repo`: the three rows of §7's table, minus the switch. */
  addRepo(nodeId: string, repo: string): Promise<RepoInPlaceResult> {
    return this.reshape(nodeId, repo, false);
  }

  /** `node.switch_repo`: a work node with nothing committed moves to another repo. */
  switchRepo(nodeId: string, repo: string): Promise<RepoInPlaceResult> {
    return this.reshape(nodeId, repo, true);
  }

  private async reshape(
    nodeId: string,
    repo: string,
    switching: boolean,
  ): Promise<RepoInPlaceResult> {
    const repos = this.store.getRepos();
    const entry = repos[repo];
    if (entry === undefined) throw new UnknownRepoError(repo, Object.keys(repos).sort());
    const node = this.streams.get(nodeId);
    if (node.human.status === 'closed' || node.archived === true) {
      throw new RepoInPlaceError(`node ${nodeId} is closed or archived`);
    }
    const role = nodeRole(node, liveChildrenOf(node.id, this.streams.list()));
    if (role === 'project') {
      throw new RepoInPlaceError('a project root lists repos in its settings; add the repo there');
    }
    if (role === 'work' && node.repo === repo) {
      throw new RepoInPlaceError(`node ${nodeId} already works in ${repo}`);
    }
    if (switching && role !== 'work') {
      throw new RepoInPlaceError(`switch needs a work node; ${nodeId} is ${role} (use add-repo)`);
    }
    if (switching) this.assertNothingCommitted(node);

    const wasLive = node.sessions.some(
      (s) => s.role === 'worker' && s.status !== 'stopped' && s.status !== 'error',
    );
    // Stop first, so the exit path writes onto the records before they move.
    await this.sessions.stop(node.id);

    let parts: Stream[] = [];
    if (role === 'conversation') {
      const created = await createWorktree(entry.path, { id: node.id, slug: slugify(node.title) });
      await this.streams.update('daemon', node.id, {
        repo,
        branch: created.branch,
        worktree: created.path,
      });
      await this.event(node.id, `repo added: ${repo}; now a work node on ${created.branch}`);
    } else if (role === 'coordinating') {
      parts = [await this.newPart(node, repo)];
      await this.event(node.id, `repo added: ${repo} (new part ${parts[0]?.id})`);
    } else {
      parts = await this.splitWorkNode(node, repo);
      if (switching) {
        const [empty] = parts;
        if (empty !== undefined) await this.closeEmptyPart(empty);
      }
      await this.event(
        node.id,
        switching
          ? `switched to ${repo}: the empty ${node.repo} part was closed`
          : `repo added: ${repo}; now coordinating ${parts.map((p) => p.title).join(', ')}`,
      );
    }

    if (wasLive) {
      try {
        await this.sessions.attach(node.id);
      } catch (err) {
        await this.event(
          node.id,
          `could not restart the agent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { node: this.streams.get(node.id), parts: parts.map((p) => this.streams.get(p.id)) };
  }

  /** Work → coordinating: the branch, worktree and sessions go to "<repo> part". */
  private async splitWorkNode(node: Stream, repo: string): Promise<Stream[]> {
    const from = node.repo as string;
    const created: string[] = [];
    try {
      const moved = await this.newPart(node, from);
      created.push(moved.id);
      const sessions: SessionRef[] = node.sessions;
      await this.store.updateStream('daemon', moved.id, (before) => ({
        ...before,
        ...(node.branch !== undefined ? { branch: node.branch } : {}),
        ...(node.worktree !== undefined ? { worktree: node.worktree } : {}),
        sessions: [...sessions, ...before.sessions],
      }));
      await this.store.updateStream('daemon', node.id, (before) => {
        const { repo: _r, branch: _b, worktree: _w, land_conflict: _l, ...rest } = before;
        return { ...rest, sessions: [] };
      });
      const added = await this.newPart(this.streams.get(node.id), repo);
      created.push(added.id);
      return [this.streams.get(moved.id), added];
    } catch (err) {
      await this.rollback(node, created);
      throw err;
    }
  }

  /**
   * Best effort: a split that failed midway puts the node's repo fields and
   * sessions back and archives the parts it made (the branch never moved in git).
   */
  private async rollback(node: Stream, created: readonly string[]): Promise<void> {
    for (const id of created) {
      try {
        await this.store.updateStream('daemon', id, (before) => {
          const { branch: _b, worktree: _w, ...rest } = before;
          return { ...rest, sessions: [], archived: true };
        });
      } catch {
        // Keep undoing the rest.
      }
    }
    try {
      await this.store.updateStream('daemon', node.id, (before) => ({
        ...before,
        ...(node.repo !== undefined ? { repo: node.repo } : {}),
        ...(node.branch !== undefined ? { branch: node.branch } : {}),
        ...(node.worktree !== undefined ? { worktree: node.worktree } : {}),
        ...(node.land_conflict !== undefined ? { land_conflict: node.land_conflict } : {}),
        sessions: node.sessions,
      }));
      await this.event(node.id, 'repo add failed; the node was put back as it was');
    } catch {
      // Nothing more to do: the caller sees the original error.
    }
  }

  private async newPart(node: Stream, repo: string): Promise<Stream> {
    const part = await this.streams.create('daemon', {
      title: `${repo} part`,
      goal: node.goal,
      parent: node.id,
      repo,
    });
    const total = this.streams.readThread(node.id, { limit: 1 }).total;
    await this.streams.appendThread('daemon', part.id, {
      kind: 'event',
      body: `part of "${node.title}": its thread so far (${total} entries) is the context; read it by id`,
      ref: node.id,
    });
    return part;
  }

  /** Switch refuses a branch with commits past main, or a worktree with changes. */
  private assertNothingCommitted(node: Stream): void {
    if (node.branch === undefined || node.repo === undefined) return;
    const entry = this.store.getRepos()[node.repo];
    if (entry === undefined) return;
    const main = mainBranch(entry, entry.path);
    const ahead = git(['rev-list', '--count', `${main}..${node.branch}`], entry.path, entry.path);
    if (ahead.exitCode !== 0 || ahead.stdout !== '0') {
      throw new RepoInPlaceError(
        `node ${node.id} has commits on ${node.branch}; use add-repo to keep them in a part`,
      );
    }
    if (node.worktree !== undefined) {
      const status = git(['status', '--porcelain'], node.worktree, entry.path);
      if (status.exitCode === 0 && status.stdout !== '') {
        throw new RepoInPlaceError(
          `node ${node.id} has uncommitted changes in ${node.worktree}; commit or discard them first`,
        );
      }
    }
  }

  private async closeEmptyPart(part: Stream): Promise<void> {
    const entry = part.repo === undefined ? undefined : this.store.getRepos()[part.repo];
    if (entry !== undefined && part.worktree !== undefined) {
      const removed = removeWorktreeSafely(entry.path, part.worktree);
      if (removed.removed && part.branch !== undefined) {
        git(['branch', '-D', part.branch], entry.path, entry.path);
      }
    }
    await this.streams.close('daemon', part.id, 'switched away with nothing committed');
  }

  private async event(id: string, body: string): Promise<void> {
    await this.streams.appendThread('daemon', id, { kind: 'event', body });
  }
}
