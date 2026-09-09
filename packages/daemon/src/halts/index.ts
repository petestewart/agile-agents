/**
 * Halts — create/release, scope matching, and quorum tracking (T007 — design
 * agile-agents-design.md §4 "Halts", §5 "Discovery -> standup -> resume"
 * steps 3-4, §5 "Liveness", §15 "Git model and teams" for the `team:` scope
 * variant).
 *
 * File ownership: this module (`packages/daemon/src/halts/**`) plus
 * `packages/daemon/src/oracle/**` are T007's usual ownership; the manager
 * additionally granted `packages/shared/src/halt.ts` and
 * `packages/daemon/src/store/store.ts` for this one change (durable quorum
 * tracking, see below) — everything else stays off-limits.
 *
 * Quorum bookkeeping (which agents a halt is waiting on, which have
 * reported, when it was raised) is **persisted on the `Halt` file itself**
 * (`affected`/`reported`/`raised_at` — added to `HaltSchema` by this change,
 * see the `DESIGN-GAP` there) rather than kept in process memory: CLAUDE.md
 * requires every ceremony to be reconstructible from `.agile/`, and a daemon
 * restart mid-halt must not forget who has already reported. Every function
 * below reads/writes that state through `store.getHalt`/`store.putHalt` —
 * there is no other state in this module, so two `StateStore` instances
 * pointed at the same `.agile/` (e.g. a restarted daemon) agree automatically.
 */

import type {
  AgentId,
  Halt,
  HaltId,
  HaltQuorum,
  HaltScope,
  OracleId,
  TicketId,
} from '@agile-agents/shared';
import { validateHalt } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { StateStore } from '../store';

/** CLAUDE.md tunable default: "quorum timeout 10 min". Overridable per call — see `createHalt`/`evaluateQuorum`. */
export const QUORUM_TIMEOUT_MS = 10 * 60 * 1000;

export type Clock = () => number;
const defaultClock: Clock = () => Date.now();

