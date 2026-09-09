/**
 * Halts — create/release, scope matching, and quorum tracking (T007 — design
 * agile-agents-design.md §4 "Halts", §5 "Discovery -> standup -> resume"
 * steps 3-4, §5 "Liveness", §15 "Git model and teams" for the `team:` scope
 * variant).
 *
 * File ownership: this module (`packages/daemon/src/halts/**`) plus
 * `packages/daemon/src/oracle/**` are the only things T007 may edit — no
 * changes to `store.ts`, `rpc.ts`, or `packages/shared`.
 *
 * Quorum bookkeeping (which agents a halt is waiting on, which have reported,
 * when it was raised) is kept as **process-local state**, not persisted to
 * `.agile/`, and is documented here as a deliberate DESIGN-GAP:
 *
 * - The `Halt` schema (`packages/shared/src/halt.ts`) only carries
 *   `quorum: pending | reached` — no field for the affected-agent set, the
 *   reported set, or a raised-at timestamp. Adding one is a `packages/shared`
 *   change outside this ticket's file ownership; see the pipeline report for
 *   the exact schema addition to hand the manager.
 * - `StateStore` already documents itself as "one daemon process per repo"
 *   (see `store.ts`'s `Mutex` comment) for the same reason its own mutex
 *   doesn't need cross-process coordination — process-local quorum state
 *   rides the same assumption and needs no new on-disk artifact type.
 * - State is keyed by `WeakMap<StateStore, ...>` (not a bare module
 *   singleton) so distinct `StateStore.open()` instances — e.g. one per test
 *   — never share state even when they mint the same halt id.
 */

import type { AgentId, Halt, HaltId, HaltScope, OracleId, TicketId } from '@agile-agents/shared';
import { validateHalt } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';

/** CLAUDE.md tunable: "quorum timeout 10 min". */
export const QUORUM_TIMEOUT_MS = 10 * 60 * 1000;

export type Clock = () => number;
const defaultClock: Clock = () => Date.now();

interface QuorumState {
  affected: Set<string>;
  reported: Set<string>;
  raisedAt: number;
}

const quorumStates = new WeakMap<StateStore, Map<HaltId, QuorumState>>();

function stateMapFor(store: StateStore): Map<HaltId, QuorumState> {
  let map = quorumStates.get(store);
  if (!map) {
    map = new Map();
    quorumStates.set(store, map);
  }
  return map;
}

function haltIdNumber(id: HaltId): number {
  const n = Number(id.slice('H-'.length));
  return Number.isFinite(n) ? n : 0;
}

function nextHaltId(store: StateStore): HaltId {
  const existing = store.listHalts().map((h) => haltIdNumber(h.id));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `H-${next}` as HaltId;
}

/**
 * Affected agents for a freshly-created halt: agents the bus registry
 * (`listAgents`) currently has assigned to a covered ticket, unioned with
 * each covered ticket's `assignee` field (the registry may be sparsely
 * populated — no bus wiring depends on this ticket, T006 owns it — so a
 * ticket's own `assignee` is a fallback source of the same fact). §4
 * "Halts" / §5 step 3 ("Affected agents' next tool call is blocked; they
 * commit/stash WIP and reply `standup_report`") names the affected set as
 * "affected agents" without pinning down the source; documented per the
 * session brief ("from the registry `listAgents()` or ticket assignees").
 *
 * `global` scope affects every currently-registered agent. `team:<name>`
 * scope affects nobody — DESIGN-GAP: neither `Ticket` nor `AgentRecord`
 * carries a `team` field yet (no sibling precedent to build a team ->
 * agent/ticket mapping from), so a team halt's quorum is vacuously reached
 * immediately (empty affected set) until a later ticket adds team modeling.
 */
function computeAffectedAgents(store: StateStore, scope: HaltScope): Set<string> {
  if (scope === 'global') {
    return new Set(store.listAgents().map((a) => a.id));
  }
  if (Array.isArray(scope)) {
    const ticketIds = new Set<TicketId>(scope);
    const agents = new Set<string>();
    for (const { id, record } of store.listAgents()) {
      if (record.ticket && ticketIds.has(record.ticket)) agents.add(id);
    }
    for (const ticketId of scope) {
      try {
        const ticket = store.getTicket(ticketId);
        if (ticket.assignee) agents.add(ticket.assignee);
      } catch {
        // Ticket gone/never existed — nothing to add.
      }
    }
    return agents;
  }
  return new Set();
}

export interface CreateHaltInput {
  scope: HaltScope;
  reason: string;
  raised_by: string;
  resolves_when?: OracleId;
}

/**
 * Creates a halt: mints the next `H-<n>` id, writes it `quorum: pending` via
 * the store (§4: presence of the file = halt active), and seeds process-local
 * quorum tracking against the affected-agent set computed at creation time.
 * If that set is empty (nobody currently assigned/registered on the scope,
 * or a `team:` halt), the quorum is reached immediately — vacuous truth,
 * and there's nobody to wait on.
 */
