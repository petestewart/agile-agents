/**
 * Oracle write guard + ripple walk (T007 — design/agile-agents-design.md §4
 * "Oracle": "Writer: architect only, via a daemon endpoint that requires a
 * decision ID and validates the graph (no dangling refs, no cycles)... affects
 * makes ripple analysis a graph walk: change DEC -> walk affects transitively
 * -> every ticket whose oracle_refs intersects gets marked stale."; §6
 * "oracle write guard: architect only, decision ID required, graph
 * validated.").
 *
 * File ownership: this module (`packages/daemon/src/oracle/**`) is the only
 * thing T007 may edit outside `packages/daemon/src/halts/**` — no changes to
 * `store.ts`, `rpc.ts`, or `packages/shared` (see PLAN/session notes).
 * Everything here builds on `StateStore`'s existing public surface
 * (`listOracleIndex`, `getOracleEntry`, `putOracleEntry`, `listTickets`,
 * `transitionTicket`) and the `RpcMethodHandler` type already exported by
 * `rpc.ts`.
 */

import {
  type OracleEntry,
  type OracleId,
  type TicketId,
  isLegalTransition,
  validateOracleEntry,
} from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';

/** Thrown by `oracleWrite` for every refusal — actor, dangling refs, cycles, self-supersede. */
export class OracleWriteRefusedError extends Error {
  constructor(
    reason: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`oracle write refused: ${reason}`);
    this.name = 'OracleWriteRefusedError';
  }
}

export interface OracleWriteInput {
  /** Bus agent id of the caller — only `'architect'` may write (§4 "Oracle"). */
  actor: string;
  /** The full entry (unvalidated as input; validated here before anything else). */
  entry: OracleEntry;
  body: string;
}

export interface OracleWriteResult {
  entry: OracleEntry;
  /** Ids flipped from `active` to `superseded` as a side effect of this write. */
  superseded: OracleId[];
  /** Ticket ids the resulting ripple walk marked `stale`. */
  stale: TicketId[];
}

/** Adjacency used only for cycle detection — `depends` and `affects` edges, kept as two separate relations (see `findCycle`). */
interface GraphNode {
  depends: OracleId[];
  affects: OracleId[];
}

/**
 * Loads every entry currently in the index (i.e. every `active` entry other
 * than `pending`, which replaces whatever the index holds for its own id)
 * plus `pending` itself, keyed by id. DESIGN-GAP: only active entries are
 * walked for cycle detection — a superseded/retired entry's edges are dead
 * per §4 ("Superseded files ... drop out of index.yaml") and cannot
 * participate in a *new* cycle since nothing new points into them without
 * itself being a dangling ref (checked separately).
 */
function loadActiveGraph(store: StateStore, pending: OracleEntry): Map<OracleId, GraphNode> {
  const index = store.listOracleIndex();
  const graph = new Map<OracleId, GraphNode>();
  for (const id of Object.keys(index) as OracleId[]) {
    if (id === pending.id) continue;
    const { entry } = store.getOracleEntry(id);
    graph.set(id, { depends: entry.depends, affects: entry.affects });
  }
  graph.set(pending.id, { depends: pending.depends, affects: pending.affects });
  return graph;
}

/**
 * DFS cycle detection (white/gray/black), run separately over `depends`
 * edges and over `affects` edges — never unioned. Review fix (opus, blocker
 * 1): `depends` and `affects` are opposite directions of the *same*
 * relation (§4: "`affects` … forward edges, maintained by architect" mirrors
 * a `depends` edge the other way — the worked example header shows exactly
 * this, `DEC-0042 depends: [SPEC-auth-003]` alongside `SPEC-auth-003
 * affects: [SPEC-api-001, …]`-shaped forward pointers). Unioning the two
 * edge sets turned every such mirrored pair into a 2-cycle and made it
 * impossible to maintain both halves of one relation — exactly the
 * configuration the ripple walk depends on. A cycle *within* `depends`
 * alone (a genuine circular dependency) or *within* `affects` alone (an
 * infinite ripple) is still refused; a `depends`/`affects` pair that mirrors
 * each other is not a cycle. `relation` names which edge set is being
 * walked, so the refusal can say which one.
 */
