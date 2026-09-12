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
 * 2. **Last writer wins on title/description.** Resolved per field against
 *    the per-ticket shadow of what both sides last agreed on
 *    (`external.jira_synced`, `packages/shared/src/ticket.ts`): one side
 *    changed -> that side wins; both changed -> the later of the issue's
 *    `updated` and the time the daemon first observed the local edit.
 * 3. **Contracts, rules and dependencies stay local.** `contract`,
 *    `oracle_refs`, `kb_refs`, `depends`, `estimate`, `routing` are never
 *    read from or written to Jira.
 *
 * An issue in the linked project with no local mapping becomes a new
 * `draft` ("not started") ticket carrying `external.jira` — a stub: title,
 * description, empty contract, no oracle refs.
 *
 * **State placement (manager decision, T045 restructure).** This module
 * writes nothing under `.agile/` except ticket files: the mapping *and* its
 * shadow ride on the ticket (`external`), the pull cursor is derived as the
 * max `jira_synced.updated_at` across mapped tickets, and the linked project
 * key lives in the host-local `agile.config.yaml` (`./config.ts`). Every
 * ticket write goes through `store.putTicket`, minting the existing
 * `ticket_put` event — no new `EVENT_KINDS` entry.
 */

import {
  type Ticket,
  type TicketId,
  type TicketJiraSynced,
  type TicketStatus,
  validateTicket,
} from '@agile-agents/shared';
import { nextTicketId } from '../architect';
import type { StateStore } from '../store';
import type { JiraClient, JiraIssue } from './client';
import { readLinkedProject, writeLinkedProject } from './config';

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
  /** Absolute path to the repo-root `agile.config.yaml` — where the link lives. */
  configPath: string;
  /**
   * Project key from the environment (`JIRA_PROJECT_KEY`), used when
   * `agile.config.yaml` names none. An env-set project cannot be unlinked by
   * writing the file — `unlink` says so rather than silently no-op'ing.
   */
  envProject?: string;
  /** Test seam — the daemon runs on the system clock. */
  now?: () => Date;
  statusMap?: Record<TicketStatus, string>;
  /** Non-fatal per-issue failures land here as well as in the pass result. */
  onError?: (message: string) => void;
}

