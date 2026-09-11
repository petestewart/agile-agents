/**
 * `MergeOwner` — the merge and integration owner (T019 — design/
 * agile-agents-design.md §15 "Git model and teams": "Merge cadence: ticket
 * -> integration on done (integration owner rebases; conflicts bounce to
 * the ticket owner as a scoped halt). integration -> main at sprint review,
 * behind the sprint_review gate."; §4 "Halts"; §5 "Comms bus"; §16 "HIL
 * gates policy").
 *
 * Two entry points:
 *  - `onTicketDone(ticketId)` — called once a ticket reaches `done` (QA
 *    accept; `stale` is also accepted — see `ONTICKETDONE_ALLOWED_STATUSES`).
 *    Rebases the ticket's worktree onto `integration`, runs the repo's
 *    tests, and on success merges the ticket branch into `integration`
 *    **in a daemon-owned `.worktrees/_integration` worktree** — never the
 *    ticket's own worktree, and never the user's own checkout of `repoRoot`
 *    (review round 1 blocker 1: an earlier version ran `git checkout
 *    integration` directly in `repoRoot`, which is whatever branch/WIP a
 *    human happens to have checked out there — see `ensureNamedWorktree`).
 *    A rebase conflict or a test failure instead raises a halt scoped to
 *    just this ticket (`createHalt({scope:[ticket]})`) with a summary
 *    naming the offending file(s) and, where discoverable, the other
 *    ticket(s) whose commits already on `integration` touched the same
 *    file — the worktree is left exactly as it was (rebase aborted) so the
 *    engineer's fix cycle reuses the same directory (§15: "Fix cycles and
 *    escalations reuse the same worktree").
 *  - `mergeIntegrationToMain()` — `integration -> main`, gated on the
 *    `sprint_review` HIL request being `resolved`/`approve` (§16), merged in
 *    a second daemon-owned worktree, `.worktrees/_main` — same reasoning.
 *
 * Every mutation this class makes (both entry points, plus the ticket
 * worktree removal at the end of a clean `onTicketDone`) is serialized
 * through one mutex — the `_integration`/`_main` worktrees and `integration`
 * itself are shared mutable state, so two merges running concurrently would
 * otherwise race on them.
 *
 * Merge outcomes are recorded two ways: a `board/merges/<ticket>.yaml`
 * `MergeRecord` (`packages/shared/src/merge.ts`) via the store's generic
 * `putEntity` — `merge.status` reads this back, and `putEntity` mints its
 * own generic `entity_put` event alongside the write — and a dedicated
 * `EVENT_KINDS` entry per outcome (`merge_completed`/`merge_conflict`/
 * `merge_tests_failed`/`integration_merged_to_main`, `packages/shared/src/
 * event.ts`) so `log/events.jsonl` has a semantic line for "a merge
 * happened" the way `hil_requested` sits alongside `entity_put` for a HIL
 * write. A conflict/test-failure outcome additionally goes through
 * `createHalt`, which mints its own `halt_created` event. The `MergeRecord`
 * is written (and events appended) for a `merged` outcome *before* the
 * ticket worktree removal is attempted (review round 1 blocker 2: the merge
 * itself has already landed by that point, so a removal failure — a stray
 * untracked file `git worktree remove` refuses to walk over — must never
 * cost the durable record of a merge that already happened; see
 * `removeWorktreeSafely` in `git.ts`).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type HaltId,
  type HilId,
  MESSAGE_BODY_MAX_CHARS,
  type MergeOutcomeStatus,
  type MergeRecord,
  type Ticket,
  type TicketId,
  type TicketStatus,
  ulid,
  validateMergeRecord,
} from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates/service';
import { activeHaltsFor, createHalt, releaseHalt } from '../halts';
import {
  INTEGRATION_BRANCH,
  ensureIntegrationBranch,
  ensureTicketWorktree,
  ticketBranchName,
} from '../runner/worktrees';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import { sandboxedSubprocessEnv } from '../subprocess-env';
import { GitCommandError, git, gitWrite, removeWorktreeSafely, runGit } from './git';

/** Injected test runner result — see `defaultRunTests` for the repo-detection default. */
export interface RunTestsResult {
  ok: boolean;
  summary: string;
}

