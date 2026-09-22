/**
 * `LandingService` — `agile land <stream>` / the Land button (design/
 * cockpit-design.md §8.2 "Landing path, per stream"):
 *
 * ```
 * ├─ `land` gate if the repo policy asks for one   (default: no gate — the button IS the decision)
 * ├─ DIFF-LEVEL rules                              (T152 plugs in; a no-op default until then)
 * ├─ merge --no-ff into target_branch
 * ├─ human.status: landed; worktree removed; branch kept
 * ```
 *
 * Three rules this module exists to keep honest:
 *
 *  1. **No partial merge.** The merge runs in a *temporary* worktree of the
 *     target — never the stream's worktree, never the operator's checkout —
 *     and a conflict aborts it, removes the temp worktree, leaves the target
 *     branch exactly where it was and parks the stream (`agent.status:
 *     blocked`) with the conflicting files on the thread. The stream's own
 *     worktree is kept, because that is where the conflict gets resolved.
 *  2. **D8 (protected branches) is satisfied, not bypassed.** Landing on
 *     `main` is allowed *only* through this path: it is the human pressing
 *     Land (or the `land` gate they answered). No agent-principal caller
 *     reaches it — the RPC edge is the human edge, and the MCP verbs have
 *     no `land`.
 *  3. **Every write is the `daemon` principal.** Landing sets both halves
 *     of the record (`human.status: landed`, or `agent.status: blocked` on
 *     a conflict), which is exactly what §2.2 reserves the daemon principal
 *     for.
 *
 * Target resolution, in order (§8.2): the parent stream's branch when the
 * parent has a repo and a branch ("a child stream with a repo-bearing
 * parent merges into the PARENT's branch instead"), else the stream's own
 * `target_branch`, else the repo entry's `target_branch`, else the repo's
 * default branch.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HilRequest, RepoEntry, Stream } from '@agile-agents/shared';
import { liveSession } from '../attach/service';
import type { GateService } from '../gates/service';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';
import { git, gitWrite, removeWorktreeSafely, runGit } from './git';

/**
 * Landing refused before anything was touched — bad caller input or a
 * stream that is not in a landable shape. Typed so the RPC edge reports it
 * as `invalid params` (-32602) rather than an internal fault, the same
 * contract `streams/rpc.ts` and `attach/rpc.ts` follow.
 */
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

/**
 * A diff-level verdict. `route` is §8.2's "inbox item, landing waits" — for
 * the caller of `land` both it and `deny` mean the same thing here: the
 * merge does not happen on this call.
 */
export type DiffRuleVerdict =
  | { decision: 'allow' }
  | {
      decision: 'deny' | 'route';
      reason: string;
      rule?: string;
      /**
       * T152: the `classifier_review` gate a `route` raised. Its presence
       * is what makes §8.2's "landing waits" a *wait* rather than a
       * refusal — `land` returns `gated`, and answering the gate comes
       * back here through `wireLandGateResolution`.
       */
      gate?: HilRequest;
    };

/**
 * The diff-level rule tier (§8.2), implemented over the classifier by
 * `ClassifierDiffRules` (`landing/diff-rules.ts`). `ALLOW_ALL_DIFF_RULES`
 * stays the default for a daemon with no classifier wired and for the
 * tests that are not about this tier.
 */
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
  | { status: 'landed'; target: string; sha: string; line: string };

export interface LandOptions {
  /** Set by the gate-resolution callback: the `land` gate was approved, don't raise another. */
  gateApproved?: boolean;
}

export interface LandingServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** Only needed for repos with `land_gate: true`; without it such a repo refuses to land. */
  gates?: GateService;
  /** T152's diff-level rule tier. Defaults to `ALLOW_ALL_DIFF_RULES`. */
  diffRules?: DiffRules;
  /**
   * T141 (§5.5): what a successful land tells the retro. Fire-and-forget —
   * the merge has already happened, so a lessons session that cannot start
   * is a thread line, never a failed land.
   */
  onStreamEnd?: (streamId: string) => void | Promise<void>;
}

export class LandingService {
  private readonly diffRules: DiffRules;

  constructor(private readonly options: LandingServiceOptions) {
    this.diffRules = options.diffRules ?? ALLOW_ALL_DIFF_RULES;
  }

