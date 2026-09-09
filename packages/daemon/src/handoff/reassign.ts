/**
 * Reassignment — the shared "hand this ticket to the next candidate in the
 * same worktree" tail both graceful and hard handoff converge on (T024;
 * design/agile-agents-design.md §10: "assigns the ticket to the next
 * candidate (any vendor above the floor), which starts in the same worktree
 * with thread + handoff as context. Ledger splits the ticket across both
 * `(vendor, model)` cells.").
 *
 * The ledger split needs no schema change (see `packages/shared`'s
 * `LedgerLine` — this ticket's file header/report explain why): every
 * `usage_update` line already carries the spawning session's own `model`
 * (`runner/session.ts`), so a ticket handed from Claude to Pi simply
 * accumulates ledger lines under two different `model` values for the same
 * `ticket` — the "both vendors show for one ticket" acceptance shape falls
 * out of the existing per-line `model` field once the reassigned session's
 * provider actually differs, nothing here needs to write an extra field.
 */

import type { Message, Stanza, Ticket, TicketId, TicketTier } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { QuotaService } from '../quota/records';
import { type RoutingCandidate, type RoutingTable, pickCandidate, routeCandidates } from '../quota/routing';
import type { Runner } from '../runner';
import type { StateStore } from '../store';

export class ReassignError extends Error {}

export interface ReassignOptions {
  store: StateStore;
  bus: Bus;
  runner: Pick<Runner, 'spawn'>;
  quota: Pick<QuotaService, 'list'>;
  ticket: TicketId;
  /** The account this handoff is moving *away* from — skipped when another eligible candidate exists. */
  exclude?: { vendor: string; account: string };
  routing?: RoutingTable;
  floor?: number;
  now?: () => Date;
}

export type ReassignResult =
  | { none: true; reason: string }
  | { candidate: RoutingCandidate; agentId: string };

function tierOf(ticket: Ticket): TicketTier {
  return ticket.estimate?.tier ?? 'standard';
}

/** Renders the "thread + handoff stanza" context handed to the reassigned session's brief (`Runner.spawn`'s `extraContext` seam). */
export function renderHandoffContext(stanzas: readonly Stanza[]): string {
  if (stanzas.length === 0) {
    return 'No board stanzas were posted before this handoff.';
  }
  return stanzas
    .map((s) => `- [${s.ts}] (${s.kind}) ${s.summary}${formatHandoffBlock(s.handoff)}`)
    .join('\n');
}

function formatHandoffBlock(handoff: Stanza['handoff']): string {
  if (!handoff) return '';
  const lines = [
    `\n  done: ${handoff.done}`,
    `\n  next: ${handoff.next}`,
    handoff.gotchas ? `\n  gotchas: ${handoff.gotchas}` : '',
    handoff.uncommitted_state ? `\n  uncommitted_state: ${handoff.uncommitted_state}` : '',
  ];
  return lines.join('');
}

/**
 * Picks the next routed candidate (skipping `exclude` when another eligible
 * one exists), records it onto `ticket.routing`, and spawns a fresh
 * engineer session in the ticket's existing worktree — `ticket.status` must
 * already be `ready` (the caller's job: stop the old session and let its
 * own exit handling ready the ticket, exactly the dead-agent path §5
 * "Liveness" already takes, before calling this).
 */
export async function reassignTicket(opts: ReassignOptions): Promise<ReassignResult> {
  const now = opts.now?.() ?? new Date();
  const ticket = opts.store.getTicket(opts.ticket);
  if (ticket.status !== 'ready') {
    throw new ReassignError(
      `reassignTicket: ${opts.ticket} must be 'ready' before reassignment (was '${ticket.status}')`,
    );
  }

  const quotas = opts.quota.list();
  const result = routeCandidates('engineer', tierOf(ticket), {
    vendors: opts.store.getVendors(),
    quotas,
    now,
    routing: opts.routing,
    floor: opts.floor,
  });
  if ('none' in result) return result;

  const filtered = opts.exclude
    ? result.filter((c) => !(c.vendor === opts.exclude?.vendor && c.account === opts.exclude?.account))
    : result;
  const picked = pickCandidate(filtered.length > 0 ? filtered : result);
  if ('none' in picked) return picked;

  await opts.store.putTicket(
    {
      ...ticket,
      routing: {
        attempts: ticket.routing?.attempts ?? 0,
        max_attempts: ticket.routing?.max_attempts ?? 2,
        escalation: ticket.routing?.escalation ?? [],
        model: picked.model ?? ticket.routing?.model ?? picked.vendor,
        vendor: picked.vendor,
        account: picked.account,
      },
    },
    { by: 'daemon' },
  );

  let stanzas: Stanza[] = [];
  try {
    stanzas = opts.store.listStanzas(opts.ticket);
  } catch {
    stanzas = [];
  }

  const spawned = await opts.runner.spawn('engineer', opts.ticket, {
    extraContext: renderHandoffContext(stanzas.slice(-5)),
  });

  const message: Message = {
    id: ulid(now.getTime()),
    ts: now.toISOString(),
    from: 'em',
    to: [spawned.agentId],
    kind: 'assign',
    priority: 'normal',
    ticket: opts.ticket,
    body: `reassigned to ${spawned.agentId} (${picked.vendor}${picked.account ? `/${picked.account}` : ''}) after handoff`,
    refs: [],
    requires_ack: false,
  };
  await opts.bus.send(message);

  return { candidate: picked, agentId: spawned.agentId };
}