function haltIdNumber(id: HaltId): number {
  const n = Number(id.slice('H-'.length));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Next `H-<n>` id, monotonic across the halt's whole lifetime — not just the
 * currently-active files. Review fix (opus nit): `listHalts()` alone only
 * sees halts that haven't been released yet, so releasing H-1 and creating a
 * new halt would mint H-1 again, and a `log/events.jsonl` line or a bus
 * message citing "H-1" would be ambiguous about which one it meant. Every
 * `putHalt` creation mints a `halt_created` event carrying `{id, scope}`
 * (`store.ts`), and that log is append-only and never drops a released
 * halt's entry, so it doubles as the durable id-history this needs without
 * a new `.agile/` artifact.
 */
function nextHaltId(store: StateStore): HaltId {
  const fromFiles = store.listHalts().map((h) => haltIdNumber(h.id));
  const fromHistory = store
    .listEvents()
    .filter((event) => event.kind === 'halt_created')
    .map((event) => {
      const id = (event.data as { id?: unknown }).id;
      return typeof id === 'string' ? haltIdNumber(id as HaltId) : 0;
    });
  const existing = [...fromFiles, ...fromHistory];
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `H-${next}` as HaltId;
}

/** Pure quorum decision, shared by `createHalt` (deciding the initial value) and `evaluateQuorum` (re-deciding later). */
function decideQuorum(
  affected: readonly string[],
  reported: readonly string[],
  raisedAt: string | undefined,
  clock: Clock,
  quorumTimeoutMs: number,
): HaltQuorum {
  const reportedSet = new Set(reported);
  const allReported = affected.every((agent) => reportedSet.has(agent));
  const timedOut = raisedAt !== undefined && clock() - Date.parse(raisedAt) >= quorumTimeoutMs;
  return allReported || timedOut ? 'reached' : 'pending';
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
function computeAffectedAgents(store: StateStore, scope: HaltScope): string[] {
  if (scope === 'global') {
    return store.listAgents().map((a) => a.id);
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
    return [...agents];
  }
  return [];
}

export interface CreateHaltInput {
  scope: HaltScope;
  reason: string;
  raised_by: string;
  resolves_when?: OracleId;
}

/**
 * Creates a halt: mints the next `H-<n>` id, computes the affected-agent set
 * at creation time, and persists `affected`/`reported: []`/`raised_at` on
 * the file (§4: presence of the file = halt active). `quorum` is decided
 * *before* the one write this makes — review fix (opus nit): calling
 * `evaluateQuorum` afterward would `putHalt` a second time whenever the
 * affected set is empty (every global halt with no registered agents),
 * minting a spurious `halt_updated` + extra commit for a value that was
 * knowable up front. If the affected set is empty (nobody currently
 * assigned/registered on the scope, or a `team:` halt) quorum is `reached`
 * immediately — vacuous truth, nobody to wait on.
 */
export async function createHalt(
  store: StateStore,
  input: CreateHaltInput,
  clock: Clock = defaultClock,
  quorumTimeoutMs: number = QUORUM_TIMEOUT_MS,
): Promise<Halt> {
  const id = nextHaltId(store);
  const affected = computeAffectedAgents(store, input.scope);
  const raised_at = new Date(clock()).toISOString();
  const quorum = decideQuorum(affected, [], raised_at, clock, quorumTimeoutMs);
  const halt = validateHalt({
    ...input,
    id,
    quorum,
    affected,
    reported: [],
    raised_at,
  });
  return store.putHalt(halt);
}

/** Releases a halt: deletes the file (§4: "Delete the file to release"). */
export async function releaseHalt(store: StateStore, id: HaltId): Promise<void> {
  await store.deleteHalt(id);
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
 * `standup_report`"), persists it onto the halt's `reported` list, and
 * re-evaluates quorum. A report from an agent outside the tracked
 * `affected` set (e.g. one that joined after the halt was raised) is still
 * recorded but doesn't by itself change whether quorum is reached — only
 * every *originally* affected agent reporting (or the timeout) does.
 * Restart-safe: this reads/writes only the halt file, nothing process-local.
 *
 * DESIGN-GAP: the session brief also asks for "a helper that scans a
 * ticket's stanzas of [the `standup_report`] kind" as an alternative input
 * path. Per manager decision, `standup_report` stays a `Message` kind
 * (`packages/shared/src/message.ts`), not a `Stanza` kind — there is nothing
 * to scan for under the `Stanza` schema, and the bus (T006) is the intended
 * read surface for standup replies, wired into this by the EM protocol
 * (T015). Only the direct-call path is implemented here.
 *
 * Review fix (opus nit): a duplicate report from an agent already in
 * `reported` no longer re-writes the file (`Set` membership made the state
 * idempotent already, but the write and its `halt_updated` event were not) —
 * skipped when it would be a no-op.
 */
export async function recordStandupReport(
  store: StateStore,
  haltId: HaltId,
  agent: string,
  clock: Clock = defaultClock,
  quorumTimeoutMs: number = QUORUM_TIMEOUT_MS,
): Promise<Halt> {
  const halt = store.getHalt(haltId);
  if (halt.quorum === 'reached') return halt;

  const reported = new Set(halt.reported ?? []);
  if (!reported.has(agent)) {
    reported.add(agent);
    await store.putHalt({ ...halt, reported: [...reported] });
  }

  return evaluateQuorum(store, haltId, clock, quorumTimeoutMs);
}

/**
 * Flips `quorum` to `reached` (writing through the store, so it's durable —
 * the `Halt` file is the single source of truth, readable by any process
 * that opens the same `.agile/`) once every agent in the halt's persisted
 * `affected` set has reported, or once `quorumTimeoutMs` (default
 * `QUORUM_TIMEOUT_MS`, the CLAUDE.md 10-minute tunable — overridable per call
 * for tests or a future policy override) has elapsed since `raised_at` (§4:
 * "quorum: pending | reached"; §5 "Liveness"/session brief: "reports or the
 * quorum timeout ... elapses"). A no-op (returns the halt unchanged, no
 * write) once quorum is already `reached`, or if it isn't reached yet — the
 * write only happens on an actual `pending -> reached` flip. An absent
 * `raised_at` (a halt predating this field) means nothing to time out
 * against; an absent `affected` list means "nobody to wait on" (vacuously
 * satisfied), not "unknown".
 */
export async function evaluateQuorum(
  store: StateStore,
  haltId: HaltId,
  clock: Clock = defaultClock,
  quorumTimeoutMs: number = QUORUM_TIMEOUT_MS,
): Promise<Halt> {
  const halt = store.getHalt(haltId);
  if (halt.quorum === 'reached') return halt;

  const quorum = decideQuorum(
    halt.affected ?? [],
    halt.reported ?? [],
    halt.raised_at,
    clock,
    quorumTimeoutMs,
  );
  if (quorum !== 'reached') return halt;

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
