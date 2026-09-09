/**
 * Discovery triage (T015 review fix — blocker 2; design/
 * agile-agents-design.md §5 "Discovery -> standup -> resume" steps 1-2):
 *
 * 1. "Engineer writes a `discovery` board stanza and sends `discovery` to
 *    em."
 * 2. "EM forwards to architect; architect confirms or changes tier."
 *
 * This module is the "EM forwards to architect" half of step 2 — the
 * architect's own tier confirmation and halt creation are T014's (`src/
 * architect/**`), outside this ticket. Once the architect creates a halt
 * (if it decides the discovery warrants one), `EmLoop`'s regular halt scan
 * (`standup.ts`, driven every tick) already picks it up and calls
 * `standupCall` on the very next tick — no separate "start the standup"
 * step is needed here.
 *
 * Two sources are triaged, since the ticket text names both:
 *  - `discovery`-kind messages sitting in `em`'s inbox (the primary path —
 *    step 1's "sends `discovery` to em").
 *  - `discovery`-kind board stanzas (step 1's "writes a ... board stanza",
 *    always paired with the message in the design's own telling, but
 *    triaged here too in case a stanza ever arrives without one — a caller
 *    with only a stanza and no message would otherwise never reach the
 *    architect at all).
 *
 * DESIGN-GAP: stanzas are an append-only log with no ack mechanism (unlike
 * inbox messages), so "already forwarded" is tracked by a caller-supplied
 * `Set<string>` of `<ticket>:<ts>` keys — process-local only, same
 * documented tradeoff `loop.ts`'s `calledHalts`/`escalatedHalts` already
 * make for halts (a daemon restart may re-forward a stanza once; harmless
 * per §5 "Ordering/failure": idempotent consumers).
 */

import type { AgentId, TicketId } from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS, ulid } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { QUORUM_TIMEOUT_MS } from '../halts';
import type { StateStore } from '../store';

// Not exported: `standup.ts` already exports an identical `Clock` shape
// (`() => Date`) and a barrel `export *` (`index.ts`) can't carry both.
type Clock = () => Date;

function truncate(body: string): string {
  return body.length > MESSAGE_BODY_MAX_CHARS ? body.slice(0, MESSAGE_BODY_MAX_CHARS) : body;
}

/**
 * Reuses the halt module's quorum-timeout window as this message's
 * redelivery deadline — no dedicated "how long does the architect have to
 * triage a discovery" tunable exists anywhere in the design or CLAUDE.md,
 * and this is the closest named "give the architect a while to respond"
 * window already in the codebase (DESIGN-GAP).
 */
async function forwardDiscovery(
  bus: Bus,
  ticket: TicketId | undefined,
  body: string,
  refs: readonly string[],
  now: Clock,
): Promise<void> {
  const result = await bus.send({
    id: ulid(now().getTime()),
    ts: now().toISOString(),
    from: 'em',
    to: ['architect'],
    kind: 'discovery',
    priority: 'urgent',
    ticket,
    body: truncate(body),
    refs,
    requires_ack: true,
    deadline: new Date(now().getTime() + QUORUM_TIMEOUT_MS).toISOString(),
  });
  if (!result.ok) {
    throw new Error(`forwardDiscovery: ${result.reason}`);
  }
}

export interface TriageDiscoveriesResult {
  /** `em` inbox message ids forwarded (and acked) this call. */
  forwardedMessageIds: string[];
  /** `<ticket>:<ts>` board-stanza keys forwarded this call. */
  forwardedStanzaKeys: string[];
}

/**
 * Drains `em`'s inbox for `discovery` messages (forwarding each to
 * `architect`, then acking it) and forwards any not-yet-seen `discovery`
 * board stanza on a sprint ticket. `seenStanzaKeys` is caller-owned
 * (`EmLoop` keeps one instance-lifetime `Set` — see this file's header).
 */
export async function triageDiscoveries(
  store: StateStore,
  bus: Bus,
  sprintTicketIds: readonly TicketId[],
  seenStanzaKeys: Set<string>,
  now: Clock = () => new Date(),
): Promise<TriageDiscoveriesResult> {
  const forwardedMessageIds: string[] = [];
  for (const message of bus.poll('em' as AgentId)) {
    if (message.kind !== 'discovery') continue;
    await forwardDiscovery(bus, message.ticket, message.body, message.refs, now);
    await bus.ack('em' as AgentId, message.id);
    forwardedMessageIds.push(message.id);
  }

  const forwardedStanzaKeys: string[] = [];
  for (const ticketId of sprintTicketIds) {
    let stanzas: ReturnType<StateStore['listStanzas']>;
    try {
      stanzas = store.listStanzas(ticketId);
    } catch {
      continue;
    }
    for (const stanza of stanzas) {
      if (stanza.kind !== 'discovery') continue;
      const key = `${ticketId}:${stanza.ts}`;
      if (seenStanzaKeys.has(key)) continue;
      seenStanzaKeys.add(key);
      await forwardDiscovery(bus, ticketId, stanza.discovery?.proposed ?? stanza.summary, [], now);
      forwardedStanzaKeys.push(key);
    }
  }

  return { forwardedMessageIds, forwardedStanzaKeys };
}
