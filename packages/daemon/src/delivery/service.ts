/**
 * `DeliveryService` (§14.7, direct path): `agile deliver <node>` (alias
 * `agile land`) and the Delivery panel's Merge button (§8.2): an
 * optional `land` gate, diff-level rules, then `merge --no-ff` into the
 * target; `human.status: landed`, worktree removed, branch kept. The merge
 * runs in a temporary worktree, so a conflict leaves the target untouched
 * and parks the stream `blocked` with the files named. Landing on a
 * protected branch happens only here, by the human (D8); every write is
 * `daemon` (§2.2). Target (D20): the repo's main branch (`mainBranch`);
 * a child never lands into its parent's branch.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DeliveryState,
  type HilRequest,
  type RepoEntry,
  type Stream,
  resolveDelivery,
} from '@agile-agents/shared';
import { liveSession } from '../attach/service';
import type { GateService } from '../gates/service';
import type { GitHubPort, GitHubPull } from '../github/port';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';
import { git, gitWrite, removeWorktreeSafely, runGit } from './git';

/** Refused before anything was touched: caller input or an unlandable stream (-32602 at the edge). */
export class LandRefusedError extends Error {
  constructor(
    public readonly stream: string,
    message: string,
  ) {
    super(message);
    this.name = 'LandRefusedError';
  }
}

/** Human statuses a stream can be landed from — it is still live work. */
const LANDABLE_HUMAN_STATUSES = ['open', 'waiting_on_you'] as const;

/** What a diff-level rule check is handed (§8.2: "the stream's full diff"). */
export interface DiffRuleContext {
  stream: Stream;
  repoRoot: string;
  /** The stream's branch, the left side of the merge. */
  branch: string;
  /** The branch it is about to be merged into. */
  target: string;
  /** The full `target...branch` diff, computed only if a rule actually wants it. */
  diff: () => string;
}

/** A diff-level verdict. For `land`'s caller, `route` and `deny` both mean "no merge on this call". */
export type DiffRuleVerdict =
  | { decision: 'allow' }
  | {
      decision: 'deny' | 'route';
      reason: string;
      rule?: string;
      /** The `classifier_review` gate a `route` raised: `land` returns `gated` and the answer comes back via `wireLandGateResolution`. */
      gate?: HilRequest;
    };

/** The diff-level rule tier (§8.2): `ClassifierDiffRules`, or allow-all with no classifier wired. */
export interface DiffRules {
  check(ctx: DiffRuleContext): DiffRuleVerdict | Promise<DiffRuleVerdict>;
}

export const ALLOW_ALL_DIFF_RULES: DiffRules = {
  check: () => ({ decision: 'allow' }),
};

export type LandOutcome =
  /** A `land` gate was raised and is still pending; approving it lands the stream. */
  | { status: 'gated'; gate: HilRequest; line: string }
  /** The gate was answered `deny`, or a diff-level rule refused the diff. */
  | { status: 'refused'; reason: string; line: string }
  /** Merge conflict: nothing merged, worktree kept, stream blocked. */
  | { status: 'blocked'; target: string; conflicts: string[]; line: string }
  | { status: 'landed'; target: string; sha: string; line: string }
  /** PR mode: the branch was pushed and its PR opened (or updated). */
  | { status: 'pr_open'; target: string; pr: { number: number; url: string }; line: string };

/** The Land button's "before" read (`DeliveryService.preflight`). */
export interface LandPreflight {
  ready: boolean;
  /** Why `land` would refuse right now; absent when `ready`. */
  reason?: string;
  branch?: string;
  target?: string;
  /** Commits on the branch beyond the target. */
  ahead?: number;
  /** The repo asks for a `land` gate: Land raises an inbox item rather than merging. */
  gated?: true;
  /** The branch has its own work and all of it is already in the target: "Mark landed". */
  merged?: true;
  /** T176: the last land conflicted and nothing has worked on the stream since; Resolve offers a worker. */
  conflicts?: string[];
}

/** How much of a stream diff travels in one response. */
export const STREAM_DIFF_MAX_CHARS = 20_000;

