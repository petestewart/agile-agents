/**
 * T225 (projects-design §18, §14.7): the PR poller. The node's open PR is
 * its status: review requested, changes requested, CI failing, approved,
 * merged or closed, written to `delivery_state.pr` and told on the thread
 * (routed events come in T244).
 *
 * - Cadence: every 60 s per open PR, 15 s for a flagged (babysat) node, 5 min
 *   once a PR has not changed for an hour. `tick()` does whatever is due;
 *   `start()` calls it on a short timer. The clock is injected.
 * - Conditional reads (`If-None-Match`): when every read is a 304 the record
 *   is not rewritten.
 * - A rate limit (403/429) pauses all polling until GitHub's reset, with one
 *   thread note per polled node.
 * - Merged: `delivery_state.status: merged`, `human.status: landed`, then the
 *   repo's main check runs at once. Closed unmerged: a question for the human.
 * - Main on a `pr` repo is watched with `git ls-remote` on the same cadence;
 *   when it moves, main is fetched (fast-forward only) and `onMainMoved` runs.
 */

import type { PullRequestState, RepoEntry, Stream } from '@agile-agents/shared';
import { git, gitNetwork, gitWrite } from '../delivery/git';
import { mainBranch } from '../delivery/service';
import type { StreamService } from '../streams/service';
import {
  type Conditional,
  type GitHubCheckRun,
  type GitHubCombinedStatus,
  GitHubError,
  type GitHubPort,
  type GitHubPull,
  type GitHubReview,
} from './port';

export const PR_POLL_MS = 60_000;
export const PR_POLL_FLAGGED_MS = 15_000;
export const PR_POLL_IDLE_MS = 5 * 60_000;
/** A PR unchanged this long drops to `PR_POLL_IDLE_MS`. */
export const PR_IDLE_AFTER_MS = 60 * 60_000;
/** How often `start()` looks for due work. */
export const PR_POLL_TICK_MS = 5_000;
/** A rate limit with no reset time pauses this long. */
const RATE_LIMIT_DEFAULT_PAUSE_MS = 60_000;

export interface PrPollerOptions {
  streams: StreamService;
  repos: () => Record<string, RepoEntry>;
  github: (repo: RepoEntry) => GitHubPort;
  /** Closed unmerged: the question for the human (QuestionService.raise). */
  ask?: (input: { stream: string; raised_by: 'daemon'; text: string }) => Promise<unknown>;
  /** Main moved on a `pr` repo (T226's `MainSync.mainMoved`); `except` is the node whose PR just merged. */
  onMainMoved?: (repo: string, except?: string) => unknown;
  /** T228: after each tick (`DeliveryService.settle`: waits_on, merge-together, auto-merge). */
  afterTick?: () => unknown;
  now?: () => Date;
}

interface PrMemo {
  /** Epoch ms the PR is next due. */
  due: number;
  /** Epoch ms of the last observed change. */
  changedAt: number;
  etags: Partial<
    Record<'reviews' | 'reviewComments' | 'issueComments' | 'checks' | 'status', string>
  >;
  cache: {
    reviews?: GitHubReview[];
    commentIds?: number[];
    checks?: GitHubCheckRun[];
    status?: GitHubCombinedStatus;
  };
}

export class PrPoller {
  private readonly now: () => Date;
  private readonly memo = new Map<string, PrMemo>();
  private readonly flagged = new Set<string>();
  /** Last main sha seen on the remote, per `pr` repo, and when it is next due. */
  private readonly mains = new Map<string, { sha?: string; due: number }>();
  private pausedUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly options: PrPollerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  start(intervalMs = PR_POLL_TICK_MS): void {
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('pr poll failed:', err));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Mid-babysit: poll this node's PR every 15 s (and now). */
  flag(streamId: string, on = true): void {
    if (on) this.flagged.add(streamId);
    else this.flagged.delete(streamId);
    const m = this.memo.get(streamId);
    if (m && on) m.due = Math.min(m.due, this.now().getTime());
  }

  get paused(): boolean {
    return this.now().getTime() < this.pausedUntil;
  }

  /**
   * T340: "Check now". This node's PR is due at once; resolves with the
   * node after the tick that polled it (merged → landed, then `afterTick`).
   */
  async pollNow(streamId: string): Promise<Stream> {
    while (this.running) await this.running.catch(() => {});
    const m = this.memo.get(streamId);
    if (m) m.due = Math.min(m.due, this.now().getTime());
    await this.tick();
    if (this.paused) {
      throw new Error(
        `GitHub rate limit reached; PR polling paused until ${new Date(this.pausedUntil).toISOString()}`,
      );
    }
    return this.options.streams.get(streamId);
  }

