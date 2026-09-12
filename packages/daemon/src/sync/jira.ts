/**
 * Jira two-way sync engine (T045 — design/agile-agents-design.md §17
 * "Control room v2": "**Jira is two-way sync**, not import: status changes
 * here update the issue, title/description edits there update the ticket;
 * contracts and rules live only here").
 *
 * Three rules, all of them the ticket's:
 *
 * 1. **Agile Agents wins on status.** Local status is mapped through
 *    `STATUS_MAP` and pushed; a status edited in Jira is *re-asserted* on the
 *    next pass, never pulled back into `Ticket.status`.
 * 2. **Last writer wins on title/description.** Resolved per field against a
 *    per-issue *shadow* of what both sides last agreed on (`JiraIssueShadow`,
 *    `packages/shared/src/sync.ts`): one side changed -> that side wins; both
 *    changed -> the later of the issue's `updated` and the time the daemon
 *    first observed the local edit.
 * 3. **Contracts, rules and dependencies stay local.** `contract`,
 *    `oracle_refs`, `kb_refs`, `depends`, `estimate`, `routing` are never
 *    read from or written to Jira.
 *
 * An issue in the linked project with no local mapping becomes a new
 * `draft` ("not started") ticket carrying `external.jira` — a stub: title,
 * description, empty contract, no oracle refs.
 *
 * Every `.agile/` write goes through the store (`putTicket` mints
 * `ticket_put`; the link record goes through `putEntity`, minting
 * `entity_put`) — no new event kinds, per CLAUDE.md's "written only through
 * the daemon's validating store".
 */

import {
  type JiraIssueShadow,
  type JiraLink,
  type Ticket,
  type TicketId,
  type TicketStatus,
  validateJiraLink,
  validateTicket,
} from '@agile-agents/shared';
import { nextTicketId } from '../architect';
import { NotFoundError, type StateStore } from '../store';
import type { JiraClient, JiraIssue } from './client';

/** `.agile/sync/jira.yaml` — the one link record per repo. */
export const JIRA_LINK_REL_PATH = 'sync/jira.yaml';

/** Who the store records as the author of a sync-driven ticket write. */
export const SYNC_AGENT = 'sync:jira';

/**
 * Local status -> Jira status name. Jira's default company-managed
 * software workflow has exactly these three (`To Do` / `In Progress` /
 * `Done`), so every local status collapses into one of them; anything
 * in flight (including `blocked`/`paused`/`stale`) reads as In Progress
 * to someone looking at the Jira board, which is what it is.
 * Overridable per instance for a project with a custom workflow.
 */
export const DEFAULT_STATUS_MAP: Record<TicketStatus, string> = {
  draft: 'To Do',
  ready: 'To Do',
  assigned: 'In Progress',
  in_progress: 'In Progress',
  in_review: 'In Progress',
  in_qa: 'In Progress',
  blocked: 'In Progress',
  paused: 'In Progress',
  stale: 'In Progress',
  done: 'Done',
};

export interface JiraSyncDeps {
  store: StateStore;
  client: JiraClient;
  /** Test seam — the daemon runs on the system clock. */
  now?: () => Date;
  statusMap?: Record<TicketStatus, string>;
  /** Non-fatal per-issue failures land here as well as in the pass result. */
  onError?: (message: string) => void;
}

export interface JiraSyncStatus {
  linked: boolean;
  project?: string;
  linked_at?: string;
  cursor?: string;
  /** Local tickets carrying an `external.jira` key. */
  mapped: number;
}

export interface JiraSyncPass {
  /** Tickets created from previously unmapped Jira issues. */
  created: TicketId[];
  /** Tickets whose title/description Jira won. */
  pulled: TicketId[];
  /** Issues whose title/description the local ticket won. */
  pushedFields: string[];
  /** Issues whose status was (re-)asserted from the local ticket. */
  pushedStatus: string[];
  errors: string[];
}

const EMPTY_PASS: JiraSyncPass = {
  created: [],
  pulled: [],
  pushedFields: [],
  pushedStatus: [],
  errors: [],
};

export class JiraNotLinkedError extends Error {
  constructor() {
    super('no Jira project is linked (run `agile sync jira link <PROJECT>`)');
    this.name = 'JiraNotLinkedError';
  }
}

/** Drops the `local_changed_at` key outright rather than setting it to `undefined` — the record is serialised to yaml, and an explicit `undefined` is not a value yaml has. */
function withoutLocalChange(shadow: JiraIssueShadow): JiraIssueShadow {
  const { local_changed_at: _dropped, ...rest } = shadow;
  return rest;
}

/** Which side wins one field, given the shadow both sides last agreed on. */
type FieldWinner = 'none' | 'jira' | 'local';

