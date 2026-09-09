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
 * the ticket's scope line. Every path ends by transitioning the *parent*
 * `stale -> ready` — the only legal outgoing edge `TICKET_TRANSITIONS` gives
 * `stale` (`packages/shared/src/ticket.ts`). There is no "Dropped"/
 * "superseded" ticket status in `TICKET_STATUSES` at all (DESIGN-GAP: this
 * ticket's scope line asks for "parent Dropped-equivalent status per the
 * shared transition table (pick the legal edge; document)" — the shared
 * schema simply doesn't have one to pick beyond `ready`, and adding one is a
 * `packages/shared` change outside this ticket's file ownership). So a
 * split/refactor parent is "retired" the only way the schema allows: it goes
 * back to `ready` but with its own new children added to its `depends` list
 * (`store.putTicket`, before the transition) — a `ready` ticket whose
 * `depends` aren't all `done` never becomes the sprint frontier (§9), so the
 * parent is functionally inert (never re-picked-up) until its children land,
 * without inventing a status the schema doesn't have.
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

/** Every oracle ref a patch would leave the ticket carrying must resolve in the *active* index — §4 "Oracle": a ref onto something superseded/never-existed is refused the same way `oracleWrite`'s own dangling-ref check is. */
function assertOracleRefsResolve(store: StateStore, refs: readonly OracleId[]): void {
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
  /** Splits the ticket into fully-specified children; the parent is readied but blocked on them (see file header). */
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
  options: { by?: string } = {},
): Promise<ReRefineResult> {
  const by = options.by ?? 'architect';
  const current = store.getTicket(id);

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
    const parentWithDepends = validateTicket({
      ...current,
      depends: [...new Set([...current.depends, ...childIds])],
    });
    await store.putTicket(parentWithDepends, { by });
    const parent = await store.transitionTicket(id, 'ready', {
      by,
      reason: `re-refined: split into ${childIds.join(', ')}`,
    });
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