/** The stream page's diff tab (`DeliveryService.diff`). */
export interface StreamDiff {
  stream: string;
  branch: string;
  target: string;
  /** Present while the worktree exists (uncommitted edits are included). */
  worktree?: string;
  /** `git diff --stat`. */
  stat: string;
  patch: string;
  truncated: boolean;
}

export interface LandOptions {
  /** Set by the gate-resolution callback: the `land` gate was approved, don't raise another. */
  gateApproved?: boolean;
}

export interface DeliveryServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** Only needed for repos with `land_gate: true`; without it such a repo refuses to land. */
  gates?: GateService;
  /** The diff-level rule tier. Defaults to `ALLOW_ALL_DIFF_RULES`. */
  diffRules?: DiffRules;
  /** PR mode (T224): the GitHub port for a repo; without it a `pr` repo refuses to deliver. */
  github?: (repo: RepoEntry) => GitHubPort;
  /** Tells the retro (§5.5) a stream landed. Fire-and-forget: never a failed land. */
  onStreamEnd?: (streamId: string) => void | Promise<void>;
}

export class DeliveryService {
  private readonly diffRules: DiffRules;

  constructor(private readonly options: DeliveryServiceOptions) {
    this.diffRules = options.diffRules ?? ALLOW_ALL_DIFF_RULES;
  }

  async land(streamId: string, options: LandOptions = {}): Promise<LandOutcome> {
    const { streams } = this.options;
    const stream = streams.get(streamId);
    const { repoEntry, branch } = this.requireLandable(stream);
    const repoRoot = repoEntry.path;
    const target = this.resolveTarget(stream, repoEntry, repoRoot);

    if (!branchExists(repoRoot, target)) {
      throw new LandRefusedError(
        stream.id,
        `target branch ${target} does not exist in ${repoRoot}`,
      );
    }
    const ahead = runGit(['rev-list', '--count', `${target}..${branch}`], repoRoot, repoRoot);
    if (ahead === '0') {
      throw new LandRefusedError(
        stream.id,
        `${branch} has no commits beyond ${target} — nothing to land`,
      );
    }

    // §14.7: the mode is resolved at the first delivery attempt.
    const mode = stream.delivery_state?.mode ?? this.resolveMode(stream, repoEntry);
    const github = mode === 'pr' ? this.requireGitHub(stream, repoEntry, branch) : undefined;

    // 1. The gate, when the repo asks for one (§8.2: default is no gate).
    if (repoEntry.land_gate === true && options.gateApproved !== true) {
      await this.setDeliveryState(stream.id, { mode, status: 'ready' });
      const gated = await this.raiseGate(stream, branch, target);
      if (gated !== undefined) return gated;
    }

    // 2. The ship check: diff-level rules (§8.2; `ClassifierDiffRules` when one is wired).
    await this.setDeliveryState(stream.id, { mode, status: 'ship_checking' });
    const verdict = await this.diffRules.check({
      stream,
      repoRoot,
      branch,
      target,
      diff: () => runGit(['diff', `${target}...${branch}`], repoRoot, repoRoot),
    });
    if (verdict.decision !== 'allow') {
      const what = verdict.decision === 'route' ? 'routed' : 'refused';
      const line = `landing ${what} by diff rule${verdict.rule ? ` ${verdict.rule}` : ''}: ${verdict.reason}`;
      await this.setDeliveryState(stream.id, {
        mode,
        status: 'held',
        held_by: [{ reason: 'ship_check', detail: line }],
      });
      await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      // A route waits on its gate; a deny (or a gateless route) ends the call.
      if (verdict.gate !== undefined) return { status: 'gated', gate: verdict.gate, line };
      return { status: 'refused', reason: verdict.reason, line };
    }

    // 3. PR mode (T224): push, then open or update the one PR.
    if (github !== undefined) return this.deliverPr(stream, repoEntry, github, branch, target);

    // 3. Ready (direct: this call is the Merge click), then the merge in a
    // temporary worktree of the target.
    await this.setDeliveryState(stream.id, { mode, status: 'ready' });
    const merged = this.merge(repoRoot, branch, target, stream);
    if (!merged.ok) {
      const line =
        merged.conflicts.length > 0
          ? `land ${branch} into ${target} conflicted in: ${merged.conflicts.join(', ')}`
          : `land ${branch} into ${target} failed: ${merged.reason}`;
      await streams.update('daemon', stream.id, {
        agent: { status: 'blocked' },
        delivery_state: {
          mode,
          status: merged.conflicts.length > 0 ? 'conflict' : 'held',
          held_by: [{ reason: 'conflict', detail: line }],
          at: new Date().toISOString(),
        },
        ...(merged.conflicts.length > 0
          ? {
              land_conflict: {
                target,
                files: merged.conflicts.slice(0, 200),
                at: new Date().toISOString(),
              },
            }
          : {}),
      });
      await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      return { status: 'blocked', target, conflicts: merged.conflicts, line };
    }

    // 4. Close the stream, remove its worktree, keep its branch.
    const line = `landed ${branch} into ${target} (${merged.sha.slice(0, 12)})`;
    await streams.update('daemon', stream.id, {
      human: { status: 'landed' },
      delivery_state: {
        mode,
        status: 'merged',
        merged_sha: merged.sha,
        at: new Date().toISOString(),
      },
      ...(stream.land_conflict ? { land_conflict: null } : {}),
    });
    await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
    if (stream.worktree !== undefined) {
      const removal = removeWorktreeSafely(repoRoot, stream.worktree);
      if (!removal.removed) {
        await streams.appendThread('daemon', stream.id, {
          kind: 'event',
          body: `worktree ${stream.worktree} kept: ${removal.reason}`,
        });
      }
    }
    // §5.5's retro, after the worktree is gone.
    void Promise.resolve(this.options.onStreamEnd?.(stream.id)).catch(() => {});
    return { status: 'landed', target, sha: merged.sha, line };
  }

