/**
 * Living-plan edit rules (T042 — design/agile-agents-design.md §17 "Control
 * room v2": the Plan screen's panes "render the files and edit them", and
 * the ticket's own scope names the three cases enforced **daemon-side**, not
 * in the browser:
 *
 *   - a **not-started** ticket is freely editable (`putTicket`);
 *   - an **in-flight** ticket edit becomes a *contract change* delivered to
 *     its engineer, never a silent rewrite;
 *   - a **done** ticket edit becomes a *follow-up ticket* that `depends` on
 *     it (a done ticket is terminal — `TICKET_TRANSITIONS.done` is `[]`).
 *
 * "In flight" is read as "an agent currently holds this ticket": a status in
 * `IN_FLIGHT_STATUSES` **and** an `assignee`. A `ready`/`stale`/`paused`
 * ticket, or one whose agent has been reaped (no `assignee`), has nobody to
 * send a contract change to, so it takes the free-edit path — which is also
 * what the EM's own reassignment paths assume when they bounce a ticket back
 * to `ready`.
 *
 * Message kind: `MESSAGE_KINDS` (§5) has no `contract_change`, and per the
 * ticket ("do not add kinds unless none fits") the closest existing kind is
 * used instead — `assign`, the one kind §5 defines as "here is your ticket
 * and its contract", sent `human -> <assignee>` (allowed: "human -> anyone")
 * with a copy to `em` ("reviewer/qa -> em (copy)" is the same courtesy the
 * bus already models). The body names the change; the ticket file carries
 * the new contract, exactly as it does for a first assignment.
 */

import {
  type AgentId,
  type Message,
  type Ticket,
  type TicketContract,
  type TicketId,
  type TicketStatus,
  ulid,
  validateTicket,
} from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { StateStore } from '../store';

/** Statuses in which an agent may be actively holding the ticket (§4 "Ticket" state model). */
export const IN_FLIGHT_STATUSES: readonly TicketStatus[] = [
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
  'blocked',
];

export class TicketEditRefused extends Error {
  constructor(reason: string) {
    super(`ticket edit refused: ${reason}`);
    this.name = 'TicketEditRefused';
  }
}

/**
 * Fields a Plan-screen edit may touch. `status` is excluded on purpose (a
 * status change is a `transitionTicket` with its own legality check, the
 * same rule `questions/service.ts`'s `applyTicketEdit` already enforces),
 * and so are `id`/`history` (identity and audit trail).
 */
export const EDITABLE_TICKET_FIELDS = [
  'title',
  'description',
  'depends',
  'oracle_refs',
  'kb_refs',
  'contract',
  'security',
] as const;

/** `contract` is a *partial* contract: an edit that changes only `acceptance` leaves the rest of the contract alone (merged in `mergePatch`). */
export type TicketEditPatch = Partial<
  Omit<Pick<Ticket, (typeof EDITABLE_TICKET_FIELDS)[number]>, 'contract'>
> & { contract?: Partial<TicketContract> };

export type TicketEditMode = 'free' | 'contract_change' | 'follow_up';

export interface TicketEditResult {
  mode: TicketEditMode;
  /** The ticket as it now stands on disk — the edited one, or (follow-up path) the untouched done ticket. */
  ticket: Ticket;
  /** `contract_change`: the bus message delivered to the engineer (and `em`). */
  message?: Message;
  /** `follow_up`: the newly created ticket carrying the edit, `depends: [<done ticket>]`. */
  followUp?: Ticket;
}

export interface TicketEditDeps {
  store: StateStore;
  bus?: Bus;
  /**
   * Who the contract-change message is *from*. `human` (the default — the
   * Plan screen's own edits) may message anyone (§5 routing); `architect`
   * may not reach an engineer directly ("architect -> engineer directly is
   * rejected", `bus/routing.ts`), so an architect-driven edit (the decision
   * re-examination pass) addresses `em` alone and names the assignee in the
   * body. "Never bypass the EM to an engineer" (§17) is the same rule.
   */
  from?: AgentId;
  /** Mints the follow-up ticket's id. Injected so this module doesn't import `architect/refine.ts` circularly in tests. */
  nextTicketId(): TicketId;
  now?: () => Date;
}

/** Which of the three rules this ticket's current state selects. Exported for the UI's "what will this edit do?" hint and for tests. */
export function editModeFor(ticket: Ticket): TicketEditMode {
  if (ticket.status === 'done') return 'follow_up';
  if (IN_FLIGHT_STATUSES.includes(ticket.status) && ticket.assignee !== undefined) {
    return 'contract_change';
  }
  return 'free';
}