function findCycle(
  graph: Map<OracleId, GraphNode>,
  relation: 'depends' | 'affects',
): OracleId[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<OracleId, number>();
  const stack: OracleId[] = [];

  function visit(id: OracleId): OracleId[] | undefined {
    color.set(id, GRAY);
    stack.push(id);
    const node = graph.get(id);
    const edges = node ? node[relation] : [];
    for (const next of edges) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === WHITE) {
        const found = visit(next);
        if (found) return found;
      } else if (nextColor === GRAY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  }

  for (const id of graph.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

/** True if an oracle entry file exists on disk, regardless of `status` (active, superseded, or retired). */
function oracleEntryExistsOnDisk(store: StateStore, id: OracleId): boolean {
  try {
    store.getOracleEntry(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Transitive closure over `affects`, seeded at `changedId` (the origin is
 * included in the closure — DESIGN-GAP: the design's one-line description
 * ("change DEC -> walk affects transitively -> every ticket whose
 * oracle_refs intersects gets marked stale") reads as "starting from the
 * changed decision", and a ticket citing the changed decision itself in
 * `oracle_refs` is at least as stale as one citing something two hops out).
 * Missing entries (already gone / never existed) are skipped rather than
 * thrown — the walk is best-effort over whatever oracle state exists.
 */
function affectsClosure(store: StateStore, changedId: OracleId): Set<OracleId> {
  const visited = new Set<OracleId>([changedId]);
  const frontier: OracleId[] = [changedId];
  while (frontier.length > 0) {
    const id = frontier.pop();
    if (id === undefined) break;
    let entry: OracleEntry;
    try {
      entry = store.getOracleEntry(id).entry;
    } catch {
      continue;
    }
    for (const next of entry.affects) {
      if (!visited.has(next)) {
        visited.add(next);
        frontier.push(next);
      }
    }
  }
  return visited;
}

/**
 * Ripple walk (§4 "Oracle"): the transitive `affects` closure of `changedId`
 * intersected with each live ticket's `oracle_refs` gets `transitionTicket`ed
 * to `stale`. "Live" = `isLegalTransition(ticket.status, 'stale')` per
 * `TICKET_TRANSITIONS` (excludes `draft` — can't yet reference anything to go
 * stale from — `done`, which is terminal, and tickets already `stale`).
 * Returns the ids actually transitioned.
 */
export async function rippleWalk(store: StateStore, changedId: OracleId): Promise<TicketId[]> {
  const closure = affectsClosure(store, changedId);
  const staled: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    if (!isLegalTransition(ticket.status, 'stale')) continue;
    const intersects = ticket.oracle_refs.some((ref) => closure.has(ref));
    if (!intersects) continue;
    await store.transitionTicket(ticket.id, 'stale', {
      by: 'daemon',
      reason: `oracle ripple: ${changedId}`,
    });
    staled.push(ticket.id);
  }
  return staled;
}

/**
 * The `oracle.write` guard (named `state.oracle_write` on the RPC surface —
 * see `buildOracleRpcMethods` below for why). Order of operations, all
 * before any file is touched:
 *
 * 1. actor === 'architect', else refuse (§4: "Writer: architect only").
 * 2. entry doesn't supersede itself.
 * 3. dangling refs (review fix, opus blocker 2): `supersedes` is checked
 *    against any oracle entry that exists **on disk**, active or not —
 *    §4 is explicit that a superseded entry still exists ("Superseded files
 *    keep their body … flip status") and `supersedes` is permanent header
 *    data, so an entry could never be re-written (edited body, same header)
 *    once its target had already flipped, if the check only looked at the
 *    live index. `depends`/`affects` are still checked against the
 *    *current* index only — DESIGN-GAP: kept asymmetric on purpose. Those
 *    two edges drive live semantics (dependency ordering, ripple), so a
 *    reference onto a no-longer-active entry is refused the same way a
 *    reference to something that never existed is, rather than silently
 *    riding along on a dead entry.
 * 4. no cycle within `depends` alone, and no cycle within `affects` alone
 *    (see `findCycle`'s header for why these are checked separately rather
 *    than unioned).
 *
 * Then: write the entry (`putOracleEntry` — handles frontmatter, index,
 * changelog, and its own `oracle_put` event), flip every `active` entry it
 * supersedes to `superseded` (same store method, so each flip gets its own
 * changelog line + event, and drops out of the index per T005), and run the
 * ripple walk from the newly-written id.
 */
export async function oracleWrite(
  store: StateStore,
  input: OracleWriteInput,
): Promise<OracleWriteResult> {
  const entry = validateOracleEntry(input.entry);

  if (input.actor !== 'architect') {
    throw new OracleWriteRefusedError(
      `only 'architect' may write oracle entries (got '${input.actor}')`,
      { actor: input.actor },
    );
  }

  if (entry.supersedes.includes(entry.id)) {
    throw new OracleWriteRefusedError(`${entry.id} may not supersede itself`, { id: entry.id });
  }

  const index = store.listOracleIndex();
  const indexIds = new Set(Object.keys(index));
  const danglingSupersedes = entry.supersedes.filter((id) => !oracleEntryExistsOnDisk(store, id));
  const danglingDependsOrAffects = [...entry.depends, ...entry.affects].filter(
    (id) => !indexIds.has(id),
  );
  const dangling = [...new Set([...danglingSupersedes, ...danglingDependsOrAffects])];
  if (dangling.length > 0) {
    throw new OracleWriteRefusedError(`dangling oracle refs: ${dangling.join(', ')}`, {
      dangling,
    });
  }

  const graph = loadActiveGraph(store, entry);
  const dependsCycle = findCycle(graph, 'depends');
  if (dependsCycle) {
    throw new OracleWriteRefusedError(`cycle detected in depends: ${dependsCycle.join(' -> ')}`, {
      cycle: dependsCycle,
      relation: 'depends',
    });
  }
  const affectsCycle = findCycle(graph, 'affects');
  if (affectsCycle) {
    throw new OracleWriteRefusedError(`cycle detected in affects: ${affectsCycle.join(' -> ')}`, {
      cycle: affectsCycle,
      relation: 'affects',
    });
  }

  const written = await store.putOracleEntry(entry, input.body);

  const superseded: OracleId[] = [];
  for (const id of entry.supersedes) {
    const { entry: target, body: targetBody } = store.getOracleEntry(id);
    if (target.status !== 'active') continue;
    await store.putOracleEntry({ ...target, status: 'superseded' }, targetBody);
    superseded.push(id);
  }

  const stale = await rippleWalk(store, written.id);

  return { entry: written, superseded, stale };
}

/**
 * RPC surface. Named under `state.*` (not `oracle.*`) to match the one
 * namespace `rpc-methods.ts` already wires real handlers under
 * (`state.ticket_get`, `state.ticket_list`) — `oracle` is not one of
 * `rpc.ts`'s `STUB_NAMESPACES` (`bus | state | hook | gate`), so an
 * `oracle.write` call would fall through to "unknown method" instead of the
 * "not implemented yet" stub every other future endpoint gets until wired.
 */
export function buildOracleRpcMethods(store: StateStore): Record<string, RpcMethodHandler> {
  return {
    'state.oracle_write': async (params) => {
      const { actor, entry, body } = params as OracleWriteInput;
      return oracleWrite(store, { actor, entry, body });
    },
  };
}
