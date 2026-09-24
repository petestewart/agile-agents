/**
 * T226 (projects-design §4.2, P15): sync after merge. When a repo's main
 * moves (a direct merge, a PR merged, or a commit made outside the app),
 * main is merged into every other live work node's branch on that repo.
 * Never a rebase, so a pushed branch never needs a force push.
 *
 * - A node mid-turn, or with a dirty worktree, is deferred; it syncs at the
 *   end of its turn (`turnEnded`) or on the next sweep.
 * - A conflict aborts the merge and flags the node `conflict` with the
 *   files in `land_conflict`, which is what the T176 Resolve path reads.
 * - A node with a pushed branch (`delivery_state.pr`) is pushed again after
 *   a clean sync.
 *
 * `mainMoved(repo)` is the hook point: delivery calls it after a direct
 * merge, the sweep calls it when main moved outside the app, and the PR
 * poller (T225) calls it when a PR merges.
 */

import { isAbsolute, join } from 'node:path';
import type { ReposConfig, Stream } from '@agile-agents/shared';
import { liveSession } from '../attach/service';
import { git, gitWrite } from '../delivery/git';
import { mainBranch } from '../delivery/service';
import { type EmitRouted, trimFiles } from '../events/producers';
import type { StreamService } from '../streams/service';
import { isLiveWorkNode } from './overlap';

export const MAIN_SYNC_SWEEP_MS = 60_000;

export type SyncOutcome =
  | { status: 'synced'; pushed: boolean }
  | { status: 'up_to_date' }
  | { status: 'deferred'; reason: 'mid_turn' | 'dirty' | 'failed' }
  | { status: 'conflict'; files: string[] }
  | { status: 'skipped' };

export interface MainSyncOptions {
  streams: StreamService;
  repos: () => ReposConfig;
  /** 0 disables the periodic sweep (main moved outside the app, deferred retries). */
  intervalMs?: number;
  now?: () => Date;
  /** T244: `main_changed` after each sync pass, `sync_conflict` per conflicted node. */
  emit?: EmitRouted;
}