  async land(streamId: string, options: LandOptions = {}): Promise<LandOutcome> {
    const { streams, store } = this.options;
    const stream = streams.get(streamId);
    const { repoEntry, branch } = this.requireLandable(stream);
    const repoRoot = repoEntry.path;
    const target = this.resolveTarget(stream, repoEntry, repoRoot);

    if (git(['rev-parse', '--verify', `refs/heads/${target}`], repoRoot, repoRoot).exitCode !== 0) {
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

    // 1. The gate, when the repo asks for one (§8.2: default is no gate).
    if (repoEntry.land_gate === true && options.gateApproved !== true) {
      const gated = await this.raiseGate(stream, branch, target);
      if (gated !== undefined) return gated;
    }

    // 2. Diff-level rules (§8.2; `ClassifierDiffRules` when one is wired).
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
      await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      // A route has a gate to wait on; a deny (and a route with nowhere to
      // put the card) ends the call.
      if (verdict.gate !== undefined) return { status: 'gated', gate: verdict.gate, line };
      return { status: 'refused', reason: verdict.reason, line };
    }

    // 3. The merge, in a temporary worktree of the target.
    const merged = this.merge(repoRoot, branch, target, stream);
    if (!merged.ok) {
      const line =
        merged.conflicts.length > 0
          ? `land ${branch} into ${target} conflicted in: ${merged.conflicts.join(', ')}`
          : `land ${branch} into ${target} failed: ${merged.reason}`;
      await streams.update('daemon', stream.id, { agent: { status: 'blocked' } });
      await streams.appendThread('daemon', stream.id, { kind: 'event', body: line });
      return { status: 'blocked', target, conflicts: merged.conflicts, line };
    }

    // 4. Close the stream, remove its worktree, keep its branch.
    const line = `landed ${branch} into ${target} (${merged.sha.slice(0, 12)})`;
    await streams.update('daemon', stream.id, { human: { status: 'landed' } });
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
    void store; // the stream writes above already emit the store's events.
    // §5.5's retro, after the worktree is gone: the lessons session runs in
    // its own session dir when the stream's worktree has been removed.
    void Promise.resolve(this.options.onStreamEnd?.(stream.id)).catch(() => {
      // `onStreamEnd` is contractually non-throwing; this is belt and braces.
    });
    return { status: 'landed', target, sha: merged.sha, line };
  }