  /**
   * The Land button's "before" half (§9.3): every refusal `land` would
   * raise before the diff rules, checked without writing. The diff rules
   * are not run: they may call the classifier and raise a gate, which is a
   * decision, not a preview.
   */
  preflight(streamId: string): LandPreflight {
    const stream = this.options.streams.get(streamId);
    try {
      const { repoEntry, branch } = this.requireLandable(stream);
      const repoRoot = repoEntry.path;
      const target = this.resolveTarget(stream, repoEntry, repoRoot);
      const conflict = stream.land_conflict;
      if (conflict !== undefined) {
        return {
          ready: false,
          branch,
          target: conflict.target,
          conflicts: conflict.files,
          reason: `the last land into ${conflict.target} conflicted in ${conflict.files.join(', ')}; Resolve, or fix the branch by hand, then land again`,
        };
      }
      if (!branchExists(repoRoot, target)) {
        return {
          ready: false,
          branch,
          target,
          reason: `target branch ${target} does not exist in ${repoRoot}`,
        };
      }
      const ahead = Number(
        runGit(['rev-list', '--count', `${target}..${branch}`], repoRoot, repoRoot),
      );
      if (!(ahead > 0)) {
        if (mergedOutside(repoRoot, branch, target)) {
          return {
            ready: false,
            branch,
            target,
            ahead: 0,
            merged: true,
            reason: `${branch} is already merged into ${target}`,
          };
        }
        return {
          ready: false,
          branch,
          target,
          ahead: 0,
          reason: `${branch} has no commits beyond ${target} — nothing to land`,
        };
      }
      const dirty = dirtyCheckoutReason(target, worktreesOn(repoRoot, target));
      if (dirty !== undefined) return { ready: false, branch, target, ahead, reason: dirty };
      return {
        ready: true,
        branch,
        target,
        ahead,
        ...(repoEntry.land_gate === true ? { gated: true } : {}),
      };
    } catch (err) {
      return { ready: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A stream merged outside `land` (by hand, by a PR) is marked landed by
   * the human. Refused unless the branch has its own work, all in the target.
   */
  async markLanded(streamId: string): Promise<Stream> {
    const { streams } = this.options;
    const stream = streams.get(streamId);
    const { repoEntry, branch } = this.requireLandable(stream);
    const repoRoot = repoEntry.path;
    const target = this.resolveTarget(stream, repoEntry, repoRoot);
    if (!mergedOutside(repoRoot, branch, target)) {
      throw new LandRefusedError(stream.id, `${branch} is not merged into ${target}`);
    }
    await this.setDeliveryState(stream.id, {
      mode: stream.delivery_state?.mode ?? this.resolveMode(stream, repoEntry),
      status: 'merged',
      merged_sha: runGit(['rev-parse', `refs/heads/${branch}`], repoRoot, repoRoot),
    });
    const updated = await streams.update('human', stream.id, { human: { status: 'landed' } });
    await streams.appendThread('human', stream.id, {
      kind: 'event',
      body: `marked landed: ${branch} was already merged into ${target}`,
    });
    void Promise.resolve(this.options.onStreamEnd?.(stream.id)).catch(() => {});
    return updated;
  }

  /**
   * The stream page's diff tab: committed and uncommitted work against the
   * target (`git diff <merge-base>` in the worktree), or the branch alone
   * once the worktree is gone. Capped; `truncated` says so.
   */
  diff(streamId: string): StreamDiff {
    const stream = this.options.streams.get(streamId);
    if (stream.repo === undefined || stream.branch === undefined) {
      throw new LandRefusedError(stream.id, 'this stream has no repo branch yet — nothing to diff');
    }
    const repoEntry = this.registeredRepo(stream, stream.repo);
    const repoRoot = repoEntry.path;
    const target = this.resolveTarget(stream, repoEntry, repoRoot);
    const inWorktree = stream.worktree !== undefined && existsSync(stream.worktree);
    const cwd = inWorktree ? (stream.worktree as string) : repoRoot;
    const head = inWorktree ? 'HEAD' : stream.branch;
    const base = git(['merge-base', target, head], cwd, repoRoot);
    if (base.exitCode !== 0) {
      throw new LandRefusedError(stream.id, `no merge base between ${target} and ${stream.branch}`);
    }
    const range = inWorktree ? [base.stdout] : [base.stdout, stream.branch];
    const stat = git(['diff', '--stat', ...range], cwd, repoRoot);
    const patch = git(['diff', ...range], cwd, repoRoot);
    if (patch.exitCode !== 0) {
      throw new LandRefusedError(stream.id, `git diff failed: ${patch.stderr || 'unknown error'}`);
    }
    const truncated = patch.stdout.length > STREAM_DIFF_MAX_CHARS;
    return {
      stream: stream.id,
      branch: stream.branch,
      target,
      ...(inWorktree ? { worktree: stream.worktree } : {}),
      stat: stat.exitCode === 0 ? stat.stdout : '',
      patch: truncated ? patch.stdout.slice(0, STREAM_DIFF_MAX_CHARS) : patch.stdout,
      truncated,
    };
  }

  /**
   * T176: the Resolve worker's instruction, appended to its brief. Refused
   * unless the stream's last land conflicted (`land_conflict`).
   */
  resolvePrompt(streamId: string): string {
    const stream = this.options.streams.get(streamId);
    const conflict = stream.land_conflict;
    if (conflict === undefined || stream.branch === undefined) {
      throw new LandRefusedError(stream.id, `stream ${stream.id} has no land conflict to resolve`);
    }
    return [
      '## Resolve the land conflict',
      `Landing ${stream.branch} into ${conflict.target} conflicted in: ${conflict.files.join(', ')}.`,
      `Merge ${conflict.target} into this stream's branch (\`git merge ${conflict.target}\`) in this worktree.`,
      "Resolve each listed file keeping both sides' intent: the target's changes and this stream's goal.",
      'Run the tests, then commit the merge.',
      'When done, say the stream is ready to land again; the operator lands it.',
    ].join('\n');
  }

  /** PR mode needs a port and a pushable branch; refused before anything is written. */
  private requireGitHub(stream: Stream, repoEntry: RepoEntry, branch: string): GitHubPort {
    const factory = this.options.github;
    if (factory === undefined || repoEntry.github === undefined) {
      throw new LandRefusedError(
        stream.id,
        `stream ${stream.id} delivers by pull request but repo ${String(stream.repo)} has no GitHub repository configured`,
      );
    }
    // Protected-branch push rules are unchanged: never push onto one.
    if ((repoEntry.protected_branches ?? []).includes(branch)) {
      throw new LandRefusedError(stream.id, `${branch} is a protected branch; it is never pushed`);
    }
    return factory(repoEntry);
  }

  /**
   * T224: `git push <remote> <branch>`, then the node's one PR: opened on
   * the first deliver, updated (never duplicated) after. A push failure
   * holds the node with nothing opened.
   */
  private async deliverPr(
    stream: Stream,
    repoEntry: RepoEntry,
    github: GitHubPort,
    branch: string,
    target: string,
  ): Promise<LandOutcome> {
    const { streams } = this.options;
    const repoRoot = repoEntry.path;
    const remote = repoEntry.remote ?? 'origin';
    const cwd =
      stream.worktree !== undefined && existsSync(stream.worktree) ? stream.worktree : repoRoot;
    const pushed = git(
      ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`],
      cwd,
      repoRoot,
    );
    if (pushed.exitCode !== 0) {
      const line = `push ${branch} to ${remote} failed: ${scrubGitError(pushed.stderr)}`;
      await this.setDeliveryState(stream.id, {
        mode: 'pr',
        status: 'held',
        held_by: [{ reason: 'ship_check', detail: line }],
        ...(stream.delivery_state?.pr ? { pr: stream.delivery_state.pr } : {}),
      });
      await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      return { status: 'refused', reason: line, line };
    }

    const title = stream.title;
    const body = prBody(stream);
    const known = stream.delivery_state?.pr;
    let pull: GitHubPull;
    let verb: string;
    if (known !== undefined && known.state === 'open') {
      pull = await github.updatePull(known.number, { title, body });
      verb = 'updated';
    } else {
      const [existing] = await github.listPulls({ state: 'open', head: branch });
      if (existing !== undefined) {
        pull = await github.updatePull(existing.number, { title, body });
        verb = 'updated';
      } else {
        pull = await github.createPull({ title, head: branch, base: target, body });
        verb = 'opened';
      }
    }
    const now = new Date().toISOString();
    await this.setDeliveryState(stream.id, {
      mode: 'pr',
      status: 'pr_open',
      pr: {
        number: pull.number,
        url: pull.html_url,
        head: branch,
        base: pull.base.ref || target,
        state: 'open',
        draft: pull.draft,
        review: known?.review ?? 'none',
        checks: known?.checks ?? 'none',
        mergeable: known?.mergeable ?? 'unknown',
        auto_merge: pull.auto_merge ? 'enabled' : 'off',
        last_seen: known?.last_seen ?? {},
        polled_at: now,
      },
    });
    const line = `pushed ${branch} to ${remote}; ${verb} PR #${pull.number} into ${target}: ${pull.html_url}`;
    await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
    return { status: 'pr_open', target, pr: { number: pull.number, url: pull.html_url }, line };
  }

  /** Everything that must hold before landing touches git: a repo, a live human status, no live worker. */
  private requireLandable(stream: Stream): { repoEntry: RepoEntry; branch: string } {
    if (stream.repo === undefined || stream.branch === undefined) {
      throw new LandRefusedError(
        stream.id,
        `stream ${stream.id} has no ${stream.repo === undefined ? 'repo' : 'branch'} — there is nothing to land`,
      );
    }
    const repoEntry = this.registeredRepo(stream, stream.repo);
    if (!(LANDABLE_HUMAN_STATUSES as readonly string[]).includes(stream.human.status)) {
      throw new LandRefusedError(
        stream.id,
        `stream ${stream.id} is ${stream.human.status}; only ${LANDABLE_HUMAN_STATUSES.join(' or ')} streams land`,
      );
    }
    const live = liveSession(stream);
    if (live !== undefined) {
      throw new LandRefusedError(
        stream.id,
        `stream ${stream.id} has a live session (${live.id}); detach it before landing`,
      );
    }
    return { repoEntry, branch: stream.branch };
  }

  /** §14.7: node override, else project, else repo entry, else direct. */
  private resolveMode(stream: Stream, repoEntry: RepoEntry): DeliveryState['mode'] {
    let project: Parameters<typeof resolveDelivery>[1];
    if (stream.project !== undefined) {
      try {
        project = this.options.store.getProject(stream.project);
      } catch {
        project = undefined;
      }
    }
    return resolveDelivery(repoEntry, project, stream).mode;
  }

  /** Writes `delivery_state` (daemon-only, §14.2). */
  private async setDeliveryState(
    streamId: string,
    state: Omit<DeliveryState, 'at'>,
  ): Promise<void> {
    await this.options.streams.update('daemon', streamId, {
      delivery_state: { ...state, at: new Date().toISOString() },
    });
  }

  /** The stream's repo entry; an unregistered repo refuses. */
  private registeredRepo(stream: Stream, repo: string): RepoEntry {
    const entry = this.options.store.getRepos()[repo];
    if (entry === undefined) {
      throw new LandRefusedError(stream.id, `stream repo ${repo} is not registered in repos.yaml`);
    }
    return entry;
  }

  /** D20: every work node delivers to the repo's main branch. */
  private resolveTarget(_stream: Stream, repoEntry: RepoEntry, repoRoot: string): string {
    return mainBranch(repoEntry, repoRoot);
  }

  /** Raises the `land` gate: the outcome when this call can't proceed, `undefined` when a delegate approved inline. */
  private async raiseGate(
    stream: Stream,
    branch: string,
    target: string,
  ): Promise<LandOutcome | undefined> {
    const gates = this.options.gates;
    if (gates === undefined) {
      throw new LandRefusedError(
        stream.id,
        `repo ${String(stream.repo)} asks for a land gate but no gate service is configured`,
      );
    }
    const gate = await gates.request('land', {
      policy: this.options.store.getPolicy(),
      stream: stream.id,
      summary: `land ${branch} into ${target}`,
    });
    if (gate.status === 'resolved' && gate.decision === 'approve') return undefined;
    if (gate.status === 'resolved') {
      const line = `landing denied at the land gate by ${gate.decided_by ?? gate.owner}`;
      await this.options.streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      return { status: 'refused', reason: line, line };
    }
    const line = `gate raised: ${gate.id}`;
    await this.options.streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: `land gate raised (${gate.id}) for ${branch} into ${target}`,
    });
    return { status: 'gated', gate, line };
  }

  /**
   * `merge --no-ff` in a throwaway worktree **detached** at the target (git
   * refuses to check out a branch already checked out elsewhere, usually
   * the operator's). The ref is then advanced with `update-ref`'s
   * expected-old-value form, so a target that moved loses the race instead
   * of being overwritten (D11).
   *
   * Checkouts already on the target are brought along (else they show the
   * merge as a pending deletion): a dirty one refuses the land up front, a
   * clean one is `reset --hard`. Since that would also overwrite an
   * untracked file the merge introduces, those paths are intersected with
   * each checkout's untracked files before the ref moves, and a collision
   * refuses with the paths named.
   */
  private merge(
    repoRoot: string,
    branch: string,
    target: string,
    stream: Stream,
  ): { ok: true; sha: string } | { ok: false; conflicts: string[]; reason: string } {
    const checkouts = worktreesOn(repoRoot, target);
    const dirty = dirtyCheckoutReason(target, checkouts);
    if (dirty !== undefined) throw new LandRefusedError(stream.id, dirty);
    const before = runGit(['rev-parse', `refs/heads/${target}`], repoRoot, repoRoot);
    // Inside the try so the `finally` owns the temp dir from creation on.
    let temp: string | undefined;
    try {
      temp = mkdtempSync(join(tmpdir(), 'agile-land-'));
      const worktree = join(temp, 'target');
      const added = git(['worktree', 'add', '--detach', worktree, target], repoRoot, repoRoot);
      if (added.exitCode !== 0) {
        return { ok: false, conflicts: [], reason: added.stderr };
      }
      const merge = gitWrite(
        ['merge', '--no-ff', '-m', `land ${branch} into ${target} (${stream.id})`, branch],
        worktree,
        repoRoot,
      );
      if (merge.exitCode !== 0) {
        const conflicts = git(['diff', '--name-only', '--diff-filter=U'], worktree, repoRoot)
          .stdout.split('\n')
          .filter((line) => line.length > 0);
        gitWrite(['merge', '--abort'], worktree, repoRoot);
        return { ok: false, conflicts, reason: merge.stderr || merge.stdout };
      }
      const sha = runGit(['rev-parse', 'HEAD'], worktree, repoRoot);

      // Would bringing a checkout along overwrite an untracked file? Refuse
      // before the ref moves; the unreferenced merge commit gets collected.
      const touched = new Set(
        runGit(['diff', '--name-only', before, sha], repoRoot, repoRoot)
          .split('\n')
          .filter((line) => line.length > 0),
      );
      for (const checkout of checkouts) {
        if (checkout.dirty.length > 0) continue;
        const collisions = untrackedFiles(repoRoot, checkout.path).filter((file) =>
          touched.has(file),
        );
        if (collisions.length > 0) {
          throw new LandRefusedError(
            stream.id,
            `landing ${branch} into ${target} would overwrite untracked ${collisions.join(', ')} in ${checkout.path}; move or commit them before landing`,
          );
        }
      }

      const updated = git(['update-ref', `refs/heads/${target}`, sha, before], repoRoot, repoRoot);
      if (updated.exitCode !== 0) {
        return {
          ok: false,
          conflicts: [],
          reason: `could not advance ${target}: ${updated.stderr}`,
        };
      }
      // Fast-forward the clean checkouts on the target. `dirty` is the
      // reading from before the ref moved (after, every one looks dirty).
      for (const checkout of checkouts) {
        if (checkout.dirty.length > 0) continue;
        gitWrite(['reset', '--hard', sha], checkout.path, repoRoot);
      }
      return { ok: true, sha };
    } finally {
      if (temp !== undefined) {
        removeWorktreeSafely(repoRoot, join(temp, 'target'));
        git(['worktree', 'prune'], repoRoot, repoRoot);
        rmSync(temp, { recursive: true, force: true });
      }
    }
  }
}

/**
 * D20: the branch a repo's work nodes deliver to. T202 carries the old
 * `target_branch` over as `main_branch`; either field is read, so this works
 * before and after that migration.
 */
export function mainBranch(entry: RepoEntry, repoRoot: string): string {
  return entry.main_branch ?? entry.target_branch ?? defaultBranch(repoRoot);
}

/** The repo's default branch: `origin/HEAD`, else whichever of `main`/`master` exists, else `main`. */
export function defaultBranch(repoRoot: string): string {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot, repoRoot);
  if (head.exitCode === 0 && head.stdout.startsWith('origin/')) {
    return head.stdout.slice('origin/'.length);
  }
  for (const candidate of ['main', 'master']) {
    if (branchExists(repoRoot, candidate)) return candidate;
  }
  return 'main';
}

/** A worktree with the target checked out, and its uncommitted tracked paths. */
interface Checkout {
  path: string;
  dirty: string[];
}

/** Every worktree with `branch` checked out. */
function worktreesOn(repoRoot: string, branch: string): Checkout[] {
  const listed = git(['worktree', 'list', '--porcelain'], repoRoot, repoRoot);
  if (listed.exitCode !== 0) return [];
  const found: Checkout[] = [];
  let path: string | undefined;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && path !== undefined) {
      found.push({ path, dirty: uncommittedPaths(repoRoot, path) });
    }
  }
  return found;
}