/**
 * `repoRoot` (added T021 round 5) is the *daemon's* repo root — never the
 * ticket worktree (`cwd`, a different, disposable directory) — so a test
 * double can build the same sandbox path `defaultRunTests` does without
 * having to be handed a third argument nobody's `RunTestsFn` fake actually
 * needs (a fake that ignores the extra parameter is exactly as valid a
 * `RunTestsFn` as one that only took `cwd`, per this type's own arity —
 * every existing fake in `owner.test.ts` keeps compiling unchanged).
 */
export type RunTestsFn = (
  cwd: string,
  repoRoot: string,
) => RunTestsResult | Promise<RunTestsResult>;

const TEST_OUTPUT_TAIL_CHARS = 4000;

function tail(text: string, max: number): string {
  return text.length > max ? `...${text.slice(text.length - max)}` : text;
}

/**
 * Default `runTests`: `bun run test` when the worktree has a bun lockfile
 * (CLAUDE.md's own tooling — "bun test, no native modules"), else `npm
 * test` (CLAUDE.md's fallback path for a non-bun product repo/fixture) —
 * mirrors the `/worktree` skill's own lockfile-based detection. Only run
 * when a `scripts.test` entry actually exists in `package.json`; a repo
 * with none is treated as "nothing to run" (`ok: true`), not a failure.
 * Runs with `sandboxedSubprocessEnv` (T034 — moved to the shared
 * `../subprocess-env` module so `tools/test-run.ts`, `sandbox/backend.ts`,
 * `merge/git.ts` and `runner/worktrees.ts` all share one implementation
 * instead of near-identical copies; this call site originated it in T021)
 * regardless of which command wins — a `bun run test` worktree can just as
 * easily shell out to something `$HOME`-sensitive from inside its own test
 * suite.
 */
export const defaultRunTests: RunTestsFn = (cwd, repoRoot) => {
  const pkgPath = join(cwd, 'package.json');
  let hasTestScript = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      hasTestScript = typeof pkg.scripts?.test === 'string';
    } catch {
      // Malformed package.json — nothing sensible to run.
    }
  }
  if (!hasTestScript) {
    return { ok: true, summary: 'no "test" script in package.json — skipped' };
  }

  const usesBun = existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'));
  const cmd = usesBun ? ['bun', 'run', 'test'] : ['npm', 'test'];
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: sandboxedSubprocessEnv(repoRoot, 'merge-tests'),
  });
  const decoder = new TextDecoder();
  const output = tail(
    `${decoder.decode(proc.stdout)}${decoder.decode(proc.stderr)}`.trim(),
    TEST_OUTPUT_TAIL_CHARS,
  );
  return { ok: proc.exitCode === 0, summary: output || `${cmd.join(' ')} exited ${proc.exitCode}` };
};

/** Approval outcome for the `sprint_review` gate — see `MergeOwnerOptions.gateApproved`. */
export interface GateApproval {
  approved: boolean;
  hilId?: HilId;
}

export type GateApprovedFn = () => GateApproval;

const SPRINT_REVIEW_GATE = 'sprint_review';

/**
 * The real `gateApproved` implementation, once a `GateService` exists to
 * wire in (§16 "HIL gates policy": "integration -> main behind the
 * `sprint_review` gate"). Not the constructor default (see
 * `MergeOwnerOptions.gateApproved`'s doc comment) so a caller that hasn't
 * wired a `GateService` yet gets an explicit "not approved" rather than
 * this function silently never being consulted. Picks the most recently
 * *requested* `sprint_review` `HilRequest` (ties broken by `requested_at`
 * string order, which is chronological for ISO timestamps) — a `pending`
 * one (or none at all) is "not approved" with its id surfaced for the
 * caller to report; a `resolved` one is approved only if its decision was
 * `approve`, never `deny`.
 */
export function sprintReviewApproved(gates: Pick<GateService, 'list'>): GateApproval {
  const requests = gates.list().filter((r) => r.gate === SPRINT_REVIEW_GATE);
  if (requests.length === 0) return { approved: false };
  const latest = requests.reduce((a, b) => (a.requested_at <= b.requested_at ? b : a));
  if (latest.status !== 'resolved') return { approved: false, hilId: latest.id };
  return { approved: latest.decision === 'approve', hilId: latest.id };
}

