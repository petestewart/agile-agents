/**
 * External ticket sync state (design/agile-agents-design.md §17 "Control
 * room v2": "**Jira is two-way sync**, not import: status changes here
 * update the issue, title/description edits there update the ticket;
 * contracts and rules live only here").
 *
 * DESIGN-GAP: the design names the behaviour but never gives a yaml example
 * for the link record the way it does for `Halt`/`HilRequest`/`MergeRecord`.
 * The shape below is the minimum `packages/daemon/src/sync/**` needs to (a)
 * remember which Jira project a repo is linked to across daemon restarts and
 * (b) resolve the conflict rule ("last writer wins on title/description,
 * Agile Agents wins on status") without re-reading history from either side:
 * a per-issue *shadow* of the title/description as they stood at the last
 * successful sync, plus the two timestamps that say who wrote last.
 *
 * Credentials are deliberately absent: the base URL, account email and API
 * token come from the operator's environment (`JIRA_BASE_URL`,
 * `JIRA_EMAIL`, `JIRA_API_TOKEN`) and are never written into `.agile/`
 * (T045 ticket scope).
 */

import { z } from 'zod';
import { TicketIdSchema, formatZodError } from './ids';

/**
 * What the daemon last agreed with Jira about one issue. `jira_updated` is
 * the issue's own `fields.updated` as of that sync; `local_changed_at` is
 * when the daemon last observed the local ticket's title/description differ
 * from this shadow. Comparing the two is the whole conflict rule.
 */
export const JiraIssueShadowSchema = z
  .object({
    ticket: TicketIdSchema,
    summary: z.string(),
    description: z.string(),
    jira_updated: z.string().min(1),
    /** The issue's status name as of the last sync — what the status push diffs against. */
    jira_status: z.string().optional(),
    local_changed_at: z.string().min(1).optional(),
  })
  .strict();
export type JiraIssueShadow = z.infer<typeof JiraIssueShadowSchema>;

export const JiraLinkSchema = z
  .object({
    /** Jira project key, e.g. `LED`. */
    project: z.string().min(1),
    linked_at: z.string().min(1),
    /** Highest `fields.updated` pulled so far — the incremental-pull cursor. */
    cursor: z.string().min(1).optional(),
    /** Issue key -> shadow. Keyed by issue key, the same value `Ticket.external.jira` holds. */
    issues: z.record(z.string(), JiraIssueShadowSchema).default({}),
  })
  .strict();
export type JiraLink = z.infer<typeof JiraLinkSchema>;

export function validateJiraLink(input: unknown): JiraLink {
  const result = JiraLinkSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('JiraLink', result.error));
  }
  return result.data;
}