  /** Polls every due PR and every due main; one tick at a time. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runTick().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runTick(): Promise<void> {
    const t = this.now().getTime();
    if (t < this.pausedUntil) return;
    const repos = this.options.repos();
    const polled = pollable(this.options.streams.list());
    for (const id of this.memo.keys()) {
      if (!polled.some((s) => s.id === id)) this.memo.delete(id);
    }
    for (const stream of polled) {
      const entry = repos[stream.repo as string];
      if (entry === undefined || entry.github === undefined) continue;
      const memo = this.memoFor(stream.id, t);
      if (memo.due > t) continue;
      try {
        await this.pollOne(stream, entry, memo);
      } catch (err) {
        if (err instanceof GitHubError && err.kind === 'rate_limited') {
          await this.pause(err, polled);
          return;
        }
        console.error(`pr poll ${stream.id} failed:`, err);
      }
      memo.due = t + this.intervalFor(stream.id, memo, t);
    }
    for (const [name, entry] of Object.entries(repos)) {
      if (entry.delivery !== 'pr') continue;
      const m = this.mains.get(name) ?? { due: 0 };
      this.mains.set(name, m);
      if (m.due > t) continue;
      m.due = t + PR_POLL_MS;
      await this.checkMain(name, entry);
    }
    await this.options.afterTick?.();
  }

  private memoFor(id: string, t: number): PrMemo {
    let m = this.memo.get(id);
    if (m === undefined) {
      m = { due: t, changedAt: t, etags: {}, cache: {} };
      this.memo.set(id, m);
    }
    return m;
  }

  private intervalFor(id: string, memo: PrMemo, t: number): number {
    if (this.flagged.has(id)) return PR_POLL_FLAGGED_MS;
    return t - memo.changedAt >= PR_IDLE_AFTER_MS ? PR_POLL_IDLE_MS : PR_POLL_MS;
  }

  private async pause(err: GitHubError, polled: Stream[]): Promise<void> {
    const t = this.now().getTime();
    const until =
      err.resetAt !== undefined && err.resetAt * 1000 > t
        ? err.resetAt * 1000
        : t + RATE_LIMIT_DEFAULT_PAUSE_MS;
    this.pausedUntil = until;
    const line = `GitHub rate limit reached; PR polling paused until ${new Date(until).toISOString()}`;
    for (const s of polled) {
      await this.options.streams.appendThread('daemon', s.id, { kind: 'event', body: line });
    }
  }

  private async pollOne(stream: Stream, entry: RepoEntry, memo: PrMemo): Promise<void> {
    const known = stream.delivery_state?.pr as PullRequestState;
    const gh = this.options.github(entry);
    const pullRes = await gh.getPull(known.number, withEtag(known.etag));
    const pull: GitHubPull | undefined = pullRes.notModified ? undefined : pullRes.data;
    const head = pull?.head.sha ?? known.head;

    const reviewsRes = await gh.listReviews(known.number, withEtag(memo.etags.reviews));
    const rcRes = await gh.listReviewComments(known.number, withEtag(memo.etags.reviewComments));
    const icRes = await gh.listIssueComments(known.number, withEtag(memo.etags.issueComments));
    const checksRes = await gh.listCheckRuns(head, withEtag(memo.etags.checks));
    const statusRes = await gh.getCombinedStatus(head, withEtag(memo.etags.status));

    const all = [pullRes, reviewsRes, rcRes, icRes, checksRes, statusRes];
    const fresh = all.some((r) => !r.notModified);
    if (!fresh && memo.cache.reviews !== undefined) return;

    remember(memo, 'reviews', reviewsRes, (d) => {
      memo.cache.reviews = d;
    });
    remember(memo, 'checks', checksRes, (d) => {
      memo.cache.checks = d;
    });
    remember(memo, 'status', statusRes, (d) => {
      memo.cache.status = d;
    });
    const newComments: Array<{ id: number; user: string; body: string }> = [];
    for (const [key, res] of [
      ['reviewComments', rcRes],
      ['issueComments', icRes],
    ] as const) {
      remember(memo, key, res, (d) => {
        for (const c of d) {
          if (c.id > (known.last_seen.comment_id ?? 0)) newComments.push(c);
        }
      });
    }

    const reviews = memo.cache.reviews ?? [];
    const merged = pull ? pull.merged : known.state === 'merged';
    const state: PullRequestState['state'] = pull
      ? pull.merged
        ? 'merged'
        : pull.state
      : known.state;
    const draft = pull?.draft ?? known.draft;
    const next: PullRequestState = {
      ...known,
      ...(pull ? { url: pull.html_url, base: pull.base.ref || known.base } : {}),
      state,
      draft,
      review: reviewOf(reviews, state === 'open' && !draft),
      checks: checksOf(memo.cache.checks ?? [], memo.cache.status),
      mergeable: pull ? mergeableOf(pull) : known.mergeable,
      // P19: `unavailable` is the daemon's finding, not GitHub's; it stays until GitHub says enabled.
      auto_merge:
        pull?.auto_merge === true
          ? 'enabled'
          : pull && known.auto_merge !== 'unavailable'
            ? 'off'
            : known.auto_merge,
      last_seen: {
        ...known.last_seen,
        ...maxId('review_id', reviews, known.last_seen.review_id),
        ...maxId('comment_id', newComments, known.last_seen.comment_id),
      },
      polled_at: this.now().toISOString(),
      ...(pullRes.etag ? { etag: pullRes.etag } : {}),
    };

    const lines = describe(known, next, reviews, newComments);
    const changed = lines.length > 0 || next.etag !== known.etag;
    if (!changed) return;
    memo.changedAt = this.now().getTime();

    const { streams } = this.options;
    // T340: a re-deliver held by its ship check keeps `held` while the PR stays open.
    const status = merged
      ? 'merged'
      : state === 'closed'
        ? 'closed_unmerged'
        : stream.delivery_state?.status === 'held'
          ? 'held'
          : 'pr_open';
    await streams.update('daemon', stream.id, {
      delivery_state: {
        mode: 'pr',
        status,
        pr: next,
        ...(!merged && stream.delivery_state?.held_by
          ? { held_by: stream.delivery_state.held_by }
          : {}),
        ...(merged && pull?.merge_commit_sha ? { merged_sha: pull.merge_commit_sha } : {}),
        at: this.now().toISOString(),
      },
      ...(merged ? { human: { status: 'landed' as const } } : {}),
    });
    for (const body of lines) {
      await streams.appendThread('daemon', stream.id, { kind: 'event', body });
    }
    if (merged) {
      const m = this.mains.get(stream.repo as string);
      if (m) m.due = 0;
      await this.checkMain(stream.repo as string, entry, stream.id);
    } else if (state === 'closed' && known.state !== 'closed' && this.options.ask) {
      await this.options.ask({
        stream: stream.id,
        raised_by: 'daemon',
        text: `PR #${next.number} was closed without merging. Reopen it (deliver again), or close the node?`,
      });
    }
  }

  /**
   * `git ls-remote <remote> <main>`; when it moved, fast-forward local main
   * and tell `onMainMoved`. The first sight only records the sha, unless a
   * merge just happened (`except` set).
   */
  private async checkMain(name: string, entry: RepoEntry, except?: string): Promise<void> {
    if (entry.delivery !== 'pr' && except === undefined) return;
    const root = entry.path;
    const remote = entry.remote ?? 'origin';
    const main = mainBranch(entry, root);
    const ls = gitNetwork(['ls-remote', remote, `refs/heads/${main}`], root);
    if (ls.exitCode !== 0) return;
    const sha = ls.stdout.split(/\s+/)[0];
    const m = this.mains.get(name) ?? { due: 0 };
    this.mains.set(name, m);
    m.due = this.now().getTime() + PR_POLL_MS;
    const seen = m.sha;
    m.sha = sha;
    if (sha === undefined || sha === '' || (seen === sha && except === undefined)) return;
    if (seen === undefined && except === undefined) return;
    const skipped = fastForwardMain(root, remote, main);
    if (skipped !== undefined) {
      // Retry on the next check; say so once on the node that merged, if any.
      m.sha = seen ?? '';
      const line = `${main} moved on ${remote} but was not updated locally: ${skipped}; sync waits`;
      if (except !== undefined) {
        await this.options.streams.appendThread('daemon', except, { kind: 'event', body: line });
      } else console.error(`pr poller: ${name}: ${line}`);
      return;
    }
    await this.options.onMainMoved?.(name, except);
  }
}

