/**
 * Pipeline glue (T021 — "assign → implement → review → QA → merge",
 * PLAN.md §6 "Definition of Done" / architecture sketch data-flow
 * paragraph).
 *
 * Discovered while wiring the demo e2e: three hand-offs the design's data
 * flow names are never actually driven by any daemon code, only tested in
 * isolation per-ticket:
 *
 *  - "engineer writes board stanzas via MCP board_post → commit → daemon
 *    spawns reviewer session": an engineer's `bus_send(kind:
 *    'review_request', to: 'reviewer')` (routing.ts already allows this)
 *    is never read by anything — `ReviewProtocol.start` (T016) has no
 *    caller outside its own tests.
 *  - "reviewer session → QA session in a fresh clone": `ReviewProtocol`'s
 *    `applyApprove` transitions a ticket to `in_qa` (T016) but never calls
 *    `Runner.spawn('qa', ...)` — by design (`applyApprove`'s own doc
 *    comment: a security pass needs a distinct agent id, "an EM/
 *    orchestration-layer concern, not this method's"). Nothing upstream is
 *    that orchestration layer yet.
 *  - "daemon merges ticket branch to `integration`": `MergeOwner.
 *    onTicketDone` (T019) is only ever called by its own tests; nothing
 *    calls it when `QaProtocol.submit` (T017) lands a ticket on `done`.
 *
 * These three functions are that orchestration layer: each takes the
 * already-tested daemon-side object (`Bus`/`ReviewProtocol`-like/
 * `MergeOwner`-like) plus a small `Set` the caller owns for
 * idempotency (same pattern `EmLoop` already uses for its own
 * once-per-process bookkeeping — `calledHalts`/`escalatedHalts`/
 * `seenDiscoveryStanzas` in `em/loop.ts`), so calling them repeatedly from
 * a ceremony tick is safe. None of them touch the ticket status machine
 * directly — that's still `ReviewProtocol.start`/`Runner.spawn`/
 * `MergeOwner.onTicketDone`'s job; this is purely "notice the hand-off
 * point and make the next call."
 */

import type { TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import type { StateStore } from '../store/store';
import { agentIdFor } from './runner';

/** The slice of `ReviewProtocol` this glue needs (T016). */
export interface ReviewStarter {
  start(ticket: TicketId): Promise<unknown>;
}

/** The slice of `Runner` this glue needs to spawn QA (T012). */
export interface QaSpawner {
  spawn(role: 'qa', ticket: TicketId): Promise<unknown>;
}

/** The slice of `MergeOwner` this glue needs (T019). */
export interface DoneMerger {
  status(ticket: TicketId): unknown;
  onTicketDone(ticket: TicketId): Promise<unknown>;
}

/**
 * Reads every unread `review_request` message off each ticket's reviewer
 * inbox and starts the review round for it, acking the message once
 * `start` has been called. `seen` dedupes by `${ticket}:${message.id}` so a
 * message that somehow survives un-acked (a crash between `start()`
 * throwing and the ack below) is not retried indefinitely within one
 * process lifetime — the same "idempotent consumer" reasoning `EmLoop`
 * documents for its own inbox polling.
 *
 * The reviewer role has no single fixed agent id the way `em`/`architect`
 * do — `AgentIdSchema`/`roleOf` require a concrete id, and `Runner`'s own
 * convention (`agentIdFor('reviewer', ticket)`, `runner.ts`'s file header)
 * is one reviewer inbox per ticket, not a shared `'reviewer'` address (that
 * string isn't even a valid `AgentId` — `bus.send` rejects it). So this
 * polls the same computed id for every open ticket rather than one shared
 * inbox.
 */
export async function advanceReviewRequests(
  store: Pick<StateStore, 'listTickets'>,
  bus: Pick<Bus, 'poll' | 'ack'>,
  reviewer: ReviewStarter,
  seen: Set<string>,
): Promise<TicketId[]> {
  const started: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    const inbox = bus.poll(agentIdFor('reviewer', ticket.id));
    for (const message of inbox) {
      if (message.kind !== 'review_request' || !message.ticket) continue;
      const key = `${message.ticket}:${message.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await reviewer.start(message.ticket);
      started.push(message.ticket);
      await bus.ack(agentIdFor('reviewer', ticket.id), message.id);
    }
  }
  return started;
}

/**
 * Spawns QA for every ticket currently `in_qa` that hasn't been spawned
 * yet this process's lifetime (`seen`, keyed by ticket id — mirrors
 * `Runner`'s own one-agent-per-(role,ticket) rule, so a re-review that
 * cycles a ticket `in_qa -> in_review -> in_qa` again is deliberately not
 * re-triggered here without a caller resetting its `Set`, matching
 * `ReviewProtocol.applyApprove`'s note that re-spawning QA on the same
 * ticket is an orchestration-layer decision).
 */
export async function advanceQaSpawns(
  store: Pick<StateStore, 'listTickets'>,
  runner: QaSpawner,
  seen: Set<TicketId>,
): Promise<TicketId[]> {
  const spawned: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    if (ticket.status !== 'in_qa' || seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    await runner.spawn('qa', ticket.id);
    spawned.push(ticket.id);
  }
  return spawned;
}

/**
 * Merges every `done` ticket that hasn't gone through `onTicketDone` yet.
 * `merger.status(ticket)` (`board/merges/<ticket>.yaml`) is the durable
 * idempotency source of truth — `seen` only saves a redundant disk read on
 * a ticket this same process already merged (or already tried and
 * recorded a halt for; `onTicketDone` always writes a `MergeRecord`, so a
 * conflict/test-failure halt also short-circuits future ticks, matching
 * "the daemon merges" being a one-shot attempt per `done` transition, not
 * a retry loop).
 */
export async function advanceDoneTickets(
  store: Pick<StateStore, 'listTickets'>,
  merger: DoneMerger,
  seen: Set<TicketId>,
): Promise<TicketId[]> {
  const merged: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    if (ticket.status !== 'done' || seen.has(ticket.id)) continue;
    if (merger.status(ticket.id) !== undefined) {
      seen.add(ticket.id);
      continue;
    }
    seen.add(ticket.id);
    await merger.onTicketDone(ticket.id);
    merged.push(ticket.id);
  }
  return merged;
}
