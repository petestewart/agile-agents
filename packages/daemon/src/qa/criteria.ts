/**
 * Acceptance criteria parsing (T017 — design/agile-agents-design.md §13:
 * QA runs `ticket.contract.acceptance` "without reading impl").
 *
 * `contract.acceptance` is already a flat `string[]` (T005's
 * `TicketContractSchema`) — nothing to parse out of grammar, just an index
 * assigned per entry so `qa_plan`/`qa_run` have a stable handle for "which
 * criterion" that survives re-ordering better than the string itself would
 * (two identical criterion strings are legal, indices aren't ambiguous).
 */

import type { Ticket } from '@agile-agents/shared';

export interface QaCriterion {
  /** Position in `ticket.contract.acceptance`, 0-based — the handle `qa_plan`'s mapping keys on. */
  index: number;
  /** Verbatim acceptance-criterion text. */
  text: string;
}

/** One `QaCriterion` per `ticket.contract.acceptance` entry, in order. */
export function parseCriteria(ticket: Ticket): QaCriterion[] {
  return ticket.contract.acceptance.map((text, index) => ({ index, text }));
}
