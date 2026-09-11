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
import { ulid } from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import { validateReviewRecord } from '../review/types';
import { reviewRecordRelPath } from '../review/types';
import type { StateStore } from '../store/store';
import { agentIdFor, securityReviewerIdFor } from './runner';

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

/** How long a re-prompt waits for the session to reject it outright (not live, prompt refused) before the glue treats the turn as dispatched. */
export const TURN_ACCEPT_WINDOW_MS = 2_000;

/**
 * Sends a turn without waiting for the model to finish it. `Runner.
 * promptAgent` resolves when the whole turn ends (`session.ts`'s
 * `runPromptTurn`, queued behind any turn still in flight) — minutes on a
 * real vendor — and every glue function here used to `await` it, so one
 * re-prompt froze the driver loop (`agile run`'s tick, `GateService.tick`,
 * `EmLoop.tick`, every other hand-off) for the length of a model turn.
 * Fifth/sixth live runs (2026-09-10): 9 ticks in 20 min; engineers whose
 * APPROVED/DENIED prompt could not be delivered sent no heartbeats and
 * were reaped as "unresponsive".
 *
 * The retry contract the callers document is kept: a session that rejects
 * the prompt straight away (died between `isLive` and here) still throws
 * within `acceptMs`, so the message stays unread for the next tick. A turn
 * that fails later is the session's own business — `runPromptTurn` stops
 * it, readies the ticket and escalates to em — so that rejection is
 * swallowed here rather than surfacing as an unhandled promise.
 */