export function resolveField(args: {
  jira: string;
  local: string;
  shadow: string | undefined;
  /** Issue `fields.updated`. */
  jiraUpdatedAt: string;
  /** When the daemon first observed the local side diverge from the shadow. */
  localChangedAt: string | undefined;
}): FieldWinner {
  const { jira, local, shadow, jiraUpdatedAt, localChangedAt } = args;
  if (jira === local) return 'none';
  // No shadow: the mapping was just adopted, so there is no "last agreed"
  // value to diff against and nothing that counts as a local edit yet —
  // Jira is the authority for the first reconciliation.
  if (shadow === undefined) return 'jira';

  const jiraChanged = jira !== shadow;
  const localChanged = local !== shadow;
  if (jiraChanged && !localChanged) return 'jira';
  if (localChanged && !jiraChanged) return 'local';
  if (!jiraChanged && !localChanged) return 'none';

  // Both sides moved: last writer wins.
  if (!localChangedAt) return 'jira';
  return Date.parse(localChangedAt) > Date.parse(jiraUpdatedAt) ? 'local' : 'jira';
}

export class JiraSync {
  private readonly store: StateStore;
  private readonly client: JiraClient;
  private readonly now: () => Date;
  private readonly statusMap: Record<TicketStatus, string>;
  private readonly onError: (message: string) => void;

  constructor(deps: JiraSyncDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
    this.statusMap = deps.statusMap ?? DEFAULT_STATUS_MAP;
    this.onError = deps.onError ?? ((message) => console.error(message));
  }

  // ------------------------------------------------------------- link state

