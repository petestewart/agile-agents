/**
 * What a "stub" ticket is (T042 — §17 "Control room v2": "Later-layer
 * tickets are stubs (title, summary, dependencies), refined in full when
 * their layer is next", decided by Pete 2026-09-12).
 *
 * **No new schema field.** `TicketSchema` already carries everything a stub
 * needs and already distinguishes one:
 *
 *   - `status: 'draft'` — "a draft ticket hasn't been refined/pointed by the
 *     architect yet, so it has no contract/estimate to hand an engineer"
 *     (`em/sprint.ts`), which is exactly a stub, and is why `computeFrontier`
 *     already excludes stubs from a sprint without any extra rule;
 *   - `description` (T045) — the one-line summary;
 *   - `depends` — the dependencies;
 *   - `contract.acceptance` empty — nothing machine-checkable yet.
 *     `refine.ts`'s `assertContractRefinable` is what refuses to *ready* a
 *     ticket in that state, so "a stub cannot be started" is already
 *     enforced daemon-side.
 *
 * A `stub` boolean was considered and rejected: it would be a second source
 * of truth for a state the status field already names, and every reader
 * (`computeFrontier`, `refineTicket`, the assign path) would have to learn
 * it. Recorded here rather than in a new doc because this is the module that
 * depends on the reading.
 */

import type { Ticket } from '@agile-agents/shared';

/** True for a not-yet-refined later-layer ticket: `draft`, with no acceptance criteria. */
export function isStub(ticket: Ticket): boolean {
  return ticket.status === 'draft' && ticket.contract.acceptance.length === 0;
}