export class MainSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Nodes waiting for the end of a turn or a clean worktree. */
  private readonly deferred = new Set<string>();
  /** Last main sha seen per repo, to notice main moving outside the app. */
  private readonly lastMain = new Map<string, string>();
  /** One sync at a time: git in two worktrees of one repo must not interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MainSyncOptions) {}

  start(): void {
    const ms = this.options.intervalMs ?? MAIN_SYNC_SWEEP_MS;
    if (ms <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => console.error('main sync sweep failed:', err));
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Main moved on `repo`: sync every live work node on it except `except` (the one just merged). */
  mainMoved(
    repo: string,
    except?: string,
    opts: { announce?: boolean } = {},
  ): Promise<Map<string, SyncOutcome>> {
    return this.serial(async () => {
      this.recordMain(repo);
      const all = this.options.streams.list();
      const out = new Map<string, SyncOutcome>();
      for (const s of all) {
        if (s.id === except || s.repo !== repo || !isLiveWorkNode(s, all)) continue;
        out.set(s.id, await this.syncNode(s));
      }
      if (opts.announce !== false) await this.announce(repo, out, except);
      return out;
    });
  }

  /**
   * §15 `main_changed`, sent after the sync so it reports the outcome. One
   * event reaches every same-repo node, so the outcome is the pass's worst:
   * a conflict (its files; the node itself also gets `sync_conflict`), else
   * a deferred sync, else synced.
   */
  private async announce(
    repo: string,
    outcomes: Map<string, SyncOutcome>,
    except?: string,
  ): Promise<void> {
    const emit = this.options.emit;
    const sha = this.readMain(repo);
    if (emit === undefined || sha === undefined) return;
    const results = [...outcomes.values()];
    const files = results.flatMap((o) => (o.status === 'conflict' ? o.files : []));
    const outcome = results.some((o) => o.status === 'conflict')
      ? 'conflict'
      : results.some((o) => o.status === 'deferred')
        ? 'not_synced'
        : 'synced';
    const subject =
      except === undefined ? undefined : this.options.streams.list().find((s) => s.id === except);
    await emit({
      type: 'main_changed',
      repo,
      by: 'daemon',
      ...(except !== undefined ? { subject: except } : {}),
      ...(subject?.project !== undefined ? { project: subject.project } : {}),
      payload: {
        repo,
        sha,
        ...(subject !== undefined ? { subject_title: subject.title.slice(0, 800) } : {}),
        outcome,
        ...(outcome === 'conflict' ? { files: trimFiles([...new Set(files)]) } : {}),
      },
    });
  }

  /** A worker's turn ended: a deferred sync runs now (a dirty worktree defers it again). */
  turnEnded(streamId: string): Promise<SyncOutcome> {
    if (!this.deferred.has(streamId)) return Promise.resolve({ status: 'skipped' });
    return this.serial(async () => {
      const s = this.find(streamId);
      if (s === undefined) {
        this.deferred.delete(streamId);
        return { status: 'skipped' } as const;
      }
      return this.syncNode(s, { turnOver: true });
    });
  }

  /** The periodic check: main moved outside the app, and deferred nodes that may be ready now. */
  async sweep(): Promise<void> {
    for (const repo of Object.keys(this.options.repos())) {
      const before = this.lastMain.get(repo);
      const now = this.readMain(repo);
      if (now === undefined) continue;
      // The first sweep reconciles (nodes left behind across a restart); a
      // node already containing main is a no-op.
      if (before === undefined || before !== now) {
        await this.mainMoved(repo, undefined, { announce: before !== undefined });
      }
    }
    for (const id of [...this.deferred]) {
      await this.serial(async () => {
        const s = this.find(id);
        if (s === undefined) this.deferred.delete(id);
        else await this.syncNode(s);
      });
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private find(id: string): Stream | undefined {
    const all = this.options.streams.list();
    const s = all.find((x) => x.id === id);
    return s !== undefined && isLiveWorkNode(s, all) ? s : undefined;
  }

  private readMain(repo: string): string | undefined {
    const entry = this.options.repos()[repo];
    if (entry === undefined) return undefined;
    const main = mainBranch(entry, entry.path);
    const r = git(['rev-parse', '--verify', '-q', `refs/heads/${main}`], entry.path, entry.path);
    return r.exitCode === 0 && r.stdout !== '' ? r.stdout : undefined;
  }

  private recordMain(repo: string): void {
    const sha = this.readMain(repo);
    if (sha !== undefined) this.lastMain.set(repo, sha);
  }

  private async syncNode(s: Stream, opts: { turnOver?: boolean } = {}): Promise<SyncOutcome> {
    const entry = this.options.repos()[s.repo as string];
    if (entry === undefined || s.worktree === undefined || s.branch === undefined) {
      this.deferred.delete(s.id);
      return { status: 'skipped' };
    }
    const repoRoot = entry.path;
    const wt = isAbsolute(s.worktree) ? s.worktree : join(repoRoot, s.worktree);
    const main = mainBranch(entry, repoRoot);

    if (git(['merge-base', '--is-ancestor', main, 'HEAD'], wt, repoRoot).exitCode === 0) {
      this.deferred.delete(s.id);
      return { status: 'up_to_date' };
    }
    const session = liveSession(s);
    if (
      opts.turnOver !== true &&
      session !== undefined &&
      (session.status === 'running' || session.status === 'starting')
    ) {
      return this.defer(s.id, 'mid_turn');
    }
    const status = git(['status', '--porcelain=v1', '--untracked-files=no'], wt, repoRoot);
    if (status.exitCode !== 0 || status.stdout !== '') return this.defer(s.id, 'dirty');

    const merge = gitWrite(
      ['merge', '--no-edit', '-m', `sync ${main} into ${s.branch} (${s.id})`, main],
      wt,
      repoRoot,
    );
    const at = (this.options.now?.() ?? new Date()).toISOString();
    if (merge.exitCode !== 0) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], wt, repoRoot)
        .stdout.split('\n')
        .filter((f) => f.length > 0);
      gitWrite(['merge', '--abort'], wt, repoRoot);
      if (files.length === 0) {
        // Not a conflict (an untracked file in the way, a lock): try again later.
        await this.note(
          s.id,
          `sync ${main} into ${s.branch} failed: ${merge.stderr || merge.stdout}`,
        );
        return this.defer(s.id, 'failed');
      }
      this.deferred.delete(s.id);
      const line = `sync ${main} into ${s.branch} conflicted in: ${files.join(', ')}`;
      await this.options.streams.update('daemon', s.id, {
        agent: { status: 'blocked' },
        delivery_state: {
          mode: s.delivery_state?.mode ?? 'direct',
          status: 'conflict',
          held_by: [{ reason: 'conflict', detail: line.slice(0, 800) }],
          ...(s.delivery_state?.pr ? { pr: s.delivery_state.pr } : {}),
          at,
        },
        land_conflict: { target: main, files: files.slice(0, 200), at },
      });
      await this.note(s.id, line);
      await this.options.emit?.({
        type: 'sync_conflict',
        subject: s.id,
        repo: s.repo as string,
        ...(s.project !== undefined ? { project: s.project } : {}),
        by: 'daemon',
        payload: { repo: s.repo as string, files: trimFiles(files) },
      });
      return { status: 'conflict', files };
    }

    this.deferred.delete(s.id);
    let pushed = false;
    if (s.delivery_state?.pr !== undefined) {
      const push = git(['push', 'origin', `HEAD:refs/heads/${s.branch}`], wt, repoRoot);
      pushed = push.exitCode === 0;
      if (!pushed) await this.note(s.id, `push of ${s.branch} after sync failed: ${push.stderr}`);
    }
    await this.note(s.id, `synced ${main} into ${s.branch}${pushed ? ' and pushed' : ''}`);
    return { status: 'synced', pushed };
  }

  private defer(id: string, reason: 'mid_turn' | 'dirty' | 'failed'): SyncOutcome {
    this.deferred.add(id);
    return { status: 'deferred', reason };
  }

  private async note(id: string, body: string): Promise<void> {
    await this.options.streams.appendThread('daemon', id, {
      kind: 'event',
      body: body.slice(0, 800),
    });
  }
}