/** A worktree's untracked, non-ignored files, repo-relative. */
function untrackedFiles(repoRoot: string, worktreePath: string): string[] {
  const listed = git(['ls-files', '--others', '--exclude-standard'], worktreePath, repoRoot);
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split('\n').filter((line) => line.length > 0);
}

/** Uncommitted tracked paths only (untracked scratch never blocks a land); fails closed. */
function uncommittedPaths(repoRoot: string, worktreePath: string): string[] {
  const status = git(['status', '--porcelain=v1'], worktreePath, repoRoot);
  if (status.exitCode !== 0) return ['(git status failed)'];
  return status.stdout
    .split('\n')
    .filter((entry) => entry.length > 0 && !entry.startsWith('??'))
    .map((entry) => entry.replace(/^.{1,2} /, '')); // XY code; the first may be trimmed
}

/**
 * Approving a `land` gate performs the merge (the gate is raised before
 * it). Wraps `GateService.respond` so the gate service needn't know what
 * any gate kind does; wired by `daemon.ts`.
 */
export function wireLandGateResolution(gates: GateService, landing: DeliveryService): void {
  const respond = gates.respond.bind(gates);
  gates.respond = async (id, decision, by, note) => {
    const resolved = await respond(id, decision, by, note);
    if (resolved.gate === 'land' && resolved.decision === 'approve') {
      await landing.land(resolved.stream, { gateApproved: true });
    }
    // A diff-tier `classifier_review` gate is the other one landing waits
    // on, recognised by `call.origin === 'diff_rules'` (set only by
    // `ClassifierDiffRules`, never from vendor data), not by `call.tool`: a
    // vendor tool named `land` must not turn an edit approval into a merge.
    // The land re-runs the check, which spends the approval.
    if (
      resolved.gate === 'classifier_review' &&
      resolved.decision === 'approve' &&
      resolved.call?.origin === 'diff_rules'
    ) {
      await landing.land(resolved.stream);
    }
    return resolved;
  };
}