/** Open PRs of live nodes, whatever the delivery status. */
function pollable(all: readonly Stream[]): Stream[] {
  return all.filter(
    (s) =>
      s.archived !== true &&
      s.repo !== undefined &&
      s.human.status !== 'landed' &&
      s.human.status !== 'closed' &&
      s.delivery_state?.mode === 'pr' &&
      // T340: any status with the PR open (a re-deliver's ship check or hold included).
      s.delivery_state.pr?.state === 'open',
  );
}

function withEtag(etag: string | undefined): { etag?: string } {
  return etag ? { etag } : {};
}

function remember<T>(
  memo: PrMemo,
  key: keyof PrMemo['etags'],
  res: Conditional<T>,
  apply: (data: T) => void,
): void {
  if (res.notModified) return;
  if (res.etag) memo.etags[key] = res.etag;
  apply(res.data);
}

function maxId(
  key: 'review_id' | 'comment_id',
  items: Array<{ id: number }>,
  prev: number | undefined,
): Record<string, number> {
  const top = Math.max(prev ?? 0, ...items.map((i) => i.id));
  return top > 0 ? { [key]: top } : {};
}

/** Latest decisive review per user: any changes requested wins, then approved. */
export function reviewOf(reviews: GitHubReview[], awaiting: boolean): PullRequestState['review'] {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
      latest.set(r.user, r.state);
    }
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return awaiting ? 'review_requested' : 'none';
}

