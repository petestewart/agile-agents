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

import type { AgentId, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import type { StateStore } from '../store/store';
import { agentIdFor } from './runner';

/** The slice of `ReviewProtocol` this glue needs (T016). */
export interface ReviewStarter {
  start(ticket: TicketId): Promise<unknown>;
}

/**
 * The slice of `Runner` this glue needs to tell a still-live reviewer
 * session apart from a spawn that must happen, and to talk to it again
 * (T021 round 3). `isLive`/`promptAgent` must come from `Runner`'s own
 * in-process map, never from `StateStore.getAgent`/`AgentRecord` — that
 * record is durable and survives a daemon restart (`runner.ts`'s `list()`
 * doc comment), so inferring liveness from it treats a long-dead process
 * as live and permanently suppresses a real spawn the ticket needs (QA
 * round 2 / opus review round 2 blocker 1 — a round-2 attempt at this glue
 * used `store.getAgent` and a new test built for this exact round caught
 * it: a stale record acked a ticket's *first* `review_request` with no
 * reviewer ever spawned).
 */
export interface ReviewRunner {
  isLive(agentId: AgentId): boolean;
  promptAgent(agentId: AgentId, text: string): Promise<unknown>;
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
 * inbox and starts (or re-prompts) the review round for it, acking the
 * message once handled. `seen` dedupes by `${ticket}:${message.id}` so a
 * message that somehow survives un-acked (a crash between the handling
 * below and the ack) is not retried indefinitely within one process
 * lifetime — the same "idempotent consumer" reasoning `EmLoop` documents
 * for its own inbox polling.
 *
 * The reviewer role has no single fixed agent id the way `em`/`architect`
 * do — `AgentIdSchema`/`roleOf` require a concrete id, and `Runner`'s own
 * convention (`agentIdFor('reviewer', ticket)`, `runner.ts`'s file header)
 * is one reviewer inbox per ticket, not a shared `'reviewer'` address (that
 * string isn't even a valid `AgentId` — `bus.send` rejects it). So this
 * polls the same computed id for every open ticket rather than one shared
 * inbox.
 *
 * Re-review reuse (T021 round 2, corrected round 3): a ticket's reviewer
 * agent id is stable across rounds (same convention as above), and nothing
 * in this codebase ever tells that session to exit between rounds — it
 * just stops being prompted once its round-1 verdict is submitted, same as
 * an engineer's session between a `request_changes` and the next
 * `board_post`. `reviewer.start` (`ReviewProtocol.start`) unconditionally
 * calls `Runner.spawn`, which throws "already running" for an agent id
 * still live (`runner.ts`'s one-id-per-(role,ticket) map) — so a second
 * `review_request` on the same ticket (the engineer's fix-and-resubmit)
 * must skip `start`. Round 2 shipped that half; round 3 adds the other
 * half opus review round 2 blocker 2 caught: skipping `start` alone drops
 * the request on the floor in a live run, because a session is otherwise
 * only ever prompted once, at spawn (`session.ts`'s file header) — nothing
 * would ever tell the still-live reviewer a re-review is wanted. This now
 * calls `runner.promptAgent` with the `review_request` message's own body
 * so the live session actually receives a second turn.
 */
export async function advanceReviewRequests(
  store: Pick<StateStore, 'listTickets' | 'getTicket' | 'transitionTicket'>,
  bus: Pick<Bus, 'poll' | 'ack'>,
  reviewer: ReviewStarter,
  runner: ReviewRunner,
  seen: Set<string>,
): Promise<TicketId[]> {
  const started: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    const reviewerId = agentIdFor('reviewer', ticket.id);
    const inbox = bus.poll(reviewerId);
    for (const message of inbox) {
      if (message.kind !== 'review_request' || !message.ticket) continue;
      const key = `${message.ticket}:${message.id}`;
      if (seen.has(key)) continue;
      const messageReviewerId = agentIdFor('reviewer', message.ticket);
      if (runner.isLive(messageReviewerId)) {
        const current = store.getTicket(message.ticket);
        if (current.status === 'in_progress') {
          await store.transitionTicket(message.ticket, 'in_review', { by: 'daemon' });
        }
        try {
          await runner.promptAgent(messageReviewerId, message.body);
        } catch {
          // The session died in the window between `isLive` above and this
          // actual prompt (T021 round 4, opus review round 3 nit: a real
          // `kill -9` right there) — `message` is neither marked `seen` nor
          // acked, so a later tick retries it once `finish()`'s own crash
          // cleanup has run and this agent id is no longer live: that retry
          // takes the `reviewer.start` branch below and spawns for real,
          // instead of this call silently counting a prompt-to-a-corpse as
          // "handled" (session.ts's `rejectOnFailedReply` is what makes
          // that corpse-prompt reject instead of quietly resolving).
          continue;
        }
      } else {
        await reviewer.start(message.ticket);
      }
      seen.add(key);
      started.push(message.ticket);
      await bus.ack(reviewerId, message.id);
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