/**
 * `branch` has commits of its own, all in `target`: the tip is an ancestor
 * of the target and either sits off its first-parent line (merge commit)
 * or the branch's reflog records commits after creation (fast-forward).
 */
export function mergedOutside(repoRoot: string, branch: string, target: string): boolean {
  if (git(['merge-base', '--is-ancestor', branch, target], repoRoot, repoRoot).exitCode !== 0) {
    return false;
  }
  const tip = git(['rev-parse', `refs/heads/${branch}`], repoRoot, repoRoot).stdout;
  const firstParent = git(['rev-list', '--first-parent', target], repoRoot, repoRoot);
  if (firstParent.exitCode === 0 && !firstParent.stdout.split('\n').includes(tip)) return true;
  const reflog = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoRoot, repoRoot);
  return reflog.exitCode === 0 && reflog.stdout.split('\n').filter(Boolean).length > 1;
}

/** The PR body: the node's goal and progress. The roll-up issue line is T322's; left empty. */
function prBody(stream: Stream): string {
  const parts = [`## Goal\n\n${stream.goal}`];
  if (stream.agent.progress) parts.push(`## Progress\n\n${stream.agent.progress}`);
  parts.push('Issues:');
  return parts.join('\n\n');
}

/** A git error for a thread line: first line, capped, any `user:pass@` in a URL removed. */
function scrubGitError(stderr: string): string {
  const first = stderr.split('\n').find((l) => l.trim().length > 0) ?? 'unknown error';
  return first.replace(/(\w+:\/\/)[^/@\s]*@/g, '$1').slice(0, 300);
}

function branchExists(repoRoot: string, branch: string): boolean {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot, repoRoot).exitCode === 0;
}

/** Why a dirty checkout of the target refuses the land, or `undefined`. */
function dirtyCheckoutReason(target: string, checkouts: Checkout[]): string | undefined {
  const dirty = checkouts.find((checkout) => checkout.dirty.length > 0);
  if (dirty === undefined) return undefined;
  const more = dirty.dirty.length > 5 ? ` and ${dirty.dirty.length - 5} more` : '';
  const paths = `${dirty.dirty.slice(0, 5).join(', ')}${more}`;
  return `${target} is checked out with uncommitted changes at ${dirty.path} (${paths}); commit or stash them before landing`;
}