export async function createHalt(
  store: StateStore,
  input: CreateHaltInput,
  clock: Clock = defaultClock,
): Promise<Halt> {
  const id = nextHaltId(store);
  const halt = validateHalt({ ...input, id, quorum: 'pending' });
  const created = await store.putHalt(halt);

  const affected = computeAffectedAgents(store, created.scope);
  stateMapFor(store).set(id, { affected, reported: new Set(), raisedAt: clock() });

  return evaluateQuorum(store, id, clock);
}

/** Releases a halt: deletes the file (§4: "Delete the file to release") and drops its quorum state. */
export async function releaseHalt(store: StateStore, id: HaltId): Promise<void> {
  await store.deleteHalt(id);
  stateMapFor(store).delete(id);
}

/**
 * Halts covering a ticket or an agent. `global` covers everything; a
 * ticket-list scope covers only a `TicketId` target present in the list
 * (never an agent id — an agent isn't "in" a ticket list); `team:<name>`
 * never matches here (see `computeAffectedAgents`'s DESIGN-GAP).
 */
export function activeHaltsFor(store: StateStore, target: TicketId | AgentId): Halt[] {
  const isTicketId = /^TKT-\d{4,}$/.test(target);
  return store.listHalts().filter((halt) => {
    if (halt.scope === 'global') return true;
    if (Array.isArray(halt.scope)) return isTicketId && halt.scope.includes(target as TicketId);
    return false;
  });
}

/**
 * Records that `agent` has reported in for `haltId` (§5 step 3: "reply
 * `standup_report`") and re-evaluates quorum. A report from an agent outside
 * the tracked affected set (e.g. one that joined after the halt was raised)
 * is recorded but doesn't by itself change whether quorum is reached — only
 * every *originally* affected agent reporting (or the timeout) does.
 *
 * DESIGN-GAP: the session brief also asks for "a helper that scans a
 * ticket's stanzas of [the `standup_report`] kind" as an alternative input
 * path. `STANZA_KINDS` (`packages/shared/src/stanza.ts`) has no
 * `standup_report` member — that kind exists only on `Message`
 * (`packages/shared/src/message.ts`'s `MESSAGE_KINDS`), per §5 "Message":
 * `standup_report` is a bus message kind, not a board stanza kind. There is
 * nothing to scan for under the `Stanza` schema as it stands, and stanza
 * validation is `.strict()` with a closed `kind` enum, so nothing here can
 * fabricate one without a `packages/shared` change. Only the direct-call
 * path (`recordStandupReport`) is implemented; see the pipeline report for
 * the shared-schema note this leaves for the manager.
 */
export async function recordStandupReport(
  store: StateStore,
  haltId: HaltId,
  agent: string,
  clock: Clock = defaultClock,
): Promise<Halt> {
  const state = stateMapFor(store).get(haltId);
  if (state) state.reported.add(agent);
  return evaluateQuorum(store, haltId, clock);
}

/**
 * Flips `quorum` to `reached` (writing through the store, so it's durable
 * and the `Halt` file is the single source of truth for readers who never
 * call into this module) once every originally-affected agent has reported,
 * or once `QUORUM_TIMEOUT_MS` has elapsed since the halt was raised (§4:
 * "quorum: pending | reached"; §5 "Liveness"/session brief: "reports or the
 * quorum timeout ... elapses"). A no-op (returns the halt unchanged) once
 * quorum is already `reached`, or if there is no tracked quorum state for
 * this id (a halt this process didn't create — e.g. loaded fresh from disk
 * on daemon restart; nothing to evaluate against, per the DESIGN-GAP above).
 */
export async function evaluateQuorum(
  store: StateStore,
  haltId: HaltId,
  clock: Clock = defaultClock,
): Promise<Halt> {
  const halt = store.getHalt(haltId);
  if (halt.quorum === 'reached') return halt;

  const state = stateMapFor(store).get(haltId);
  if (!state) return halt;

  const allReported = [...state.affected].every((agent) => state.reported.has(agent));
  const timedOut = clock() - state.raisedAt >= QUORUM_TIMEOUT_MS;
  if (!allReported && !timedOut) return halt;

  return store.putHalt({ ...halt, quorum: 'reached' });
}

export function buildHaltRpcMethods(store: StateStore): Record<string, RpcMethodHandler> {
  return {
    'state.halt_create': async (params) => createHalt(store, params as CreateHaltInput),
    'state.halt_release': async (params) => {
      const { id } = params as { id: HaltId };
      await releaseHalt(store, id);
      return { released: true };
    },
    'state.halt_list': () => store.listHalts(),
    'state.halt_standup_report': async (params) => {
      const { haltId, agent } = params as { haltId: HaltId; agent: string };
      return recordStandupReport(store, haltId, agent);
    },
  };
}
