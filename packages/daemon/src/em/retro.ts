/**
 * Retro math (T015; design/agile-agents-design.md §4 "Sprint" `retro` block:
 * "computed from the ledger, not agent-written", §11 "Pointing rubric and
 * routing calibration": "any ticket that escalated or exceeded 3x budget
 * gets its rubric answers re-scored").
 *
 * DESIGN-GAP (signature): the session brief describes this as
 * `computeRetro(ledgerLines, events)`. `mispointed` ("spent > 3x estimate",
 * `SprintRetroSchema`'s own doc comment) needs each ticket's
 * `budget.ceiling_tokens` — data that lives on the `Ticket` entity, not in a
 * `LedgerLine` or an `Event` — so this takes an optional third `tickets`
 * list; omitting it degrades `mispointed` to `[]` (nothing to compare
 * against) rather than throwing.
 *
 * DESIGN-GAP (escalations): neither §4 nor §11 gives `escalations` a
 * concrete source. Read as every `escalate`-kind bus message logged for the
 * sprint's window — the vocabulary the rest of the system already uses for
 * "this needs the EM's/architect's attention *now*": liveness-timeout
 * reassignment (`bus.ts` `checkLiveness`), redelivery-deadline escalation
 * (`bus.ts` `sweepRedelivery`), and this ticket's own `handToArchitect`
 * (`standup.ts`) all emit `kind: 'escalate'`. Every send mints one `message`
 * event (`bus.ts`'s header) carrying `{kind}` in its `data`, so counting is
 * a filter over `events`, not a new event kind.
 *
 * DESIGN-GAP (global_halts): counted as `halt_created` events whose logged
 * `scope` is exactly `'global'` (§4 "Halts" scope union) — a `team:`- or
 * ticket-list-scoped halt is narrower than "global" and not counted here.
 */

import type { Event, LedgerLine, SprintRetro, Ticket, TicketId } from '@agile-agents/shared';
import { validateSprint } from '@agile-agents/shared';
import type { Sprint } from '@agile-agents/shared';

const MISPOINTED_MULTIPLIER = 3;

export interface ComputeRetroInput {
  ledgerLines: readonly LedgerLine[];
  events: readonly Event[];
  /** Needed for `mispointed` (ticket ceilings live here, not in the ledger/event stream). Omit to always report `mispointed: []`. */
  tickets?: readonly Ticket[];
}

function tokensSpentByTicket(ledgerLines: readonly LedgerLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of ledgerLines) {
    if (!line.ticket) continue;
    const total = (totals.get(line.ticket) ?? 0) + line.in_tokens + line.out_tokens;
    totals.set(line.ticket, total);
  }
  return totals;
}

function computeMispointed(
  ledgerLines: readonly LedgerLine[],
  tickets: readonly Ticket[],
): TicketId[] {
  const spentByTicket = tokensSpentByTicket(ledgerLines);
  const mispointed: TicketId[] = [];
  for (const ticket of tickets) {
    const ceiling = ticket.budget?.ceiling_tokens;
    if (ceiling === undefined || ceiling <= 0) continue;
    const spent = spentByTicket.get(ticket.id) ?? 0;
    if (spent > MISPOINTED_MULTIPLIER * ceiling) mispointed.push(ticket.id);
  }
  return mispointed.sort((a, b) => a.localeCompare(b));
}

function isEscalateMessageEvent(event: Event): boolean {
  return event.kind === 'message' && (event.data as { kind?: unknown }).kind === 'escalate';
}

function isGlobalHaltCreated(event: Event): boolean {
  return event.kind === 'halt_created' && (event.data as { scope?: unknown }).scope === 'global';
}

/** The §4 "Sprint" `retro` block, computed from a sprint's ledger lines + events. Pure — no store access, so it's cheap to unit-test against a fixture. */
export function computeRetro(input: ComputeRetroInput): SprintRetro {
  const mispointed = input.tickets ? computeMispointed(input.ledgerLines, input.tickets) : [];
  const global_halts = input.events.filter(isGlobalHaltCreated).length;
  const escalations = input.events.filter(isEscalateMessageEvent).length;
  return { mispointed, global_halts, escalations };
}

/** Computes the retro block and writes it onto `sprint.retro`. */
export function withRetro(sprint: Sprint, input: ComputeRetroInput): Sprint {
  return validateSprint({ ...sprint, retro: computeRetro(input) });
}
