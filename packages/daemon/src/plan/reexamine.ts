/**
 * Decision re-examination pass (T042 — §17 "Control room v2": "Because a stub
 * cites no oracle entry, the ripple walk (§4 `affects`) cannot reach it; a
 * published decision therefore also triggers an architect re-examination pass
 * over **every not-done ticket**, recorded per ticket as unchanged / updated /
 * split. The graph walk is the guarantee, the pass is the judgment.").
 *
 * Runs *after* `oracleWrite`'s own ripple walk (`oracle/index.ts`), never
 * instead of it: the walk still stales every ticket whose `oracle_refs`
 * intersect the changed entry, and this pass then asks the architect about
 * every remaining not-done ticket, stubs included.
 *
 * Every verdict — `unchanged` included, which writes nothing — is recorded as
 * one `ticket_reexamined` event (`packages/shared/src/event.ts`; a new kind,
 * because a pass whose whole point is to be on the record for tickets that
 * did *not* change has nothing existing to ride on). `updated` applies the
 * architect's patch through the living-plan rules, so an in-flight ticket
 * gets a contract-change message exactly as a human's own edit would.
 */

import type { OracleEntry, Ticket, TicketId } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { buildEvent } from '../store';
import type { StateStore } from '../store';
import { type TicketEditPatch, applyPlanTicketEdit } from './living';

export type ReexamineVerdict = 'unchanged' | 'updated' | 'split';

/** A child the architect wants split out of a ticket. Created as a stub (`stub.ts`) — it is refined when its layer is next, same as any later-layer ticket. */
export interface ReexamineChildSpec {
  title: string;
  description?: string;
}

export interface ReexamineOutcome {
  verdict: ReexamineVerdict;
  /** One line of why, recorded on the event. */
  note?: string;
  /** `updated`: the fields to change (living-plan rules apply). */
  patch?: TicketEditPatch;
  /** `split`: the children to carve out. */
  children?: ReexamineChildSpec[];
}

export interface ReexamineContext {
  decision: OracleEntry;
  /** The decision's markdown body, so the architect judges the text and not just the header. */
  body: string;
  ticket: Ticket;
  /** Ticket ids the ripple walk already marked `stale` for this decision — the ones the graph *did* reach. */
  staled: readonly TicketId[];
}

/** The architect's judgment for one ticket. Live: an architect turn. Offline/tests: a canned double calling the same daemon verbs. */
export type Reexaminer = (ctx: ReexamineContext) => ReexamineOutcome | Promise<ReexamineOutcome>;

export interface ReexamineRecord {
  ticket: TicketId;
  verdict: ReexamineVerdict;
  note?: string;
  children?: TicketId[];
}

export interface ReexamineDeps {
  store: StateStore;
  bus?: Bus;
  nextTicketId(): TicketId;
  /** Absent (no architect wired — e.g. a daemon with no vendor login) still records a verdict per ticket, with `note` saying why it is `unchanged`. */
  reexaminer?: Reexaminer;
  now?: () => Date;
}

const NO_ARCHITECT_NOTE =
  'no architect re-examination adapter is wired to this daemon — recorded as unchanged without a judgment';

/**
 * Re-examines every not-done ticket against a freshly published decision and
 * returns one record per ticket, in ticket-id order.
 */
export async function reexamineAfterDecision(
  deps: ReexamineDeps,
  decision: OracleEntry,
  body: string,
  staled: readonly TicketId[] = [],
): Promise<ReexamineRecord[]> {
  const tickets = deps.store
    .listTickets()
    .filter((t) => t.status !== 'done')
    .sort((a, b) => a.id.localeCompare(b.id));

  const records: ReexamineRecord[] = [];
  for (const ticket of tickets) {
    // Re-read: an earlier ticket's split/patch may have moved this one.
    let current: Ticket;
    try {
      current = deps.store.getTicket(ticket.id);
    } catch {
      continue;
    }
    const outcome: ReexamineOutcome = deps.reexaminer
      ? await deps.reexaminer({ decision, body, ticket: current, staled })
      : { verdict: 'unchanged', note: NO_ARCHITECT_NOTE };

    let children: TicketId[] | undefined;
    if (outcome.verdict === 'updated' && outcome.patch) {
      await applyPlanTicketEdit(
        {
          store: deps.store,
          ...(deps.bus ? { bus: deps.bus } : {}),
          from: 'architect',
          nextTicketId: deps.nextTicketId,
          ...(deps.now ? { now: deps.now } : {}),
        },
        current.id,
        outcome.patch,
        'architect',
      );
    } else if (outcome.verdict === 'split' && outcome.children && outcome.children.length > 0) {
      children = [];
      for (const spec of outcome.children) {
        const child = validateTicket({
          id: deps.nextTicketId(),
          title: spec.title,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          status: 'draft',
          depends: [...current.depends],
          oracle_refs: current.oracle_refs,
          kb_refs: current.kb_refs,
          contract: {
            inputs: [],
            outputs: [],
            acceptance: [],
            done: [],
            env: current.contract.env,
          },
          history: [],
          security: current.security,
        });
        const saved = await deps.store.putTicket(child, { by: 'architect' });
        children.push(saved.id);
      }
      // The parent now waits on its children (same shape `reRefineStale`'s
      // split path uses) and records the split in its own history.
      const parent = validateTicket({
        ...current,
        depends: [...new Set([...current.depends, ...children])],
        history: [
          ...current.history,
          `${(deps.now ?? (() => new Date()))().toISOString()} re-examined after ${decision.id}: split into ${children.join(', ')}`,
        ],
      });
      await deps.store.putTicket(parent, { by: 'architect' });
    }

    await deps.store.appendEvent(
      buildEvent('ticket_reexamined', {
        ticket: current.id,
        agent: 'architect',
        data: {
          decision: decision.id,
          verdict: outcome.verdict,
          ...(outcome.note !== undefined ? { note: outcome.note } : {}),
          ...(children !== undefined ? { children } : {}),
          rippled: staled.includes(current.id),
        },
      }),
    );

    records.push({
      ticket: current.id,
      verdict: outcome.verdict,
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      ...(children !== undefined ? { children } : {}),
    });
  }
  return records;
}