const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'error', 'action_required']);

export function checksOf(
  runs: GitHubCheckRun[],
  status: GitHubCombinedStatus | undefined,
): PullRequestState['checks'] {
  const results: string[] = runs.map((r) =>
    r.status === 'completed' ? (r.conclusion ?? 'pending') : 'pending',
  );
  for (const s of status?.statuses ?? []) results.push(s.state);
  if (results.length === 0) return 'none';
  if (results.some((r) => FAILING.has(r))) return 'failing';
  if (results.some((r) => r === 'pending' || r === 'queued' || r === 'in_progress')) {
    return 'pending';
  }
  return 'passing';
}

export function mergeableOf(pull: GitHubPull): PullRequestState['mergeable'] {
  if (pull.mergeable_state === 'behind') return 'behind';
  if (pull.mergeable_state === 'dirty' || pull.mergeable === false) return 'conflicting';
  if (pull.mergeable === true) return 'clean';
  return 'unknown';
}

const REVIEW_WORDS: Record<PullRequestState['review'], string> = {
  none: 'no review',
  review_requested: 'review requested',
  changes_requested: 'changes requested',
  approved: 'approved',
};

/** The thread lines for what changed between two polls. */
function describe(
  before: PullRequestState,
  after: PullRequestState,
  reviews: GitHubReview[],
  comments: Array<{ user: string; body: string }>,
): string[] {
  const pr = `PR #${after.number}`;
  const out: string[] = [];
  if (after.state !== before.state) {
    out.push(after.state === 'merged' ? `${pr} merged` : `${pr} ${after.state}`);
  }
  for (const r of reviews) {
    if (r.id > (before.last_seen.review_id ?? 0)) {
      out.push(`${pr} review from ${r.user}: ${r.state.toLowerCase()}${clip(r.body)}`);
    }
  }
  if (after.review !== before.review) out.push(`${pr}: ${REVIEW_WORDS[after.review]}`);
  if (after.checks !== before.checks && after.checks !== 'none') {
    out.push(`${pr}: CI ${after.checks}`);
  }
  if (after.mergeable !== before.mergeable && after.mergeable !== 'unknown') {
    out.push(`${pr}: ${after.mergeable === 'clean' ? 'mergeable' : after.mergeable}`);
  }
  if (after.auto_merge !== before.auto_merge) out.push(`${pr}: auto-merge ${after.auto_merge}`);
  const shown = comments.slice(0, 5);
  for (const c of shown) out.push(`${pr} comment from ${c.user}${clip(c.body)}`);
  if (comments.length > shown.length) {
    out.push(`${pr}: ${comments.length - shown.length} more comments`);
  }
  return out;
}

function clip(body: string): string {
  const line =
    body
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  if (line === '') return '';
  return `: ${line.length > 200 ? `${line.slice(0, 199)}…` : line}`;
}

/**
 * Fetch main and fast-forward the local branch; never a merge commit, never
 * a forced move, never a change to a dirty checkout. Returns why it skipped.
 */
function fastForwardMain(root: string, remote: string, main: string): string | undefined {
  const current = git(['symbolic-ref', '--short', 'HEAD'], root, root);
  if (current.exitCode === 0 && current.stdout === main) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], root, root);
    if (dirty.exitCode !== 0 || dirty.stdout !== '') {
      return `${main} is checked out in ${root} with uncommitted changes`;
    }
    const fetched = gitNetwork(['fetch', '-q', remote, main], root);
    if (fetched.exitCode !== 0) return `fetch ${remote} ${main} failed`;
    const ff = gitWrite(['merge', '-q', '--ff-only', 'FETCH_HEAD'], root, root);
    return ff.exitCode === 0 ? undefined : `${main} in ${root} cannot fast-forward`;
  }
  // Refused by git when main is checked out in another worktree or would not fast-forward.
  const fetched = gitNetwork(
    ['fetch', '-q', remote, `refs/heads/${main}:refs/heads/${main}`],
    root,
  );
  return fetched.exitCode === 0 ? undefined : `local ${main} cannot fast-forward from ${remote}`;
}
