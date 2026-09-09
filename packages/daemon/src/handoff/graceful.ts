/**
 * Graceful handoff instruction (T024; design/agile-agents-design.md §10
 * "Quota-driven pause and handoff": "Graceful handoff: `quota_low` on the
 * current account → daemon injects (normal priority) an instruction to
 * write a `handoff` stanza (done / next / gotchas / uncommitted state) and
 * commit WIP; stops the agent; assigns the ticket to the next candidate").
 *
 * Session-brief override: sent `urgent`, not `normal` — §5 "Delivery by
 * priority"'s urgent tier ("pre-tool-use hook *blocks* the call and returns
 * the message as the reason") is what actually forces the instruction in
 * front of the model before its *next* tool call, rather than merely
 * appending to `additionalContext` on an already-allowed call (the normal
 * tier) where a model mid-turn could still act first and read it late. A
 * quota-low agent has no time budget to spare on a missed cycle.
 *
 * `from: 'em'` (not `'daemon'`): `bus/routing.ts`'s routing table restricts
 * `daemon` to `em`-only recipients ("daemon may only message em, or
 * broadcast halt/resume") — a module outside this ticket's file ownership,
 * so rather than widening that table this coordinator speaks *as* `em`
 * ("em → anyone" is unconditional), the same way `em/board.ts`'s
 * `postDecision` already defaults its `from` to `'em'`. `HandoffCoordinator`
 * is meant to run alongside `EmLoop`'s own tick, not as a literal EM model
 * turn, so this is a daemon-side decision speaking with the EM's routing
 * authority, not an impersonation of the agent itself.
 */

import type { AgentId, Message, TicketId } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import type { Bus, SendResult } from '../bus';

export interface SendGracefulHandoffInstructionOptions {
  bus: Bus;
  agent: AgentId;
  ticket: TicketId;
  vendor: string;
  account: string;
  /** ISO timestamp — the agent's deadline before this ticket takes the hard-handoff path (§10 "Hard handoff"). */
  deadline: string;
  now?: () => Date;
}

/**
 * The urgent instruction itself — read by the hook's tier-2 "urgent unacked
 * inbox -> deny with the message body as the reason" path (`hook/decide.ts`)
 * on the agent's very next tool call.
 */
export async function sendGracefulHandoffInstruction(
  opts: SendGracefulHandoffInstructionOptions,
): Promise<SendResult> {
  const now = opts.now?.() ?? new Date();
  const message: Message = {
    id: ulid(now.getTime()),
    ts: now.toISOString(),
    from: 'em',
    to: [opts.agent],
    kind: 'decision',
    priority: 'urgent',
    ticket: opts.ticket,
    body: `${opts.vendor}/${opts.account} is low on quota. Before your next tool call: post a board_post handoff stanza (done/next/gotchas/uncommitted_state) and commit your WIP. You will be reassigned shortly.`,
    refs: [],
    requires_ack: true,
    deadline: opts.deadline,
  };
  return opts.bus.send(message);
}