export async function dispatchTurn(
  runner: Pick<ReviewRunner, 'promptAgent'>,
  agentId: AgentId,
  text: string,
  acceptMs: number = TURN_ACCEPT_WINDOW_MS,
): Promise<void> {
  const turn = runner.promptAgent(agentId, text).then(
    () => undefined,
    (err: unknown) => {
      throw err;
    },
  );
  turn.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accepted = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, acceptMs);
    timer.unref?.();
  });
  try {
    await Promise.race([turn, accepted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 * The slice of `Runner` `ensureArchitectSpawned` needs (T031) — the same
 * `isLive`/`spawn` shape `QaSpawner`/`ReviewRunner` above already use for
 * their own roles.
 */
export interface ArchitectSpawner {
  isLive(agentId: AgentId): boolean;
  spawn(role: 'architect', ticket: TicketId): Promise<unknown>;
}

/**
 * Ensures the architect's singleton session (`agentIdFor('architect', ...)`
 * — one per repo, §15) is live before its MCP verbs are invoked for
 * `ticket`'s discovery cycle, spawning it once and reusing it for every
 * later discovery this process raises (T031 — the hand-off `run.ts`'s
 * `runScriptedDiscovery` used to skip entirely: it called
 * `registerArchitectTools` in-process with no spawned agent at all, unlike
 * every other role's own scripted turn, which drives its verbs against a
 * real `Runner.spawn`ed session over the fake ACP transport — see
 * `fake-driver.ts`'s own header). Returns whether a spawn actually
 * happened, for logging/tests — mirrors `advanceReviewRequests`/
 * `advanceQaSpawns`'s own `isLive`-before-`spawn` idiom.
 */
export async function ensureArchitectSpawned(
  runner: ArchitectSpawner,
  ticket: TicketId,
): Promise<boolean> {
  const agentId = agentIdFor('architect', ticket);
  if (runner.isLive(agentId)) return false;
  await runner.spawn('architect', ticket);
  return true;
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
          await dispatchTurn(runner, messageReviewerId, message.body);
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
 * Re-prompts every live agent whose inbox still holds an unread `resume`
 * (halt released, §5 step 7). The tier-1 halt deny tells the agent to file
 * its standup_report and end its turn; nothing else ever prompted it again
 * — sixteenth live run (2026-09-11): all three engineers reported, the halt
 * released 03:16:34, the `resume` broadcast landed, and the daemon then sat
 * silent for 14 minutes until the watchdog. A busy agent gets the same
 * message through the hook's tier 3 (delivered + acked on its next tool
 * call), so only a copy still unread here is prompted; it is acked either
 * way. An agent that is no longer live is re-spawned with fresh context by
 * `assignReady`, so its copy is just acked. Returns the agents prompted.
 */
export async function advanceResumes(
  store: Pick<StateStore, 'listAgents'>,
  bus: Pick<Bus, 'poll' | 'ack'>,
  runner: ReviewRunner,
  seen: Set<string>,
): Promise<AgentId[]> {
  const prompted: AgentId[] = [];
  for (const { id, record } of store.listAgents()) {
    const agentId = id as AgentId;
    for (const message of bus.poll(agentId)) {
      if (message.kind !== 'resume') continue;
      const key = `${agentId}:${message.id}`;
      if (seen.has(key)) continue;
      if (!runner.isLive(agentId)) {
        seen.add(key);
        await bus.ack(agentId, message.id);
        continue;
      }
      const ticket = record.ticket ? ` ${record.ticket}` : '';
      const text = [
        `${message.body}.`,
        `The halt that blocked you is over. Pick your ticket${ticket} back up where you left off — your worktree is unchanged —`,
        'read the published decision with oracle_get if it names one, and carry on to review_request as usual.',
      ].join('\n');
      try {
        await dispatchTurn(runner, agentId, text);
      } catch {
        continue;
      }
      seen.add(key);
      await bus.ack(agentId, message.id);
      prompted.push(agentId);
    }
  }
  return prompted;
}

/** The slice of `MergeOwner` `advanceMergeConflicts` needs. */
export interface ConflictMerger {
  status(ticket: TicketId): { status?: string; summary?: string } | undefined;
  conflictResolved(ticket: TicketId): boolean;
  retryAfterConflict(ticket: TicketId): Promise<unknown>;
}

/**
 * Drives the merge-conflict fix cycle §15 leaves to "the ticket owner"
 * (design: "conflicts bounce to the ticket owner as a scoped halt").
 * Fourteenth live run (2026-09-11): the halt was raised and that was the
 * end of it — the ticket is `done`, so no glue re-prompts its engineer,
 * and `advanceDoneTickets` never retries a recorded outcome. Now, for each
 * `done` ticket with a `conflict` record: the engineer is prompted once
 * with the summary and told to rebase in its worktree (its still-live
 * session, else a fresh spawn with the text as handoff context — the same
 * pair `advanceEngineerVerdicts` uses); every tick after that, once
 * `conflictResolved` (branch rebased onto current `integration`, clean),
 * the merge is retried. The hook lets that engineer work under its own
 * merge halt (`decide.ts` tier 1). Returns the tickets retried this tick.
 */
export async function advanceMergeConflicts(
  store: Pick<StateStore, 'listTickets'>,
  runner: EngineerRunner,
  merger: ConflictMerger,
  prompted: Set<TicketId>,
): Promise<TicketId[]> {
  const retried: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    if (ticket.status !== 'done') continue;
    const record = merger.status(ticket.id);
    if (record?.status !== 'conflict') continue;
    if (merger.conflictResolved(ticket.id)) {
      prompted.delete(ticket.id);
      try {
        await merger.retryAfterConflict(ticket.id);
      } catch {
        // A retry that throws (worktree vanished, git error) leaves the
        // conflict record in place; the next tick sees the same state and
        // tries again — the retry contract every other step here uses.
        continue;
      }
      retried.push(ticket.id);
      continue;
    }
    if (prompted.has(ticket.id)) continue;
    const engineerId = agentIdFor('engineer', ticket.id);
    const text = [
      `${ticket.id} passed review and QA but could not be merged: ${record.summary ?? 'merge conflict'}.`,
      `In your worktree, run \`git rebase integration\`, resolve every conflict keeping both tickets' intent,`,
      'run the tests, and finish the rebase (`git -c core.editor=true rebase --continue`) so the branch is clean and on top of integration.',
      'The daemon retries the merge on its own once the branch is rebased; do not open a review request.',
    ].join('\n');
    try {
      if (runner.isLive(engineerId)) {
        await dispatchTurn(runner, engineerId, text);
      } else {
        await runner.spawn('engineer', ticket.id, { extraContext: text });
      }
    } catch {
      continue;
    }
    prompted.add(ticket.id);
  }
  return retried;
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

/**
 * The slice of `Runner` `advanceEngineerVerdicts` needs: re-prompt a live
 * engineer session, or spawn a fresh one carrying the verdict as handoff
 * context when the original session is gone (liveness-reaped, crashed).
 */
export interface EngineerRunner extends ReviewRunner {
  spawn(role: 'engineer', ticket: TicketId, opts?: { extraContext?: string }): Promise<unknown>;
}

/** Finding severities a verdict body can name — only used to phrase the re-prompt. */
const REWORK_KINDS = new Set(['review_verdict', 'qa_verdict']);

/**
 * The fourth hand-off the first live run exposed (2026-09-10): a verdict
 * that sends a ticket back to `in_progress` (`ReviewProtocol.
 * applyRequestChanges`, `QaProtocol.submit` on a failed round) lands as a
 * `review_verdict`/`qa_verdict` message in the engineer's inbox — and
 * nothing ever prompted the engineer again. An ACP session is prompted
 * once, at spawn (`session.ts`); the engineer ends its turn after sending
 * `review_request`, sits idle, and five minutes later the liveness sweep
 * reaped it (`bus.ts` `checkLiveness`) and the EM re-spawned it cold with
 * no memory of the review. In `--fake` mode `run.ts`'s scripted driver
 * plays the fix turn itself, which is why the offline e2e never saw this.
 *
 * For every unread rework verdict whose ticket is back in `in_progress`:
 * re-prompt the still-live engineer session with the verdict (the message
 * body is a pointer — the review record path is in `refs`, `review_get`
 * reads it), or spawn a fresh engineer with the verdict as handoff context
 * when the session is gone. Verdicts that don't ask for rework (an approve
 * that moved the ticket to `in_qa`, a QA pass to `done`) are acked without
 * a prompt — the engineer is idle by design while another role works.
 * `seen` is the caller's once-per-process idempotency set, same pattern as
 * the other glue functions here.
 */
export async function advanceEngineerVerdicts(
  store: Pick<StateStore, 'listTickets' | 'getTicket'>,
  bus: Pick<Bus, 'poll' | 'ack'>,
  runner: EngineerRunner,
  seen: Set<string>,
): Promise<TicketId[]> {
  const prompted: TicketId[] = [];
  for (const ticket of store.listTickets()) {
    const engineerId = agentIdFor('engineer', ticket.id);
    for (const message of bus.poll(engineerId)) {
      if (!REWORK_KINDS.has(message.kind) || !message.ticket) continue;
      const key = `${message.ticket}:${message.id}`;
      if (seen.has(key)) continue;
      const current = store.getTicket(message.ticket);
      if (current.status !== 'in_progress') {
        // Not a rework verdict (approve -> in_qa, pass -> done): nothing to
        // re-prompt; just take it off the engineer's unread pile.
        seen.add(key);
        await bus.ack(engineerId, message.id);
        continue;
      }
      const refs = message.refs.length > 0 ? `\nRecord(s): ${message.refs.join(', ')}` : '';
      const text = [
        `${message.kind === 'review_verdict' ? 'Review' : 'QA'} verdict on ${message.ticket} sent it back to you: ${message.body}${refs}`,
        'Read the record (review_get for a review round), fix every finding in your worktree, commit,',
        'post a `review_submitted` board stanza, then bus_send a new `review_request` to the reviewer.',
        'Dispute a finding with review_dispute instead of arguing in prose.',
      ].join('\n');
      try {
        if (runner.isLive(engineerId)) {
          await dispatchTurn(runner, engineerId, text);
        } else {
          await runner.spawn('engineer', message.ticket, { extraContext: text });
        }
      } catch {
        // Session died between isLive and the prompt, or the spawn failed:
        // leave the message unread and unseen so the next tick retries —
        // the same retry contract `advanceReviewRequests` documents.
        continue;
      }
      seen.add(key);
      prompted.push(message.ticket);
      await bus.ack(engineerId, message.id);
    }
  }
  return prompted;
}

/** The slice of `GateService` `advanceHilResolutions` needs. */
export interface HilLister {
  list(): Array<{
    id: string;
    gate: string;
    ticket?: TicketId;
    status: 'pending' | 'resolved';
    decision?: 'approve' | 'deny';
    decided_by?: string;
    summary?: string;
    fyi?: { body: string };
  }>;
}

/**
 * Fifth hand-off (first live runs, 2026-09-10): the PreToolUse hook denies a
 * never-without-human command *naming* an `unblock` `hil_request` and moves
 * on — Claude only ever sees the hook's stdout, so the engineer gets "filed
 * HIL-…" and nothing else, ever. Once that request is resolved (by a human
 * via `agile approve`, or by the EM delegate) somebody has to tell the
 * session. This re-prompts the ticket's live engineer with the outcome:
 * approved → re-run the command; denied → the rationale, find another way.
 * Only `unblock` requests (the hook's) are handled here; permission-path
 * requests (`permission:<role>`) are answered on the ACP request itself by
 * the responder. `seen` is the caller's once-per-process set.
 */
export async function advanceHilResolutions(
  gates: HilLister,
  runner: ReviewRunner,
  seen: Set<string>,
): Promise<string[]> {
  const prompted: string[] = [];
  for (const req of gates.list()) {
    if (req.status !== 'resolved' || req.gate !== 'unblock' || !req.ticket) continue;
    if (seen.has(req.id)) continue;
    const engineerId = agentIdFor('engineer', req.ticket);
    if (!runner.isLive(engineerId)) {
      // No session to tell. Mark seen: a later engineer spawn reads the
      // board/inbox for context; re-prompting a future session with a
      // stale resolution would be noise.
      seen.add(req.id);
      continue;
    }
    const what = req.summary ? ` (${req.summary})` : '';
    const text =
      req.decision === 'approve'
        ? `${req.id} was APPROVED by ${req.decided_by ?? 'the gate owner'}${what}. You may run that command now — re-run it and continue.${req.fyi?.body ? ` Note: ${req.fyi.body}` : ''}`
        : `${req.id} was DENIED by ${req.decided_by ?? 'the gate owner'}${what}.${req.fyi?.body ? ` ${req.fyi.body}` : ''} Do not retry it; find another way within your worktree, or post a \`blocked\` stanza with the reason.`;
    try {
      await dispatchTurn(runner, engineerId, text);
    } catch {
      continue; // session died between isLive and the prompt — retry next tick.
    }
    seen.add(req.id);
    prompted.push(req.id);
  }
  return prompted;
}

/** The slice of `Runner` `advanceArchitectInbox` needs. */
export interface ArchitectRunner extends ReviewRunner {
  spawn(role: 'architect', ticket: TicketId, opts?: { extraContext?: string }): Promise<unknown>;
}

/**
 * Sixth hand-off: `em/discovery.ts` forwards every `discovery` stanza to the
 * `architect` inbox — and in a live run nobody ever spawned an architect
 * (only `--fake`'s scripted driver called `ensureArchitectSpawned`), so the
 * planted contradiction the engineers found and the reviewers escalated on
 * sat unread. For each unread architect-inbox message: prompt the live
 * architect session with it, or spawn one (T031's singleton, on the
 * message's ticket) carrying the message as handoff context; then ack.
 */
export async function advanceArchitectInbox(
  bus: Pick<Bus, 'poll' | 'ack'>,
  runner: ArchitectRunner,
  seen: Set<string>,
): Promise<string[]> {
  const handled: string[] = [];
  for (const message of bus.poll('architect' as AgentId)) {
    if (seen.has(message.id)) continue;
    if (!message.ticket) {
      seen.add(message.id);
      await bus.ack('architect' as AgentId, message.id);
      continue;
    }
    const refs = message.refs.length > 0 ? `\nRefs: ${message.refs.join(', ')}` : '';
    const text = `${message.kind} from ${message.from} on ${message.ticket}: ${message.body}${refs}`;
    try {
      if (runner.isLive('architect' as AgentId)) {
        await dispatchTurn(runner, 'architect' as AgentId, text);
      } else {
        await runner.spawn('architect', message.ticket, { extraContext: text });
      }
    } catch {
      continue; // retry next tick, same contract as the other glue.
    }
    seen.add(message.id);
    handled.push(message.id);
    await bus.ack('architect' as AgentId, message.id);
  }
  return handled;
}

/** The slice of `Runner` `advanceSecurityReviews` needs. */
export interface SecurityReviewRunner {
  isLive(agentId: AgentId): boolean;
  spawn(
    role: 'reviewer',
    ticket: TicketId,
    opts?: { agentId?: AgentId; extraContext?: string },
  ): Promise<unknown>;
}

/** Mirrors `ReviewProtocol.requiresSecurityPass` (not imported: `review/protocol.ts` imports this package). */
function needsSecurityPass(ticket: { security?: boolean; estimate?: { tier?: string } }): boolean {
  return (
    ticket.security === true ||
    ticket.estimate?.tier === 'hard' ||
    ticket.estimate?.tier === 'novel'
  );
}

/**
 * Seventh hand-off (fifth live run, 2026-09-10): a ticket the architect
 * pointed `hard`/`novel` (or tagged `security`) needs BOTH a primary and a
 * security `approve`, from two different reviewer ids, before
 * `ReviewProtocol.applyApprove` moves it to `in_qa` — and nothing ever
 * spawned the second reviewer (`applyApprove`'s own doc comment: "an EM/
 * orchestration-layer concern"). TKT-1003 sat `in_review` with a primary
 * approve until the liveness sweep reaped its idle reviewer. For every
 * `in_review` ticket that needs the pass, has a primary record for the
 * latest round with verdict `approve`, and has no security record yet:
 * spawn `reviewer-sec-<digits>` on the same worktree with the mandate in
 * its handoff context, once per ticket+round.
 */
export async function advanceSecurityReviews(
  store: Pick<StateStore, 'listTickets' | 'getEntity'>,
  runner: SecurityReviewRunner,
  seen: Set<string>,
): Promise<TicketId[]> {
  const spawned: TicketId[] = [];
  const record = (ticket: TicketId, round: number, pass: 'primary' | 'security') => {
    try {
      return store.getEntity(reviewRecordRelPath(ticket, round, pass), validateReviewRecord);
    } catch {
      return undefined;
    }
  };
  for (const ticket of store.listTickets()) {
    if (ticket.status !== 'in_review' || !needsSecurityPass(ticket)) continue;
    // Latest primary round with a record.
    let round = 0;
    while (record(ticket.id, round + 1, 'primary') !== undefined) round++;
    if (round === 0) continue;
    const primary = record(ticket.id, round, 'primary');
    if (primary?.verdict !== 'approve') continue;
    if (record(ticket.id, round, 'security') !== undefined) continue;
    const key = `${ticket.id}:${round}`;
    if (seen.has(key)) continue;
    const agentId = securityReviewerIdFor(ticket.id);
    if (runner.isLive(agentId)) {
      seen.add(key);
      continue;
    }
    try {
      await runner.spawn('reviewer', ticket.id, {
        agentId,
        extraContext: [
          `You are the SECURITY-pass reviewer for ${ticket.id} (round ${round}). A primary reviewer (${primary.agent}) has already approved this round; the ticket cannot move on until a second, independent reviewer has ruled on its security posture.`,
          'Review the diff for injection, path traversal, secrets, unsafe deserialisation, permission/trust boundaries, and dependency risk — not style. Then submit with review_submit using `pass: "security"` (this is what distinguishes your record from the primary one), the same `round`, and your findings/verdict.',
        ].join('\n'),
      });
    } catch {
      continue; // retry next tick, same contract as the other glue.
    }
    seen.add(key);
    spawned.push(ticket.id);
  }
  return spawned;
}

/** The slice of `Runner` the stale-ticket glue needs. */
export interface StaleTicketRunner {
  isLive(agentId: AgentId): boolean;
  stop(agentId: AgentId): boolean;
}

/** The store slice `advanceReviewerEscalations` needs. */
export type EscalationStore = Pick<StateStore, 'getTicket' | 'transitionTicket'>;

/**
 * Eighth hand-off (fifth live run, 2026-09-10): a reviewer's `escalate`
 * verdict ("the ticket/contract is wrong, not the code", §12) lands as an
 * `escalate` message in `em`'s inbox and stops there — the EM is a brief,
 * not a session; `EmLoop` only forwards `discovery` messages. TKT-1003's
 * reviewer escalated round 1 (its one `oracle_refs` entry had been
 * superseded by DEC-1002), then idled until the liveness sweep reaped it,
 * while the architect that already held the answer was never asked.
 *
 * §5's design path for exactly this — a ripple, then "architect
 * re-refines" — is what an escalate maps onto: the ticket goes `stale`
 * (a reviewer's escalate IS the ripple, arrived at by reading), the
 * escalation is forwarded to the architect with the review record as the
 * pointer (`advanceArchitectInbox` prompts/spawns it), and `ticket_refine`
 * readies the ticket again for `assignReady` to reassign into the same
 * worktree. Only a reviewer's escalate on an `in_review` ticket qualifies;
 * the other `escalate` senders (liveness, `applyRequestChanges`' attempts
 * ladder, a session-ended notice) keep their existing "notify em" meaning.
 */
export async function advanceReviewerEscalations(
  store: EscalationStore,
  bus: Pick<Bus, 'poll' | 'ack' | 'send'>,
  seen: Set<string>,
): Promise<TicketId[]> {
  const staled: TicketId[] = [];
  for (const message of bus.poll('em' as AgentId)) {
    if (message.kind !== 'escalate' || !message.ticket) continue;
    if (!message.from.startsWith('reviewer-')) continue;
    if (seen.has(message.id)) continue;
    let ticket: ReturnType<StateStore['getTicket']>;
    try {
      ticket = store.getTicket(message.ticket);
    } catch {
      seen.add(message.id);
      await bus.ack('em' as AgentId, message.id);
      continue;
    }
    if (ticket.status !== 'in_review') {
      // Already moved on (a later round approved, or the ticket was staled
      // by a ripple in the meantime): nothing to route.
      seen.add(message.id);
      await bus.ack('em' as AgentId, message.id);
      continue;
    }
    await store.transitionTicket(ticket.id, 'stale', {
      by: 'daemon',
      reason: `reviewer escalation by ${message.from}: ${message.body}`.slice(0, 300),
    });
    const forwarded = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['architect' as AgentId],
      kind: 'escalate',
      priority: 'urgent',
      ticket: ticket.id,
      body: [
        `${message.from} escalated ${ticket.id} on review: ${message.body}.`,
        `The daemon marked ${ticket.id} stale; its sessions are stopped and the worktree is kept.`,
        'Read the review record (review_get / the ref below), rule on the contract (decision_publish if the oracle must change),',
        `then ticket_refine ${ticket.id} with the corrected contract/oracle_refs — that readies it and the EM reassigns it.`,
      ]
        .join(' ')
        .slice(0, 800),
      refs: message.refs,
      requires_ack: false,
    });
    if (!forwarded.ok) throw new Error(`advanceReviewerEscalations: ${forwarded.reason}`);
    seen.add(message.id);
    staled.push(ticket.id);
    await bus.ack('em' as AgentId, message.id);
  }
  return staled;
}

/**
 * A `stale` ticket's sessions are done: the engineer, the reviewer(s) and
 * QA were briefed against a contract the architect is about to rewrite,
 * and `Runner.spawn` refuses to re-spawn an agent id that is still live —
 * so once `ticket_refine` readies the ticket, `assignReady` would hit
 * "already running" every tick and the ticket would never move (the
 * ripple path staled TKT-1003 with a live engineer on it). Stop them
 * (graceful; `session.ts`'s `finish()` leaves a `stale` ticket alone —
 * only live statuses get readied on exit). Idempotent: a stopped agent id
 * is no longer live on the next tick.
 */
export function releaseStaleTicketSessions(
  store: Pick<StateStore, 'listTickets'>,
  runner: StaleTicketRunner,
): AgentId[] {
  const stopped: AgentId[] = [];
  for (const ticket of store.listTickets()) {
    // `ready` too (seventh live run, 2026-09-10): the architect re-refined
    // both staled tickets within 16 s, before this glue ever saw them
    // `stale`, and the idle engineer sessions from before the ripple kept
    // `assignReady` throwing "already running" for the rest of the run. A
    // `ready` ticket has nobody working it by definition — `Runner.spawn`
    // moves it to `in_progress` before the session is live, `finish()` and
    // the liveness sweep only ready a ticket whose session is gone — so any
    // live session still bound to one is a leftover to stop.
    if (ticket.status !== 'stale' && ticket.status !== 'ready') continue;
    const ids: AgentId[] = [
      agentIdFor('engineer', ticket.id),
      agentIdFor('reviewer', ticket.id),
      securityReviewerIdFor(ticket.id),
      agentIdFor('qa', ticket.id),
    ];
    for (const id of ids) {
      if (!runner.isLive(id)) continue;
      if (runner.stop(id)) stopped.push(id);
    }
  }
  return stopped;
}