/**
 * The in-memory result `onTicketDone`/`mergeIntegrationToMain` return (and
 * `merge.ticket`/`merge.integration_to_main` hand back over RPC) — a
 * superset of the persisted `MergeRecord` (`packages/shared/src/merge.ts`):
 * `gated` never gets written to a per-ticket record (see that schema's own
 * doc comment), and `ticket` is optional here since
 * `mergeIntegrationToMain` isn't about any one ticket.
 */
export interface MergeOutcome {
  status: MergeOutcomeStatus;
  ticket?: TicketId;
  summary?: string;
  haltId?: HaltId;
  hilId?: HilId;
  mergeCommit?: string;
  worktreeKept?: boolean;
}

export function mergeRecordPath(ticket: TicketId): string {
  return `board/merges/${ticket}.yaml`;
}

/** FIFO async mutex — same shape as `store/store.ts`'s private `Mutex`, needed here too since `repoRoot`'s checked-out branch is shared mutable state this class serializes access to. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface MergeOwnerOptions {
  runTests?: RunTestsFn;
  clock?: () => Date;
  /**
   * `mergeIntegrationToMain`'s `sprint_review` check. No default beyond
   * "not approved" (fail closed, same philosophy as `GateService`'s
   * `delegate`: a gate must never silently pass because nobody wired the
   * check yet). The real implementation, once wired, reads a `GateService`
   * for the latest `sprint_review` request — see `sprintReviewApproved`.
   */
  gateApproved?: GateApprovedFn;
}

/** Ticket ids whose commit subjects mention them — used by the conflict summary below. */
const TICKET_ID_PATTERN = /TKT-\d{4,}/g;

/**
 * `onTicketDone` runs for a ticket QA just accepted (`done`), or — per the
 * ticket's own Design note ("keep if stale/abandoned") — one the architect
 * marked `stale` after QA accepted it but before the merge landed (a ripple
 * walk can mark any live ticket stale, and `done` isn't excluded from that
 * in practice even though `TICKET_TRANSITIONS` has no formal edge *into*
 * `stale` from `done` today — see the `.pipeline-review.md`/report
 * DESIGN-GAP). Any other status means `merge.ticket`/`onTicketDone` was
 * called too early (review round 1 nit: "done guard on merge.ticket RPC").
 */
const ONTICKETDONE_ALLOWED_STATUSES: readonly TicketStatus[] = ['done', 'stale'];

export class TicketNotReadyForMergeError extends Error {
  constructor(ticket: TicketId, status: TicketStatus) {
    super(
      `merge refused: ${ticket} has status "${status}", expected one of ${ONTICKETDONE_ALLOWED_STATUSES.join(', ')}`,
    );
    this.name = 'TicketNotReadyForMergeError';
  }
}

export class MissingTicketWorktreeError extends Error {
  constructor(ticket: TicketId, branch: string) {
    super(`merge: ${ticket} (branch ${branch}) has no worktree and no existing branch to reattach`);
    this.name = 'MissingTicketWorktreeError';
  }
}

/**
 * `branch` (`integration` or `main`) is already checked out in some other
 * worktree of this repo — most commonly a human's own `repoRoot` checkout.
 * See `ensureNamedWorktree`'s comment for why this module refuses rather
 * than working around it.
 */
export class BranchCheckedOutElsewhereError extends Error {
  constructor(
    public readonly branch: string,
    gitStderr: string,
  ) {
    super(
      `merge: cannot create a dedicated worktree for "${branch}" — it is already checked out elsewhere in this repo (commonly the operator's own checkout). Check the branch out nowhere else and retry. (git: ${gitStderr})`,
    );
    this.name = 'BranchCheckedOutElsewhereError';
  }
}

/**
 * Daemon-owned worktrees this class merges *into* — never the user's own
 * checkout of `repoRoot` (review round 1 blocker 1). Lazily created,
 * never removed (unlike a ticket's own worktree): they are this class's
 * permanent workspace, so there is never a "done with it" moment to clean
 * up at. `_` prefixes them so they can never collide with a `TKT-####`
 * ticket worktree directory name.
 */
const INTEGRATION_WORKTREE_DIR = '_integration';
const MAIN_WORKTREE_DIR = '_main';
const MAIN_BRANCH = 'main';

export class MergeOwner {
  private readonly runTests: RunTestsFn;
  private readonly clock: () => Date;
  private readonly gateApproved: GateApprovedFn;
  private readonly mutex = new Mutex();