function assertPatchAllowed(patch: Record<string, unknown>): void {
  const forbidden = Object.keys(patch).filter(
    (key) => !(EDITABLE_TICKET_FIELDS as readonly string[]).includes(key),
  );
  if (forbidden.length > 0) {
    throw new TicketEditRefused(
      `${forbidden.join(', ')} may not be edited from the Plan screen (status changes go through the board, id/history are the record's identity)`,
    );
  }
}

function mergePatch(current: Ticket, patch: TicketEditPatch): Ticket {
  return validateTicket({
    ...current,
    ...patch,
    ...(patch.contract !== undefined
      ? { contract: { ...current.contract, ...patch.contract } }
      : {}),
  });
}

/** One-line summary of what the edit changed, for the contract-change message body and the follow-up ticket's description. */
export function summarizeEdit(before: Ticket, after: Ticket): string {
  const changed: string[] = [];
  for (const field of EDITABLE_TICKET_FIELDS) {
    const a = JSON.stringify(before[field] ?? null);
    const b = JSON.stringify(after[field] ?? null);
    if (a !== b) changed.push(field);
  }
  return changed.length > 0 ? changed.join(', ') : 'no field changed';
}

/**
 * Applies one Plan-screen ticket edit under the living-plan rules. Every
 * path writes through the store (so `events.jsonl` carries it) and returns
 * which rule fired, so the UI can say so
 * rather than pretending every edit is the same.
 */
export async function applyPlanTicketEdit(
  deps: TicketEditDeps,
  id: TicketId,
  patch: TicketEditPatch,
  by = 'human',
): Promise<TicketEditResult> {
  assertPatchAllowed(patch as Record<string, unknown>);
  const current = deps.store.getTicket(id);
  const mode = editModeFor(current);
  const now = deps.now ?? (() => new Date());

  if (mode === 'follow_up') {
    // A done ticket is terminal, so the edit becomes the next piece of work
    // instead of a rewrite of finished history. The follow-up is a *stub*
    // (`draft` + `description`, empty acceptance — see `stub.ts`): the
    // architect refines it when its layer is next.
    const wanted = mergePatch({ ...current, id: current.id }, patch);
    const followUp = validateTicket({
      id: deps.nextTicketId(),
      title: patch.title ?? `Follow-up to ${current.id}: ${current.title}`,
      description:
        patch.description ??
        `Follow-up requested from the Plan screen by ${by}; changes ${summarizeEdit(current, wanted)} of ${current.id} (done, so it is not rewritten).`,
      status: 'draft',
      depends: [...new Set([...(patch.depends ?? []), current.id])],
      oracle_refs: patch.oracle_refs ?? current.oracle_refs,
      kb_refs: patch.kb_refs ?? current.kb_refs,
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: current.contract.env },
      history: [],
      security: patch.security ?? current.security,
    });
    const saved = await deps.store.putTicket(followUp, { by });
    return { mode, ticket: current, followUp: saved };
  }

  const updated = mergePatch(current, patch);
  const saved = await deps.store.putTicket(updated, { by });

  if (mode === 'free') return { mode, ticket: saved };

  // contract_change: the engineer is mid-ticket, so the new contract has to
  // reach them as a message, not only as a changed file they may never
  // re-read.
  const assignee = current.assignee;
  if (assignee === undefined) throw new TicketEditRefused('in-flight ticket has no assignee');
  const from = deps.from ?? 'human';
  const to = from === 'human' ? [assignee, 'em'] : ['em'];
  if (!deps.bus) {
    throw new TicketEditRefused(
      `${id} is in flight with ${assignee} and the bus is not wired — refusing a silent rewrite`,
    );
  }
  const result = await deps.bus.send({
    id: ulid(),
    ts: now().toISOString(),
    from,
    to,
    kind: 'assign',
    priority: 'urgent',
    ticket: id,
    body: `Contract change on ${id}, held by ${assignee} (edited by ${by}): ${summarizeEdit(current, saved)} changed. Re-read the ticket before continuing; if the change invalidates work already done, say so rather than silently discarding it.`,
  });
  if (!result.ok) throw new TicketEditRefused(`contract-change message rejected: ${result.reason}`);
  return { mode, ticket: saved, message: result.message as Message };
}
