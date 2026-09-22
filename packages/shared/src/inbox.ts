/**
 * The inbox (design/cockpit-design.md §3): one list of everything waiting
 * on the human, across every stream, oldest first.
 *
 * An inbox item is **derived**, never persisted: the daemon builds it from
 * the records that already exist (`questions/Q-*.yaml`, `board/hil/HIL-*.
 * yaml`, and the streams themselves), so a restart re-reads them and does
 * not re-deliver anything (§3.3 "Items are records, not messages").
 */

import { z } from 'zod';
import { UlidSchema, formatZodError } from './ids';

/**
 * §3.1's four kinds. `question` and `gate` are the two that carry a
 * decision; `blocked` and `done` are streams whose agent half has stopped
 * with the human half still open — the "waiting for me" states of §2.2.
 * Every other gate kind (`approve_plan`, `sprint_review`, `unblock`,
 * `promote_to_main`, …) is deleted with its policy rows (T121).
 */
export const INBOX_ITEM_KINDS = ['question', 'gate', 'blocked', 'done'] as const;
export const InboxItemKindSchema = z.enum(INBOX_ITEM_KINDS);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

/** "one line, never the whole diff, never the whole question" (§3.2). */
export const INBOX_CONTEXT_MAX_CHARS = 200;

export const InboxItemSchema = z
  .object({
    kind: InboxItemKindSchema,
    /** The underlying record's id — `Q-<ulid>`, `HIL-<ulid>`, or the stream's own id for `blocked`/`done`. */
    id: z.string().min(1),
    stream: UlidSchema,
    /** Ancestor chain rendered root→leaf, as titles: "ledger-lite / import CSV / parser" (§3.2). */
    stream_path: z.array(z.string().min(1)).min(1),
    /** ISO-8601; the list is sorted on this, oldest first (§3.3). */
    ts: z.string().datetime(),
    context: z.string().min(1).max(INBOX_CONTEXT_MAX_CHARS),
    /** Pointer to the full artifact, when there is one (a home-relative path). */
    ref: z.string().min(1).optional(),
  })
  .strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

export function validateInboxItem(input: unknown): InboxItem {
  const result = InboxItemSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('InboxItem', result.error));
  }
  return result.data;
}

/**
 * Trims to one line and to the §3.2 cap — the one place a context string is
 * normalized.
 *
 * T136 (QA rough edge 4): the cut lands on a word boundary. Slicing at the
 * character budget chopped the last word in half ("…the parser diale…"),
 * which reads as corruption rather than as elision. The whole-word prefix
 * is used only when there is one inside the budget; a single word longer
 * than the budget still gets a hard cut, because there is no boundary to
 * find.
 */
export function inboxContext(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= INBOX_CONTEXT_MAX_CHARS) return oneLine;
  const hard = oneLine.slice(0, INBOX_CONTEXT_MAX_CHARS - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const body = lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
  return `${body.trimEnd()}…`;
}