  constructor(
    private readonly store: StateStore,
    private readonly bus: Bus,
    private readonly repoRoot: string,
    options: MergeOwnerOptions = {},
  ) {
    this.runTests = options.runTests ?? defaultRunTests;
    this.clock = options.clock ?? (() => new Date());
    this.gateApproved = options.gateApproved ?? (() => ({ approved: false }));
  }

  /**
   * `.worktrees/<dirName>` on `branch`, created off whatever `branch`
   * already points to (never `-b`: `integration`/`main` already exist by
   * the time this is called, `ensureIntegrationBranch` having been run for
   * the former). Idempotent — a second call just returns the existing
   * path. This is what replaces `git checkout <branch>` in `repoRoot`
   * (review round 1 blocker 1): the daemon merges inside its own worktree,
   * never the user's checkout.
   */
  private ensureNamedWorktree(dirName: string, branch: string): string {
    const path = join(this.repoRoot, '.worktrees', dirName);
    if (existsSync(path)) return path;
    mkdirSync(join(this.repoRoot, '.worktrees'), { recursive: true });
    const result = git(['worktree', 'add', path, branch], this.repoRoot, this.repoRoot);
    if (result.exitCode !== 0) {
      // Git refuses to check out a branch into a second worktree while any
      // worktree (including `repoRoot` itself) already has it checked
      // out — exactly the scenario blocker 1 exists to avoid colliding
      // with (a human's own checkout sitting on `main`/`integration`).
      // This module deliberately does not attempt a checkout-free ref
      // update (`git branch -f`/plumbing) as a fallback: git itself
      // refuses to force-move a branch that's checked out anywhere too, so
      // there is no safe, generic way to advance it without disturbing
      // whichever worktree holds it — surfaced as a clear, actionable
      // error instead of a raw git one. Git < 2.42 words it "is already
      // checked out at"; newer gits say "is already used by worktree at".
      if (/already (used by worktree|checked out) at/i.test(result.stderr)) {
        throw new BranchCheckedOutElsewhereError(branch, result.stderr);
      }
      throw new GitCommandError(['worktree', 'add', path, branch], this.repoRoot, result.stderr);
    }
    return path;
  }

  private ensureIntegrationWorktree(): string {
    ensureIntegrationBranch(this.repoRoot);
    return this.ensureNamedWorktree(INTEGRATION_WORKTREE_DIR, INTEGRATION_BRANCH);
  }

  private ensureMainWorktree(): string {
    return this.ensureNamedWorktree(MAIN_WORKTREE_DIR, MAIN_BRANCH);
  }

