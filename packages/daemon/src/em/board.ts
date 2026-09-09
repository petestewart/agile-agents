/**
 * Board reading + decision posting (T015; design/agile-agents-design.md §4
 * "Board": "A standup = EM reads the board and writes a `decisions`
 * stanza." — superseded by the PLAN.md Discovered Issues Log 2026-09-08
 * entry: "the EM posts a `decision` *message*, not a `decisions` stanza
 * (stanzas are engineer-only per §4); shared schema is authoritative" —
 * `postDecision` below sends a `Message` of `kind: 'decision'`, never a
 * `Stanza`.
 */

import type {
  AgentId,
  Message,
  MessageRecipient,
  Sprint,
  Stanza,
  Ticket,
  TicketId,
} from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import type { Bus, SendResult } from '../bus';
import type { StateStore } from '../store';

export interface TicketBoardStatus {
  ticket: TicketId;
  status?: Ticket['status'];
  /** Every stanza this ticket has posted, in file order (oldest first). */
  stanzas: Stanza[];
  /** The most recent stanza, if any. */
  latest?: Stanza;
  /** `true` when the ticket's own status is `blocked` right now. */
  blocked: boolean;
  /** The most recent `discovery` stanza not yet superseded by a later one, if any. */
  discovery?: Stanza;
}

export interface BoardSnapshot {
  sprint: Sprint['id'];
  tickets: TicketBoardStatus[];
}

/**
 * Per-ticket latest stanzas plus blocked/discovery flags, for every ticket
 * in `sprint.tickets` (§4 "Board": "A standup = EM reads the board..."). A
 * ticket whose board file doesn't exist yet (no stanzas posted) or whose
 * `Ticket` record is gone reads as an empty/unknown entry rather than
 * throwing — a standup should never fail because one ticket has nothing to
 * report yet.
 */
export function readBoard(store: StateStore, sprint: Sprint): BoardSnapshot {
  const tickets = sprint.tickets.map((ticketId): TicketBoardStatus => {
    let stanzas: Stanza[] = [];
    try {
      stanzas = store.listStanzas(ticketId);
    } catch {
      stanzas = [];
    }
    let ticket: Ticket | undefined;
    try {
      ticket = store.getTicket(ticketId);
    } catch {
      ticket = undefined;
    }
    const discovery = [...stanzas].reverse().find((s) => s.kind === 'discovery');
    return {
      ticket: ticketId,
      status: ticket?.status,
      stanzas,
      latest: stanzas[stanzas.length - 1],
      blocked: ticket?.status === 'blocked',
      discovery,
    };
  });
  return { sprint: sprint.id, tickets };
}

export interface PostDecisionInput {
  to: MessageRecipient[];
  body: string;
  ticket?: TicketId;
  refs?: string[];
  from?: AgentId;
  requires_ack?: boolean;
}

/** Sends a `decision` bus message (§5 "Comms bus" `kind` enum) — the EM's standup output. */
export async function postDecision(bus: Bus, input: PostDecisionInput): Promise<SendResult> {
  const message: Message = {
    id: ulid(),
    ts: new Date().toISOString(),
    from: input.from ?? 'em',
    to: input.to,
    kind: 'decision',
    priority: 'normal',
    ticket: input.ticket,
    body: input.body,
    refs: input.refs ?? [],
    requires_ack: input.requires_ack ?? false,
  };
  return bus.send(message);
}