  /**
   * Everything that must be true before landing touches git. Refusals are
   * `LandRefusedError` (-32602 at the edge): a stream with no repo, one the
   * human already landed or closed, or one with a worker still running.
   */
  private requireLandable(stream: Stream): { repoEntry: RepoEntry; branch: string } {
    if (stream.repo === undefined || stream.branch === undefined) {
      throw new LandRefusedError(
        stream.id,
        `stream ${stream.id} has no ${stream.repo === undefined ? 'repo' : 'branch'} — there is nothing to land`,
      );
    }
    const repoEntry = this.options.store.getRepos()[stream.repo];
    if (repoEntry === undefined) {
      throw new LandRefusedError(
        stream.id,
        `stream repo ${stream.repo} is not registered in repos.yaml`,
      );
    }
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

  /** §8.2's target order; see the module header. */
  private resolveTarget(stream: Stream, repoEntry: RepoEntry, repoRoot: string): string {
    const parentBranch = this.parentBranch(stream);
    return (
      parentBranch ?? stream.target_branch ?? repoEntry.target_branch ?? defaultBranch(repoRoot)
    );
  }

  /** The parent's branch, only when the parent is in a repo and has one. */
  private parentBranch(stream: Stream): string | undefined {
    if (stream.parent === undefined) return undefined;
    let parent: Stream;
    try {
      parent = this.options.streams.get(stream.parent);
    } catch {
      return undefined; // a parent that is gone re-roots the child (§2, `tree`).
    }
    if (parent.repo === undefined || parent.branch === undefined) return undefined;
    return parent.branch;
  }

  /**
   * Raises the `land` gate. Returns the outcome to hand back when the gate
   * did not (or will not) let this call proceed, and `undefined` when a
   * delegate approved it inline so landing continues in the same call.
   */
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
   * `merge --no-ff` in a throwaway worktree of the target.
   *
   * The temp worktree is **detached** at the target rather than checking the
   * branch out: git refuses to check out a branch that is already checked
   * out somewhere else, and the target is usually exactly the branch the
   * operator has open. The branch pointer is advanced afterwards with
   * `update-ref` in its expected-old-value form, so a target that moved
   * under us loses the race instead of being overwritten — the same atomic
   * claim `runner/worktrees.ts` uses for a stream branch (D11).
   *
   * A worktree that already has the target checked out (usually the
   * operator's own) is brought along afterwards: moving the ref under it
   * would otherwise leave it showing the merge as a pending *deletion*. It
   * is fast-forwarded only while it is clean, and a dirty one refuses the
   * land outright — checked before the merge, so nothing has happened yet
   * when it refuses. Review round 1 (blocker): "clean" is not enough on its
   * own, because `reset --hard` also overwrites an *untracked* file whose
   * path the merge introduces. The paths the merge touches are therefore
   * intersected with each checkout's untracked files before the ref moves,
   * and a collision refuses the land with those paths named — nothing has
   * been published at that point, so the refusal costs the operator only
   * the merge we throw away.
   */
  private merge(
    repoRoot: string,
    branch: string,
    target: string,
    stream: Stream,
  ): { ok: true; sha: string } | { ok: false; conflicts: string[]; reason: string } {
    const checkouts = worktreesOn(repoRoot, target);
    const dirty = checkouts.find((checkout) => checkout.dirty);
    if (dirty !== undefined) {
      throw new LandRefusedError(
        stream.id,
        `${target} is checked out with uncommitted changes at ${dirty.path}; commit or stash them before landing`,
      );
    }
    const before = runGit(['rev-parse', `refs/heads/${target}`], repoRoot, repoRoot);
    // Created inside the try so a throw (or a refused `worktree add`) can
    // never leak the temp directory — the `finally` owns it from here on.
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

      // Before the ref moves: would bringing a checkout along overwrite an
      // untracked file there? If so, refuse — the merge commit is still
      // unreferenced and gets garbage collected.
      const touched = new Set(
        runGit(['diff', '--name-only', before, sha], repoRoot, repoRoot)
          .split('\n')
          .filter((line) => line.length > 0),
      );
      for (const checkout of checkouts) {
        if (checkout.dirty) continue;
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
      // Fast-forward the (clean) checkouts that were already on the target,
      // so `git status` there does not report the merge as a deletion.
      // `checkout.dirty` is the reading from *before* the ref moved: once
      // it has, every such worktree reports the merge as a pending change,
      // so re-reading here would skip exactly the ones that need it.
      for (const checkout of checkouts) {
        if (checkout.dirty) continue;
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
 * The repo's default branch: `origin/HEAD` when the repo has one, else
 * whichever of `main`/`master` exists. Nothing else is guessed — a repo
 * with neither and no configured `target_branch` refuses the land with the
 * branch it tried to find.
 */
export function defaultBranch(repoRoot: string): string {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot, repoRoot);
  if (head.exitCode === 0 && head.stdout.startsWith('origin/')) {
    return head.stdout.slice('origin/'.length);
  }
  for (const candidate of ['main', 'master']) {
    if (
      git(['rev-parse', '--verify', `refs/heads/${candidate}`], repoRoot, repoRoot).exitCode === 0
    ) {
      return candidate;
    }
  }
  return 'main';
}

/** Every worktree of `repoRoot` that has `branch` checked out, and whether it has uncommitted tracked changes. */
function worktreesOn(repoRoot: string, branch: string): { path: string; dirty: boolean }[] {
  const listed = git(['worktree', 'list', '--porcelain'], repoRoot, repoRoot);
  if (listed.exitCode !== 0) return [];
  const found: { path: string; dirty: boolean }[] = [];
  let path: string | undefined;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && path !== undefined) {
      found.push({ path, dirty: worktreeIsDirty(repoRoot, path) });
    }
  }
  return found;
}

/** A worktree's untracked, non-ignored files, repo-relative (the same paths `git diff --name-only` prints). */
function untrackedFiles(repoRoot: string, worktreePath: string): string[] {
  const listed = git(['ls-files', '--others', '--exclude-standard'], worktreePath, repoRoot);
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split('\n').filter((line) => line.length > 0);
}

/** Uncommitted *tracked* changes only — untracked scratch files never block a land. */
function worktreeIsDirty(repoRoot: string, worktreePath: string): boolean {
  const status = git(['status', '--porcelain=v1'], worktreePath, repoRoot);
  if (status.exitCode !== 0) return true; // cannot tell ⇒ treat as dirty (fail closed)
  return status.stdout.split('\n').some((entry) => entry.length > 0 && !entry.startsWith('??'));
}

/**
 * Wires a resolved `land` gate back into landing: approving the gate is
 * what performs the merge (§8.2 — the gate is raised *before* the merge, so
 * the decision has to come back to this path).
 *
 * It wraps `GateService.respond` rather than living inside `GateService`
 * because the gate service has no business knowing what any one gate kind
 * does; the wiring is the daemon's (`daemon.ts`), exactly like the RPC
 * tables it assembles.
 */
export function wireLandGateResolution(gates: GateService, landing: LandingService): void {
  const respond = gates.respond.bind(gates);
  gates.respond = async (id, decision, by, note) => {
    const resolved = await respond(id, decision, by, note);
    if (resolved.gate === 'land' && resolved.decision === 'approve') {
      await landing.land(resolved.stream, { gateApproved: true });
    }
    // T152: a `classifier_review` gate raised by the diff tier is the other
    // gate landing waits on. It is told apart from the route band's
    // per-tool-call gates by `call.origin === 'diff_rules'`, a marker only
    // `ClassifierDiffRules` sets. It is deliberately NOT a sentinel on
    // `call.tool`: that field is the vendor's reported `tool_name`, an
    // unconstrained string, so a vendor or MCP tool that happened to be
    // called `land` would have turned an approval for one edit into a merge
    // into a protected branch. `origin` is never sourced from vendor data,
    // so answering a routed *tool* call cannot reach this path however the
    // tool is named (`service.test.ts` asserts exactly that). The land
    // re-runs the whole check, which is how the approval gets spent
    // (`ClassifierDiffRules.answeredGate`).
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