  getLink(): JiraLink | undefined {
    try {
      return this.store.getEntity(JIRA_LINK_REL_PATH, validateJiraLink);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  private async putLink(link: JiraLink): Promise<JiraLink> {
    return this.store.putEntity(JIRA_LINK_REL_PATH, validateJiraLink, link);
  }

  /**
   * Links (or re-links) this repo to one Jira project. Re-linking the same
   * project keeps the existing per-issue shadows and cursor, so nothing is
   * re-pulled; linking a *different* project starts from an empty shadow set
   * (the old project's issue keys are meaningless there).
   */
  async link(project: string): Promise<JiraLink> {
    const existing = this.getLink();
    if (existing && existing.project === project) return existing;
    return this.putLink(
      validateJiraLink({
        project,
        linked_at: this.now().toISOString(),
        issues: {},
      }),
    );
  }

  /**
   * Unlinks the project. Local tickets keep their `external.jira` mapping on
   * purpose — re-linking the same project reconnects them rather than
   * creating a second stub for every issue. The shadows do go, so the first
   * pass after a re-link treats Jira as the authority for title/description
   * (`resolveField`'s no-shadow branch).
   */
  async unlink(): Promise<{ unlinked: boolean; project?: string }> {
    const existing = this.getLink();
    if (!existing) return { unlinked: false };
    await this.store.deleteEntity(JIRA_LINK_REL_PATH);
    return { unlinked: true, project: existing.project };
  }

  status(): JiraSyncStatus {
    const link = this.getLink();
    const mapped = this.store.listTickets().filter((t) => t.external?.jira).length;
    if (!link) return { linked: false, mapped };
    return {
      linked: true,
      project: link.project,
      linked_at: link.linked_at,
      ...(link.cursor ? { cursor: link.cursor } : {}),
      mapped,
    };
  }

  // ------------------------------------------------------------- sync pass

  /**
   * One full pass: observe local edits, pull Jira, merge, push what the
   * local side won, then assert status. Returns an empty pass when no
   * project is linked, so the daemon's poll timer is a no-op on an unlinked
   * repo rather than an error every interval.
   */
  async tick(): Promise<JiraSyncPass> {
    const link = this.getLink();
    if (!link) return { ...EMPTY_PASS };

    const result: JiraSyncPass = {
      created: [],
      pulled: [],
      pushedFields: [],
      pushedStatus: [],
      errors: [],
    };
    const shadows: Record<string, JiraIssueShadow> = { ...link.issues };
    let cursor = link.cursor;

    // --- 1. observe local edits, so step 2's conflict rule has a local
    // timestamp to weigh against the issue's `updated`. Stamped once, on
    // first divergence, and cleared when the edit is pushed.
    const nowIso = this.now().toISOString();
    // One scan of the board for the whole pass, keyed by issue — the merge
    // loop below would otherwise re-scan every ticket once per issue.
    const byKey = new Map<string, Ticket>();
    for (const ticket of this.store.listTickets()) {
      const key = ticket.external?.jira;
      if (key) byKey.set(key, ticket);
    }
    for (const [key, ticket] of byKey) {
      const shadow = shadows[key];
      if (!shadow) continue;
      const diverged =
        ticket.title !== shadow.summary || (ticket.description ?? '') !== shadow.description;
      if (diverged && !shadow.local_changed_at) {
        shadows[key] = { ...shadow, local_changed_at: nowIso };
      } else if (!diverged && shadow.local_changed_at) {
        shadows[key] = withoutLocalChange(shadow);
      }
    }

    // --- 2. pull + merge.
    let issues: JiraIssue[] = [];
    try {
      issues = await this.client.searchUpdatedSince(link.project, link.cursor);
    } catch (err) {
      const message = `jira pull failed: ${err instanceof Error ? err.message : String(err)}`;
      this.onError(message);
      result.errors.push(message);
    }

    for (const issue of issues) {
      if (!issue.key) continue;
      if (!cursor || issue.updated > cursor) cursor = issue.updated;
      try {
        const ticket = byKey.get(issue.key);
        if (!ticket) {
          const created = await this.createStubTicket(issue);
          byKey.set(issue.key, created);
          result.created.push(created.id);
          shadows[issue.key] = {
            ticket: created.id,
            summary: issue.summary,
            description: issue.description,
            jira_updated: issue.updated,
            jira_status: issue.status,
          };
          continue;
        }
        const shadow = shadows[issue.key];
        const titleWinner = resolveField({
          jira: issue.summary,
          local: ticket.title,
          shadow: shadow?.summary,
          jiraUpdatedAt: issue.updated,
          localChangedAt: shadow?.local_changed_at,
        });
        const descWinner = resolveField({
          jira: issue.description,
          local: ticket.description ?? '',
          shadow: shadow?.description,
          jiraUpdatedAt: issue.updated,
          localChangedAt: shadow?.local_changed_at,
        });

        if (titleWinner === 'jira' || descWinner === 'jira') {
          const updated = validateTicket({
            ...ticket,
            ...(titleWinner === 'jira' ? { title: issue.summary } : {}),
            ...(descWinner === 'jira' ? { description: issue.description } : {}),
          });
          await this.store.putTicket(updated, { by: SYNC_AGENT });
          result.pulled.push(ticket.id);
        }

        // The shadow records the value both sides are agreed on *now*: the
        // issue's value where Jira won (the local ticket was just rewritten
        // to match), and the previously agreed value where the local side
        // won — leaving that field visibly diverged from the local ticket so
        // step 3 below pushes it and only then advances the shadow.
        shadows[issue.key] = {
          ticket: ticket.id,
          summary: titleWinner === 'local' ? (shadow?.summary ?? issue.summary) : issue.summary,
          description:
            descWinner === 'local' ? (shadow?.description ?? issue.description) : issue.description,
          jira_updated: issue.updated,
          jira_status: issue.status,
          ...(titleWinner === 'local' || descWinner === 'local'
            ? { local_changed_at: shadow?.local_changed_at ?? nowIso }
            : {}),
        };
      } catch (err) {
        const message = `jira sync failed for ${issue.key}: ${err instanceof Error ? err.message : String(err)}`;
        this.onError(message);
        result.errors.push(message);
      }
    }

    // --- 3/4. push: title/description the local side won, then status.
    for (const ticket of this.linkedTickets()) {
      const key = ticket.external?.jira;
      if (!key) continue;
      const shadow = shadows[key];

      if (shadow) {
        const summary = ticket.title !== shadow.summary ? ticket.title : undefined;
        const description =
          (ticket.description ?? '') !== shadow.description
            ? (ticket.description ?? '')
            : undefined;
        if (summary !== undefined || description !== undefined) {
          try {
            await this.client.updateIssue(key, {
              ...(summary !== undefined ? { summary } : {}),
              ...(description !== undefined ? { description } : {}),
            });
            shadows[key] = withoutLocalChange({
              ...shadow,
              summary: ticket.title,
              description: ticket.description ?? '',
            });
            result.pushedFields.push(key);
          } catch (err) {
            const message = `jira field push failed for ${key}: ${err instanceof Error ? err.message : String(err)}`;
            this.onError(message);
            result.errors.push(message);
          }
        }
      }

      // "Agile Agents wins on status": whatever the issue says, the local
      // status is what it should say. A status changed in Jira shows up in
      // `shadow.jira_status` on the pull above and is corrected right here.
      const wanted = this.statusMap[ticket.status];
      const current = shadows[key];
      if (current && current.jira_status !== wanted) {
        try {
          await this.client.transitionIssue(key, wanted);
          shadows[key] = { ...current, jira_status: wanted };
          result.pushedStatus.push(key);
        } catch (err) {
          const message = `jira status push failed for ${key}: ${err instanceof Error ? err.message : String(err)}`;
          this.onError(message);
          result.errors.push(message);
        }
      }
    }

    await this.putLink(
      validateJiraLink({ ...link, ...(cursor ? { cursor } : {}), issues: shadows }),
    );
    return result;
  }

  // ------------------------------------------------------------- internals

  private linkedTickets(): Ticket[] {
    return this.store.listTickets().filter((t) => Boolean(t.external?.jira));
  }

  /**
   * A stub, deliberately: title, description, `external.jira`, and nothing
   * else. Contracts, oracle refs and dependencies "stay local" (§17 v2) —
   * they are the architect's to fill in during refinement, which is exactly
   * what `draft` means on the board.
   */
  private async createStubTicket(issue: JiraIssue): Promise<Ticket> {
    const ticket = validateTicket({
      id: nextTicketId(this.store),
      title: issue.summary.length > 0 ? issue.summary : issue.key,
      ...(issue.description.length > 0 ? { description: issue.description } : {}),
      status: 'draft' satisfies TicketStatus,
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      contract: {},
      history: [`created from ${issue.key} by ${SYNC_AGENT}`],
      security: false,
      external: { jira: issue.key },
    });
    return this.store.putTicket(ticket, { by: SYNC_AGENT });
  }
}