  /**
   * True once the engineer has finished the conflict fix cycle: the ticket
   * branch now has `integration` as an ancestor (rebased or merged onto the
   * `integration` that moved under it), no rebase is in progress and the
   * worktree is clean. False for any ticket without a `conflict` record.
   *
   * Fourteenth live run (2026-09-11): all three tickets reached `done` and
   * two hit "rebase conflict onto integration: src/tasks.test.ts" — and
   * that was terminal: the scoped halt denied the very engineer who had to
   * resolve it, nothing prompted a session with the conflict, and
   * `advanceDoneTickets` is one-shot. `advanceMergeConflicts`
   * (`runner/pipeline-glue.ts`) prompts the engineer once and calls
   * `retryAfterConflict` when this turns true.
   */
  conflictResolved(ticket: TicketId): boolean {
    const record = this.status(ticket);
    if (record?.status !== 'conflict') return false;
    const worktree = join(this.repoRoot, '.worktrees', ticket);
    if (!existsSync(worktree)) return false;
    // A rebase in progress leaves `rebase-merge` or `rebase-apply` in the
    // git dir (REBASE_HEAD is *not* a usable signal: git 2.39 keeps it
    // after the rebase completes).
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const rel = git(['rev-parse', '--git-path', dir], worktree, this.repoRoot).stdout;
      if (rel && existsSync(resolve(worktree, rel))) return false;
    }
    // Tracked changes and unresolved paths only: an untracked
    // `node_modules/` (the demo fixture has no .gitignore for it) held the
    // twenty-second live run's fully rebased branch at "not resolved" for
    // seven minutes until the driver's no-liveness rule aborted the run.
    const dirty = git(
      ['status', '--porcelain=v1', '--untracked-files=no'],
      worktree,
      this.repoRoot,
    ).stdout.trim();
    if (dirty !== '') return false;
    const ancestor = git(
      ['merge-base', '--is-ancestor', INTEGRATION_BRANCH, 'HEAD'],
      worktree,
      this.repoRoot,
    );
    return ancestor.exitCode === 0;
  }

  /**
   * Second `onTicketDone` after a resolved conflict: releases the conflict
   * halt, drops the `conflict` record so the attempt is not short-circuited
   * as already-tried, and merges. A new conflict (integration moved again)
   * simply raises a new halt and record through the ordinary path.
   */
  async retryAfterConflict(ticketId: TicketId): Promise<MergeOutcome> {
    return this.mutex.run(async () => {
      const record = this.status(ticketId);
      if (record?.status !== 'conflict') {
        throw new Error(
          `merge: ${ticketId} has no conflict to retry (record: ${record?.status ?? 'none'})`,
        );
      }
      if (record.haltId) {
        try {
          await releaseHalt(this.store, record.haltId);
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      await this.store.deleteEntity(mergeRecordPath(ticketId));
      return this.doOnTicketDone(ticketId);
    });
  }

  /** `board/merges/<ticket>.yaml`, or `undefined` if this ticket has never gone through `onTicketDone`. */
  status(ticket: TicketId): MergeRecord | undefined {
    try {
      return this.store.getEntity(mergeRecordPath(ticket), validateMergeRecord);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  /**
   * Ticket -> `integration`. Serialized against every other call into this
   * class (see the class header) since it checks out branches in the
   * shared `repoRoot`.
   */
  async onTicketDone(ticketId: TicketId): Promise<MergeOutcome> {
    return this.mutex.run(() => this.doOnTicketDone(ticketId));
  }

  private async doOnTicketDone(ticketId: TicketId): Promise<MergeOutcome> {
    const ticket = this.store.getTicket(ticketId);
    if (!ONTICKETDONE_ALLOWED_STATUSES.includes(ticket.status)) {
      throw new TicketNotReadyForMergeError(ticket.id, ticket.status);
    }
    // Dedupe the worktree-path rule against `runner/worktrees.ts` (review
    // round 1 nit) rather than re-deriving `.worktrees/<TKT-id>` here.
    // `ensureTicketWorktree` is idempotent (a `created: false` return is a
    // plain no-op lookup) and, if the worktree was removed but the branch
    // survived (the `stale`/`abandoned` keep path, or a prior removal-
    // safety fallback below), reattaches to the existing branch rather than
    // fabricating an empty one — so `created: true` here only ever means
    // "no worktree *and* no existing branch", which is the same "nothing to
    // merge" condition the old explicit `existsSync` check guarded against.
    const engineerWorktree = ensureTicketWorktree(this.repoRoot, ticket);
    // The branch the worktree is on, not `ticketBranchName(ticket)`: a
    // re-refined title re-slugs the name, and the merge then asked git for
    // a branch that never existed (thirteenth live run, TKT-1002).
    const branch = engineerWorktree.branch;
    if (engineerWorktree.created) {
      throw new MissingTicketWorktreeError(ticket.id, branch);
    }
    const worktreePath = engineerWorktree.path;

    ensureIntegrationBranch(this.repoRoot);

    const rebase = gitWrite(['rebase', INTEGRATION_BRANCH], worktreePath, this.repoRoot);
    if (rebase.exitCode !== 0) {
      const files = this.conflictedFiles(worktreePath);
      gitWrite(['rebase', '--abort'], worktreePath, this.repoRoot);
      const summary = this.buildConflictSummary(ticket, files.length > 0 ? files : [rebase.stderr]);
      return this.haltAndRecord(ticket, 'conflict', summary);
    }

    const testResult = await this.runTests(worktreePath, this.repoRoot);
    if (!testResult.ok) {
      const summary = `tests failed on ${branch} after rebasing onto ${INTEGRATION_BRANCH}: ${testResult.summary}`;
      return this.haltAndRecord(ticket, 'test_failed', summary);
    }

    // Merge into `integration` inside the daemon's own worktree — never
    // `repoRoot` itself (review round 1 blocker 1; see the class header
    // and `ensureNamedWorktree`).
    const integrationWorktree = this.ensureIntegrationWorktree();
    const merge = gitWrite(
      ['merge', '--no-ff', branch, '-m', `Merge ${ticket.id} ${ticket.title}`],
      integrationWorktree,
      this.repoRoot,
    );
    if (merge.exitCode !== 0) {
      // Defensive: a rebase onto `integration` immediately before this
      // should always fast-forward-clean here. Handled the same way as a
      // rebase conflict in case `integration` moved between the rebase
      // above and this checkout (another ticket's merge racing in — the
      // mutex prevents that within one process, but not across processes).
      const files = this.conflictedFiles(integrationWorktree);
      gitWrite(['merge', '--abort'], integrationWorktree, this.repoRoot);
      const summary = this.buildConflictSummary(ticket, files.length > 0 ? files : [merge.stderr]);
      return this.haltAndRecord(ticket, 'conflict', summary);
    }

    const mergeCommit = runGit(['rev-parse', 'HEAD'], integrationWorktree, this.repoRoot);
    await this.store.appendEvent(
      buildEvent('merge_completed', {
        ticket: ticket.id,
        data: { branch, mergeCommit },
      }),
    );

    const keepReason = this.keepReasonFor(ticket);
    if (keepReason) {
      await this.recordMerge(ticket.id, {
        status: 'merged',
        mergeCommit,
        worktreeKept: true,
        keepReason,
      });
      return { status: 'merged', ticket: ticket.id, mergeCommit, worktreeKept: true };
    }

    // The merge has landed: record it *before* attempting removal (review
    // round 1 blocker 2) so a removal failure below can never cost this
    // record. `removeWorktreeSafely` never throws — a stray untracked file
    // gets force-removed, but real uncommitted tracked work keeps the
    // worktree in place rather than being discarded, and either way the
    // record already reflects the truth: the merge happened.
    await this.recordMerge(ticket.id, { status: 'merged', mergeCommit, worktreeKept: false });
    const removal = removeWorktreeSafely(this.repoRoot, worktreePath);
    if (removal.removed) {
      return { status: 'merged', ticket: ticket.id, mergeCommit, worktreeKept: false };
    }

    console.warn(`merge: kept ${worktreePath} after ${ticket.id} merged — ${removal.reason}`);
    await this.recordMerge(ticket.id, {
      status: 'merged',
      mergeCommit,
      worktreeKept: true,
      summary: removal.reason,
    });
    return { status: 'merged', ticket: ticket.id, mergeCommit, worktreeKept: true };
  }

  /**
   * "keep if stale/abandoned" (ticket scope). `stale`: the ripple-walk
   * status (§4 "Ticket"). `abandoned`: read per the session brief's
   * parenthetical as "halted, with no assignee" — a ticket an active halt
   * covers that nobody is currently assigned to fix.
   */
  private keepReasonFor(ticket: Ticket): 'stale' | 'abandoned' | undefined {
    if (ticket.status === 'stale') return 'stale';
    if (!ticket.assignee && activeHaltsFor(this.store, ticket.id).length > 0) return 'abandoned';
    return undefined;
  }

  private conflictedFiles(cwd: string): string[] {
    const out = git(['diff', '--name-only', '--diff-filter=U'], cwd, this.repoRoot).stdout;
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Names the conflicting file(s) and, for each, any *other* ticket whose
   * commit already on `integration` touched it — found by scanning that
   * file's commit subjects on `integration` for a `TKT-####` token (every
   * merge this class makes titles its commit `Merge <TKT-####> <title>`,
   * per `doOnTicketDone` above, so a prior ticket's merge is always
   * findable this way without a separate index).
   */
  private buildConflictSummary(ticket: Ticket, files: string[]): string {
    const parts = files.map((file) => {
      const others = this.otherTicketsTouching(file, ticket.id);
      return others.length > 0 ? `${file} (also touched by ${others.join(', ')})` : file;
    });
    return `rebase conflict onto ${INTEGRATION_BRANCH}: ${parts.join('; ')}`;
  }

  private otherTicketsTouching(file: string, excludeTicket: TicketId): TicketId[] {
    // `--full-history`: a `--no-ff` merge whose tree a plain fast-forward
    // would have produced is otherwise pruned by git's default history
    // simplification when a pathspec is given — exactly the shape of every
    // merge this class makes (`doOnTicketDone`'s `git merge --no-ff`), so
    // without this flag the merge commit whose *subject* names the ticket
    // never shows up here at all, only the engineer's own (unlabelled)
    // commit underneath it.
    const log = git(
      ['log', '--full-history', INTEGRATION_BRANCH, '--format=%s', '--', file],
      this.repoRoot,
      this.repoRoot,
    ).stdout;
    const ids = new Set<string>();
    for (const line of log.split('\n')) {
      for (const match of line.matchAll(TICKET_ID_PATTERN)) {
        if (match[0] !== excludeTicket) ids.add(match[0]);
      }
    }
    return [...ids] as TicketId[];
  }

  /**
   * Conflict / test-failure path: `createHalt` scoped to just this ticket,
   * a `halt` message to `em` (§5 routing: `daemon` may only message `em`
   * directly, or broadcast `halt`/`resume` — a *scoped* halt naming one
   * ticket is not a broadcast, so `em` is the compliant recipient; `em`
   * relays to the engineer per the standing "engineers never message each
   * other, route through em" rule — same pattern `bus.ts`'s liveness sweep
   * and `runner/session.ts`'s dead-session path already use for every
   * other daemon-originated notice), and a `board/merges/<ticket>.yaml`
   * record. The worktree is left untouched (still mid-rebase-aborted,
   * clean) for the engineer's fix cycle.
   */
  private async haltAndRecord(
    ticket: Ticket,
    status: 'conflict' | 'test_failed',
    summary: string,
  ): Promise<MergeOutcome> {
    const now = this.clock();
    const halt = await createHalt(
      this.store,
      { scope: [ticket.id], reason: summary, raised_by: 'daemon' },
      () => now.getTime(),
    );
    await this.bus.send({
      id: ulid(),
      ts: now.toISOString(),
      from: 'daemon',
      to: ['em'],
      kind: 'halt',
      priority: 'urgent',
      ticket: ticket.id,
      body: `merge halt on ${ticket.id}: ${summary}`.slice(0, MESSAGE_BODY_MAX_CHARS),
      requires_ack: true,
    });
    await this.store.appendEvent(
      buildEvent(status === 'conflict' ? 'merge_conflict' : 'merge_tests_failed', {
        ticket: ticket.id,
        data: { summary, haltId: halt.id },
      }),
    );
    await this.recordMerge(ticket.id, { status, summary, haltId: halt.id });
    return { status, ticket: ticket.id, summary, haltId: halt.id };
  }

  private async recordMerge(
    ticket: TicketId,
    fields: Omit<MergeRecord, 'ticket' | 'at'>,
  ): Promise<void> {
    await this.store.putEntity(mergeRecordPath(ticket), validateMergeRecord, {
      ticket,
      at: this.clock().toISOString(),
      ...fields,
    });
  }

  /**
   * `integration -> main`, behind the `sprint_review` gate (§16). Serialized
   * against `onTicketDone` (see the class header) — both touch `repoRoot`'s
   * checkout.
   */
  async mergeIntegrationToMain(): Promise<MergeOutcome> {
    return this.mutex.run(() => this.doMergeIntegrationToMain());
  }

  private async doMergeIntegrationToMain(): Promise<MergeOutcome> {
    const approval = this.gateApproved();
    if (!approval.approved) {
      return {
        status: 'gated',
        ...(approval.hilId !== undefined ? { hilId: approval.hilId } : {}),
      };
    }

    // Merge into `main` inside the daemon's own `_main` worktree — never
    // `repoRoot` itself (review round 1 blocker 1; see the class header).
    const mainWorktree = this.ensureMainWorktree();
    const suffix = approval.hilId ? ` (${approval.hilId})` : '';
    const merge = gitWrite(
      [
        'merge',
        '--no-ff',
        INTEGRATION_BRANCH,
        '-m',
        `Merge ${INTEGRATION_BRANCH} into main${suffix}`,
      ],
      mainWorktree,
      this.repoRoot,
    );
    if (merge.exitCode !== 0) {
      gitWrite(['merge', '--abort'], mainWorktree, this.repoRoot);
      throw new Error(`merge.integration_to_main: merge failed: ${merge.stderr}`);
    }

    const mergeCommit = runGit(['rev-parse', 'HEAD'], mainWorktree, this.repoRoot);
    await this.store.appendEvent(
      buildEvent('integration_merged_to_main', {
        data: {
          mergeCommit,
          ...(approval.hilId !== undefined ? { hilId: approval.hilId } : {}),
        },
      }),
    );
    return {
      status: 'merged',
      mergeCommit,
      ...(approval.hilId !== undefined ? { hilId: approval.hilId } : {}),
    };
  }
}