export interface JiraSyncStatus {
  linked: boolean;
  project?: string;
  /** Where the project key came from — `agile.config.yaml` or the environment. */
  source?: 'config' | 'env';
  /** Max `external.jira_synced.updated_at` across mapped tickets — the pull cursor. */
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

function emptyPass(): JiraSyncPass {
  return { created: [], pulled: [], pushedFields: [], pushedStatus: [], errors: [] };
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

/** Drops `local_changed_at` outright rather than setting it to `undefined` — the shadow is serialised to yaml, and an explicit `undefined` is not a value yaml has. */
function withoutLocalChange(shadow: TicketJiraSynced): TicketJiraSynced {
  const { local_changed_at: _dropped, ...rest } = shadow;
  return rest;
}

export class JiraSync {
  private readonly store: StateStore;
  private readonly client: JiraClient;
  private readonly configPath: string;
  private readonly envProject: string | undefined;
  private readonly now: () => Date;
  private readonly statusMap: Record<TicketStatus, string>;
  private readonly onError: (message: string) => void;

  constructor(deps: JiraSyncDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.configPath = deps.configPath;
    this.envProject = deps.envProject;
    this.now = deps.now ?? (() => new Date());
    this.statusMap = deps.statusMap ?? DEFAULT_STATUS_MAP;
    this.onError = deps.onError ?? ((message) => console.error(message));
  }

  // ------------------------------------------------------------- link state

  /** The linked project key: `agile.config.yaml` first, then the environment. */
  linkedProject(): string | undefined {
    return readLinkedProject(this.configPath) ?? this.envProject;
  }

  /**
   * Links (or re-links) this repo to one Jira project by writing
   * `jira.project` into the host-local `agile.config.yaml` (created if
   * absent, every other key preserved). Existing per-ticket shadows are left
   * alone: re-linking the same project resumes exactly where it left off,
   * and linking a *different* project leaves the old project's mappings on
   * their tickets, where they are simply never matched again.
   */
  link(project: string): JiraSyncStatus {
    writeLinkedProject(this.configPath, project);
    return this.status();
  }

  /**
   * Unlinks the project. Local tickets keep their `external.jira` mapping and
   * shadow on purpose — re-linking the same project reconnects them rather
   * than creating a second stub for every issue.
   */
  unlink(): { unlinked: boolean; project?: string; note?: string } {
    const fromConfig = readLinkedProject(this.configPath);
    if (fromConfig) writeLinkedProject(this.configPath, undefined);
    const stillLinked = this.linkedProject();
    if (!fromConfig && !stillLinked) return { unlinked: false };
    return {
      unlinked: Boolean(fromConfig),
      ...(fromConfig ? { project: fromConfig } : {}),
      // An env-set project is the operator's explicit choice and outranks the
      // file; say so rather than reporting an unlink that did not happen.
      ...(stillLinked
        ? { note: `JIRA_PROJECT_KEY still links ${stillLinked}; unset it to fully unlink` }
        : {}),
    };
  }

  status(): JiraSyncStatus {
    const fromConfig = readLinkedProject(this.configPath);
    const project = fromConfig ?? this.envProject;
    const mapped = this.linkedTickets();
    const cursor = this.cursor(mapped);
    return {
      linked: Boolean(project),
      ...(project ? { project, source: fromConfig ? 'config' : 'env' } : {}),
      ...(cursor ? { cursor } : {}),
      mapped: mapped.length,
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
    const project = this.linkedProject();
    if (!project) return emptyPass();

    const result = emptyPass();
    const nowIso = this.now().toISOString();

    // One scan of the board for the whole pass, keyed by issue — the merge
    // loop below would otherwise re-scan every ticket once per issue. Values
    // are replaced in place as tickets are written, so the push step below
    // sees the merged state without a second read.
    const byKey = new Map<string, Ticket>();
    for (const ticket of this.linkedTickets()) {
      byKey.set(ticket.external?.jira as string, ticket);
    }
    const cursor = this.cursor([...byKey.values()]);

    // --- 1. observe local edits, so step 2's conflict rule has a local
    // timestamp to weigh against the issue's `updated`. Stamped once, on
    // first divergence, and cleared when the edit is pushed.
    for (const [key, ticket] of byKey) {
      const shadow = ticket.external?.jira_synced;
      if (!shadow) continue;
      const diverged =
        ticket.title !== shadow.title || (ticket.description ?? '') !== shadow.description;
      if (diverged && !shadow.local_changed_at) {
        byKey.set(key, await this.writeShadow(ticket, { ...shadow, local_changed_at: nowIso }));
      } else if (!diverged && shadow.local_changed_at) {
        byKey.set(key, await this.writeShadow(ticket, withoutLocalChange(shadow)));
      }
    }

    // --- 2. pull + merge.
    let issues: JiraIssue[] = [];
    try {
      issues = await this.client.searchUpdatedSince(project, cursor);
    } catch (err) {
      const message = `jira pull failed: ${err instanceof Error ? err.message : String(err)}`;
      this.onError(message);
      result.errors.push(message);
    }

    for (const issue of issues) {
      if (!issue.key) continue;
      try {
        const ticket = byKey.get(issue.key);
        if (!ticket) {
          const created = await this.createStubTicket(issue);
          byKey.set(issue.key, created);
          result.created.push(created.id);
          continue;
        }
        const shadow = ticket.external?.jira_synced;
        const titleWinner = resolveField({
          jira: issue.summary,
          local: ticket.title,
          shadow: shadow?.title,
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

        // The shadow records the value both sides are agreed on *now*: the
        // issue's value where Jira won (the local ticket is rewritten to
        // match in the same write), and the previously agreed value where
        // the local side won — leaving that field visibly diverged from the
        // local ticket so step 3 below pushes it and only then advances it.
        const merged: TicketJiraSynced = {
          title: titleWinner === 'local' ? (shadow?.title ?? issue.summary) : issue.summary,
          description:
            descWinner === 'local' ? (shadow?.description ?? issue.description) : issue.description,
          updated_at: issue.updated,
          status: issue.status,
          ...(titleWinner === 'local' || descWinner === 'local'
            ? { local_changed_at: shadow?.local_changed_at ?? nowIso }
            : {}),
        };

        const pulled = titleWinner === 'jira' || descWinner === 'jira';
        byKey.set(
          issue.key,
          await this.writeShadow(ticket, merged, {
            ...(titleWinner === 'jira' ? { title: issue.summary } : {}),
            ...(descWinner === 'jira' ? { description: issue.description } : {}),
          }),
        );
        if (pulled) result.pulled.push(ticket.id);
      } catch (err) {
        const message = `jira sync failed for ${issue.key}: ${err instanceof Error ? err.message : String(err)}`;
        this.onError(message);
        result.errors.push(message);
      }
    }

    // --- 3/4. push: title/description the local side won, then status.
    for (const [key, ticket] of byKey) {
      const shadow = ticket.external?.jira_synced;
      if (!shadow) continue;
      let current = ticket;

      const summary = current.title !== shadow.title ? current.title : undefined;
      const description =
        (current.description ?? '') !== shadow.description
          ? (current.description ?? '')
          : undefined;
      if (summary !== undefined || description !== undefined) {
        try {
          await this.client.updateIssue(key, {
            ...(summary !== undefined ? { summary } : {}),
            ...(description !== undefined ? { description } : {}),
          });
          current = await this.writeShadow(
            current,
            withoutLocalChange({
              ...shadow,
              title: current.title,
              description: current.description ?? '',
            }),
          );
          result.pushedFields.push(key);
        } catch (err) {
          const message = `jira field push failed for ${key}: ${err instanceof Error ? err.message : String(err)}`;
          this.onError(message);
          result.errors.push(message);
        }
      }

      // "Agile Agents wins on status": whatever the issue says, the local
      // status is what it should say. A status changed in Jira shows up in
      // the shadow's `status` on the pull above and is corrected right here.
      const wanted = this.statusMap[current.status];
      const shadowNow = current.external?.jira_synced;
      if (shadowNow && shadowNow.status !== wanted) {
        try {
          await this.client.transitionIssue(key, wanted);
          current = await this.writeShadow(current, { ...shadowNow, status: wanted });
          result.pushedStatus.push(key);
        } catch (err) {
          const message = `jira status push failed for ${key}: ${err instanceof Error ? err.message : String(err)}`;
          this.onError(message);
          result.errors.push(message);
        }
      }
      byKey.set(key, current);
    }

    return result;
  }

  // ------------------------------------------------------------- internals

  private linkedTickets(): Ticket[] {
    return this.store.listTickets().filter((t) => Boolean(t.external?.jira));
  }

  /**
   * Incremental-pull cursor, derived rather than stored: the latest issue
   * `updated` any mapped ticket has seen. Inclusive at the call site
   * (`updated >=`) because Jira's JQL date literal is minute-granular, so an
   * exclusive cursor would drop a second issue edited in the same minute —
   * re-seeing an issue is a no-op, since every decision is shadow-diffed.
   */
  private cursor(tickets: Ticket[]): string | undefined {
    let latest: string | undefined;
    for (const ticket of tickets) {
      const at = ticket.external?.jira_synced?.updated_at;
      if (at && (!latest || at > latest)) latest = at;
    }
    return latest;
  }

  /** One `putTicket` carrying the new shadow and, optionally, the fields Jira won. */
  private async writeShadow(
    ticket: Ticket,
    shadow: TicketJiraSynced,
    fields: { title?: string; description?: string } = {},
  ): Promise<Ticket> {
    return this.store.putTicket(
      validateTicket({
        ...ticket,
        ...fields,
        external: { ...(ticket.external ?? {}), jira_synced: shadow },
      }),
      { by: SYNC_AGENT },
    );
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
      external: {
        jira: issue.key,
        jira_synced: {
          title: issue.summary,
          description: issue.description,
          updated_at: issue.updated,
          status: issue.status,
        },
      },
    });
    return this.store.putTicket(ticket, { by: SYNC_AGENT });
  }
}
