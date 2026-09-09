/**
 * Refinement + re-refinement (T014 — design/agile-agents-design.md §4
 * "Ticket", §5 "Discovery -> standup -> resume" step 6 ("Architect
 * re-refines: split, or add a `refactor` child pointing at the WIP
 * commit."), §12/§13 for what a contract must carry before an engineer can
 * pick a ticket up.
 *
 * `refineTicket`: `draft -> ready`, validating the parts of the contract the
 * ticket names explicitly (contract/acceptance/oracle_refs/env) — the rest
 * of `Ticket`'s own schema validation (`validateTicket`, called inside
 * `store.putTicket`) covers everything else.
 *
 * `reRefineStale`: the three re-refine paths off a `stale` ticket named in
 * the ticket's scope line — `unchanged` and `refactor_child` end on the
 * `stale -> ready` edge (`TICKET_TRANSITIONS`, `packages/shared/src/
 * ticket.ts`); `split` does not (see below).
 *
 * Independent review fix (opus blocker 2, round 2): a `split` parent's own
 * work is *fully superseded* by its children — unlike `refactor_child`
 * (where the parent's original contract still stands once a prerequisite
 * lands), there is nothing left for the parent itself to do. The first
 * version of this function readied the split parent with its children added
 * to `depends`, reasoning that a `ready` ticket whose `depends` aren't all
 * `done` never becomes the sprint frontier (§9) — but once the children
 * *do* land, that parent re-enters the frontier and gets reassigned with a
 * contract that's already been delivered by the split, which is exactly the
 * bug: nothing distinguishes "genuinely blocked, resume when unblocked"
 * (`refactor_child`) from "superseded, never resume" (`split`) once both
 * are sitting at `ready`. Fixed: a `split` parent stays at `stale` — a
 * *legal* status (`TICKET_STATUSES` includes it) that §9's frontier
 * (`every ready ticket`) already excludes by construction, with no
 * `depends` trick needed. DESIGN-GAP (still open): `TICKET_STATUSES` has no
 * "Dropped"/permanently-superseded terminal status of its own — reusing
 * `stale` here is a repurposing, not a real terminal state (a `stale`
 * ticket is nominally "needs re-refining", not "done for good"), and relies
 * on nobody calling `reRefineStale`/`ticket_refine` on it again. A real
 * terminal status is a `packages/shared/src/ticket.ts` schema change
 * outside this ticket's file ownership — flagged for whoever owns that
 * file next, not decided here.
 */

import { existsSync } from 'node:fs';
import type {
  OracleId,
  Ticket,
  TicketContract,
  TicketEstimate,
  TicketId,
} from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { IllegalTransitionError } from '../store';
import type { StateStore } from '../store';

export class RefineValidationError extends Error {
  constructor(
    reason: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`refine refused: ${reason}`);
    this.name = 'RefineValidationError';
  }
}

export interface RefineTicketPatch {
  title?: string;
  contract?: Partial<TicketContract>;
  oracle_refs?: OracleId[];
  estimate?: TicketEstimate;
}

/**
 * Every oracle ref a patch would leave the ticket carrying must resolve in
 * the *active* index — §4 "Oracle": a ref onto something superseded/
 * never-existed is refused the same way `oracleWrite`'s own dangling-ref
 * check is. Exported (QA round 1 fix) so `verbs.ts`'s `ticket_create` can
 * run the identical check `ticket_refine` already runs via `refineTicket` —
 * a ticket must never be able to reach a resolvable `oracle_refs` state by
 * being *created* with a dangling one and never refined again.
 */
export function assertOracleRefsResolve(store: StateStore, refs: readonly OracleId[]): void {
  const index = store.listOracleIndex();
  const dangling = refs.filter((ref) => !(ref in index));
  if (dangling.length > 0) {
    throw new RefineValidationError(
      `oracle_refs not found in the active oracle index: ${dangling.join(', ')}`,
      {
        dangling,
      },
    );
  }
}

/** "write contract (inputs/outputs/acceptance/done/env) and oracle_refs" (refinement.md) — acceptance is what QA runs blind, so an empty list is refused outright rather than silently readying an unverifiable ticket. `env` is enforced by `TicketContractSchema` itself (`ContractEnvSchema`) once merged and re-validated below. */
function assertContractRefinable(contract: TicketContract): void {
  if (contract.acceptance.length === 0) {
    throw new RefineValidationError(
      'contract.acceptance must be non-empty before a ticket can be readied',
    );
  }
}

/**
 * Refines (or re-refines in place) a ticket's contract/oracle_refs/estimate
 * and, if it's currently `draft`, readies it (`draft -> ready`, §4 "Ticket").
 * A ticket that's already past `draft` (e.g. a `stale` ticket the architect
 * is patching before deciding it's `unchanged`) is left at its current
 * status — callers that want the `stale -> ready` edge go through
 * `reRefineStale`, which has its own three paths.
 */
export async function refineTicket(
  store: StateStore,
  id: TicketId,
  patch: RefineTicketPatch,
  options: { by?: string } = {},
): Promise<Ticket> {
  const by = options.by ?? 'architect';
  const current = store.getTicket(id);
  const mergedContract: TicketContract = { ...current.contract, ...(patch.contract ?? {}) };
  assertContractRefinable(mergedContract);

  const oracleRefs = patch.oracle_refs ?? current.oracle_refs;
  assertOracleRefsResolve(store, oracleRefs);

  const updated = validateTicket({
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    contract: mergedContract,
    oracle_refs: oracleRefs,
    ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}),
  });
  const saved = await store.putTicket(updated, { by });

  if (saved.status === 'draft') {
    return store.transitionTicket(id, 'ready', { by, reason: 'refined by architect' });
  }
  return saved;
}

/** `TKT-0231` -> `231`, mirroring `halts/index.ts`'s `haltIdNumber` — the shared package has no "mint the next ticket id" helper of its own (tickets are otherwise seeded, not minted at runtime), so split/refactor-child ticket creation needs its own monotonic id source. */
function ticketIdNumber(id: TicketId): number {
  const match = /(\d+)\s*$/.exec(id);
  const n = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Exported for `verbs.ts`'s `ticket_create` — the same monotonic id source, so a created-then-split ticket run never collides ids. */
export function nextTicketId(store: StateStore): TicketId {
  const existing = store.listTickets().map((t) => ticketIdNumber(t.id));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `TKT-${String(next).padStart(4, '0')}` as TicketId;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

/**
 * Commits whatever's dirty in `worktreeDir` as `WIP: <message>` (design §5
 * step 6/§10 "commit WIP", ticket scope: "refactor child on WIP commit"), the
 * same `Bun.spawnSync(['git', ...])` pattern `runner/worktrees.ts` already
 * uses for every other git call in this codebase. A clean tree (nothing to
 * commit — the discovery was purely a finding, not in-flight edits) is not
 * an error: returns `undefined` rather than an empty/failing commit.
 */
function commitWorktreeWip(worktreeDir: string, message: string): string | undefined {
  if (!existsSync(worktreeDir)) {
    throw new RefineValidationError(`refactor-child worktree does not exist: ${worktreeDir}`);
  }
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: worktreeDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (decode(status.stdout) === '') return undefined;

  Bun.spawnSync(['git', 'add', '-A'], { cwd: worktreeDir, stdout: 'pipe', stderr: 'pipe' });
  const commit = Bun.spawnSync(['git', 'commit', '-q', '-m', `WIP: ${message}`], {
    cwd: worktreeDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (commit.exitCode !== 0) {
    throw new RefineValidationError(
      `git commit failed in ${worktreeDir}: ${decode(commit.stderr)}`,
    );
  }
  const rev = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: worktreeDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return decode(rev.stdout);
}

export interface SplitChildSpec {
  title: string;
  contract: TicketContract;
  oracle_refs?: OracleId[];
  estimate?: TicketEstimate;
}

export type ReRefineDecision =
  /** The decision that staled this ticket doesn't actually change its contract — goes straight back to `ready` as-is (§4 "Ticket": "unchanged -> ready"). */
  | { kind: 'unchanged' }
  /** Splits the ticket into fully-specified children; the parent stays `stale` — its own work is fully superseded, not merely blocked (see file header). */
  | { kind: 'split'; children: readonly SplitChildSpec[] }
  /** A `refactor` child pointing at the parent's WIP commit (§5 step 6, ticket scope). */
  | {
      kind: 'refactor_child';
      /** Absolute path to the parent ticket's worktree — whatever's dirty there is committed as the WIP the child ticket points at. */
      worktreeDir: string;
      childTitle: string;
      childContract: TicketContract;
      oracle_refs?: OracleId[];
    };

export interface ReRefineResult {
  parent: Ticket;
  children: Ticket[];
  /** Set only for the `refactor_child` path when the worktree actually had something to commit. */
  wipCommit?: string;
}

/**
 * Re-refines a `stale` ticket (§5 step 6: "Architect re-refines: split, or
 * add a `refactor` child pointing at the WIP commit" — plus the ticket
 * scope's third path, "unchanged -> ready"). Throws the store's own
 * `IllegalTransitionError` if `id` isn't currently `stale`.
 */
export async function reRefineStale(
  store: StateStore,
  id: TicketId,
  decision: ReRefineDecision,
  options: { by?: string; now?: () => Date } = {},
): Promise<ReRefineResult> {
  const by = options.by ?? 'architect';
  const now = options.now ?? (() => new Date());
  const current = store.getTicket(id);
  if (current.status !== 'stale') {
    // `putTicket` (used by the `split` path below, which no longer calls
    // `transitionTicket`) doesn't itself check `isLegalTransition` the way
    // `transitionTicket` does — assert this explicitly so `split` fails the
    // same way `unchanged`/`refactor_child` already do (via
    // `transitionTicket`'s own guard) when called on a non-stale ticket,
    // rather than silently rewriting a live ticket's `depends`/history.
    // `to: 'ready'` names the family of edge every re-refine path implies
    // (`stale -> ready`, or — for `split` — staying at `stale` on purpose);
    // what's actually illegal here is calling this function at all from a
    // non-`stale` status.
    throw new IllegalTransitionError(id, current.status, 'ready');
  }

  if (decision.kind === 'unchanged') {
    const parent = await store.transitionTicket(id, 'ready', {
      by,
      reason: 're-refined: unchanged, readied as-is',
    });
    return { parent, children: [] };
  }

  if (decision.kind === 'split') {
    const children: Ticket[] = [];
    for (const spec of decision.children) {
      assertContractRefinable(spec.contract);
      const oracleRefs = spec.oracle_refs ?? current.oracle_refs;
      assertOracleRefsResolve(store, oracleRefs);
      const childId = nextTicketId(store);
      const child = validateTicket({
        id: childId,
        title: spec.title,
        status: 'ready',
        depends: [],
        oracle_refs: oracleRefs,
        contract: spec.contract,
        ...(spec.estimate !== undefined ? { estimate: spec.estimate } : {}),
        history: [],
      });
      children.push(await store.putTicket(child, { by }));
    }
    const childIds = children.map((c) => c.id);
    // Review fix (opus blocker 2): stays at `stale`, not `ready` — the
    // parent's own work is fully superseded by the children, not merely
    // blocked on them (see file header). `depends` still records the split
    // for anyone reading the ticket, but no longer needs to *do* anything —
    // `stale` already keeps it off the §9 sprint frontier on its own.
    const parentSplit = validateTicket({
      ...current,
      depends: [...new Set([...current.depends, ...childIds])],
      history: [
        ...current.history,
        `${now().toISOString()} re-refined by ${by}: split into ${childIds.join(', ')} — parent stays stale (superseded, not resumable; see DESIGN-GAP in refine.ts)`,
      ],
    });
    const parent = await store.putTicket(parentSplit, { by });
    return { parent, children };
  }

  // decision.kind === 'refactor_child'
  assertContractRefinable(decision.childContract);
  const oracleRefs = decision.oracle_refs ?? current.oracle_refs;
  assertOracleRefsResolve(store, oracleRefs);
  const wipCommit = commitWorktreeWip(decision.worktreeDir, `${id} re-refine: refactor child`);
  const childId = nextTicketId(store);
  const child = validateTicket({
    id: childId,
    title: decision.childTitle,
    status: 'ready',
    depends: [],
    oracle_refs: oracleRefs,
    contract: decision.childContract,
    history: wipCommit ? [`refactor of ${id} WIP commit ${wipCommit}`] : [],
  });
  const savedChild = await store.putTicket(child, { by });
  const parentWithDepends = validateTicket({
    ...current,
    depends: [...new Set([...current.depends, savedChild.id])],
  });
  await store.putTicket(parentWithDepends, { by });
  const parent = await store.transitionTicket(id, 'ready', {
    by,
    reason: `re-refined: refactor child ${savedChild.id}${wipCommit ? ` (WIP ${wipCommit})` : ''}`,
  });
  return { parent, children: [savedChild], ...(wipCommit ? { wipCommit } : {}) };
}
