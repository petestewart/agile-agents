/**
 * `GateService` — HIL requests, delegation, and the circuit breaker over a
 * `StateStore` (design/agile-agents-design.md §16 "HIL gates policy", §5
 * "HIL"). `HilRequest`/`BreakerState` are shared zod schemas
 * (`packages/shared/src/hil.ts`); this module owns only the resolution/
 * persistence/notification logic over them. The human reads pending
 * requests off `gates/` (the inbox); the only bus write left is a note
 * delivered to the session parked on a gate (T168).
 *
 * T018 review fix summary (see `.pipeline-review.md` "Independent review
 * (opus)" for the full findings):
 *  1. Entity schemas moved to `packages/shared/src/hil.ts` (this file just imports them).
 *  4. No default delegate: without one injected, a timed-out
 *     `human_timeout` gate stays `pending` with
 *     `reason: "no delegate configured"` instead of auto-approving.
 *  6. `list()`/`tick()`/`get()` read `gates/**` from disk via the new
 *     `StateStore.listEntities`, so they survive a daemon restart — no more
 *     in-process-only index.
 *
 * Finding 5 (RPC param validation) is addressed in `rpc.ts`.
 */

import {
  type AgentId,
  AgentIdSchema,
  type AgentMessage,
  BREAKER_SIGNALS,
  type BreakerSignal,
  type BreakerState,
  type GateCall,
  type GateKind,
  type GateOwner,
  type HilDecision,
  type HilId,
  type HilKind,
  type HilRequest,
  MESSAGE_BODY_MAX_CHARS,
  type Policy,
  type RuleId,
  ulid,
  validateAgentMessage,
  validateBreakerState,
  validateHilRequest,
} from '@agile-agents/shared';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import { parseDurationMs } from './duration';
import { resolveGate } from './resolve';
import { humanTimeoutDuration, isHumanTimeoutOwner } from './types';

const HIL_DIR = 'gates';
// A sibling of `gates/`, deliberately NOT
// nested inside it so `StateStore.listEntities(HIL_DIR, ...)` never
// has to special-case it (review nit).
const BREAKER_PATH = 'breaker.yaml';
const NO_DELEGATE_REASON = 'no delegate configured';
function hilPath(id: HilId): string {
  return `${HIL_DIR}/${id}.yaml`;
}

function newHilId(): HilId {
  return `HIL-${ulid()}` as HilId;
}

/** Trims, caps at the shared message-body cap, and maps blank to `undefined` — the one place a note is normalized before it touches the schema. */
function normalizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim().slice(0, MESSAGE_BODY_MAX_CHARS);
  return trimmed.length === 0 ? undefined : trimmed;
}

function inboxPath(agent: string, messageId: string): string {
  return `bus/inbox/${agent}/${messageId}.yaml`;
}

export interface GateDecision {
  decision: HilDecision;
  by: string;
  rationale?: string;
}

/**
 * Auto-decides a `human_timeout` gate that fell through at its deadline
 * (§16: "tick(now) falls through to the delegate at the deadline"), or a
 * pending gate a human added a note to. No default is provided by this
 * module — see `GateServiceOptions.delegate`'s header (finding 4: fail
 * closed, not open).
 */
export interface DelegateContext {
  gate: GateKind;
  owner: GateOwner;
  /** The stream the gate was raised on (T121) — never a ticket. */
  stream: string;
  hilKind?: HilKind;
  /** What was asked — see `HilRequest.summary`. */
  summary?: string;
  /** Free text the human typed on the card (T039). Present when a note was written without a button press, or when a noted decision is re-delegated. */
  note?: string;
}

/**
 * A delegate may decide inline or asynchronously; an async decision is
 * persisted when its promise settles, unless a human answered first.
 */
export type DelegateFn = (ctx: DelegateContext) => GateDecision | Promise<GateDecision>;

export interface GateServiceOptions {
  clock?: () => Date;
  /**
   * Injectable so tests control auto-decisions. Deliberately optional with
   * NO default implementation (review finding 4): a human-in-the-loop gate
   * must never auto-approve itself just because nobody wired a delegate
   * yet. Without one, a timed-out `human_timeout` request stays `pending`
   * with `reason: "no delegate configured"`.
   */
  delegate?: DelegateFn;
}

export interface GateRequestContext {
  policy: Policy;
  /**
   * T121: the stream this gate is raised on. Required — a gate with no
   * stream has nowhere to show in the inbox (`stream_path` is how the
   * operator tells their eleven things apart, cockpit design §3.2).
   * The per-container gate overrides went with the ceremony layer.
   */
  stream: string;
  /**
   * T048: the agent whose blocked call raised this gate (the hook caller, the
   * ACP session), persisted as `HilRequest.requested_by` and used by
   * `waitingAgent` to deliver the decision back to it. Leave unset for a
   * gate the daemon raises on nobody's behalf — nobody is then waiting on it
   * (T121 deleted the ticket-assignee fallback with the ticket model).
   */
  requestedBy?: AgentId;
  /** What was asked — stored on the record, shown in the notice, handed to the delegate. */
  summary?: string;
  /**
   * T138 (design §8.1 route band): the tool call this gate blocks, and the
   * session that made it. Both are persisted verbatim, because approving a
   * `classifier_review` gate means "this one call, from this one session,
   * once" — the hook matches the fingerprint again on the retry
   * (`hook/route-band.ts`).
   */
  call?: GateCall;
  session?: AgentId;
  /**
   * T151 (§6.3): the classifier rule whose band routed this call. Persisted
   * so the human's answer can be attributed back to the rule
   * (`stats.violated` on a deny).
   */
  rule?: RuleId;
}

/**
 * T151: an approved gate's single allowed retry was already spent. Thrown
 * rather than returned, because the old check-then-write `consume` was not
 * a compare-and-swap: two identical in-flight calls both saw the same
 * approved-and-unconsumed record and were both allowed by one approval
 * (Discovered Issues, T138). The loser of the race now hears about it and
 * falls back to routing.
 */
export class GateAlreadyConsumedError extends Error {
  constructor(id: string) {
    super(`hil request already consumed: ${id}`);
    this.name = 'GateAlreadyConsumedError';
  }
}

export class GateNotFoundError extends Error {
  constructor(id: string) {
    super(`hil request not found: ${id}`);
    this.name = 'GateNotFoundError';
  }
}

export class GateAlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`hil request ${id} is already resolved`);
    this.name = 'GateAlreadyResolvedError';
  }
}

export class NoDelegateConfiguredError extends Error {
  constructor(id: string) {
    super(`hil request ${id} cannot be delegated: no delegate function is configured`);
    this.name = 'NoDelegateConfiguredError';
  }
}

export class EmptyNoteError extends Error {
  constructor(id: string) {
    super(`hil request ${id}: note must not be empty`);
    this.name = 'EmptyNoteError';
  }
}

export class UnknownBreakerSignalError extends Error {
  constructor(signal: string) {
    super(`unknown breaker signal: ${signal}`);
    this.name = 'UnknownBreakerSignalError';
  }
}

export class GateService {
  private readonly clock: () => Date;
  private readonly delegate: DelegateFn | undefined;
  /** Serializes `consume` so the read-decide-write is one critical section (T151). */
  private consumeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    options: GateServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.delegate = options.delegate;
  }

  // ------------------------------------------------------------- Breaker

  private loadBreaker(): BreakerState {
    try {
      return this.store.getEntity(BREAKER_PATH, validateBreakerState);
    } catch (err) {
      if (err instanceof NotFoundError) return { tripped: {} };
      throw err;
    }
  }

  trippedSignals(): BreakerSignal[] {
    const state = this.loadBreaker();
    return Object.keys(state.tripped) as BreakerSignal[];
  }

  /** "force every gate to human until cleared" (§16). */
  async trip(signal: BreakerSignal, detail: string): Promise<BreakerState> {
    if (!(BREAKER_SIGNALS as readonly string[]).includes(signal)) {
      throw new UnknownBreakerSignalError(signal);
    }
    const state = this.loadBreaker();
    const saved = await this.store.putEntity(BREAKER_PATH, validateBreakerState, {
      tripped: { ...state.tripped, [signal]: detail },
    });
    await this.store.appendEvent(buildEvent('breaker_tripped', { data: { signal, detail } }));
    return saved;
  }

  async clear(signal: BreakerSignal): Promise<BreakerState> {
    if (!(BREAKER_SIGNALS as readonly string[]).includes(signal)) {
      throw new UnknownBreakerSignalError(signal);
    }
    const state = this.loadBreaker();
    const tripped = { ...state.tripped };
    delete tripped[signal];
    const saved = await this.store.putEntity(BREAKER_PATH, validateBreakerState, { tripped });
    await this.store.appendEvent(buildEvent('breaker_cleared', { data: { signal } }));
    return saved;
  }

  // ------------------------------------------------------------- Requests

  /**
   * Resolves `gate`'s owner (most-specific-wins, overridden to `human` with
   * a naming `reason` while any breaker is tripped) and opens a `HilRequest`:
   * `human` → pending, no deadline; `human_timeout:<d>` → pending with a
   * deadline. The pending record under `gates/` is what the inbox shows.
   */
  async request(gate: GateKind, ctx: GateRequestContext): Promise<HilRequest> {
    const resolved = resolveGate(gate, ctx);
    const tripped = this.trippedSignals();
    const breakerActive = tripped.length > 0;
    const owner: GateOwner = breakerActive ? 'human' : resolved;
    const breakerReason = breakerActive
      ? `circuit breaker tripped: ${tripped.join(', ')}`
      : undefined;

    const now = this.clock();
    const base: HilRequest = {
      id: newHilId(),
      gate,
      // The gate name and the kind are the same closed set after T121, so
      // they can never drift apart (`GatesBlockSchema` is keyed by it).
      hil_kind: gate,
      stream: ctx.stream,
      owner,
      status: 'pending',
      requested_at: now.toISOString(),
      ...(breakerReason !== undefined ? { reason: breakerReason } : {}),
      ...(ctx.summary !== undefined ? { summary: ctx.summary } : {}),
      ...(ctx.requestedBy !== undefined ? { requested_by: ctx.requestedBy } : {}),
      ...(ctx.call !== undefined ? { call: ctx.call } : {}),
      ...(ctx.session !== undefined ? { session: ctx.session } : {}),
      ...(ctx.rule !== undefined ? { rule: ctx.rule } : {}),
    };

    let record: HilRequest = base; // plain human
    if (isHumanTimeoutOwner(owner)) {
      const deadline = new Date(now.getTime() + parseDurationMs(humanTimeoutDuration(owner)));
      record = { ...base, deadline: deadline.toISOString() };
    }

    const saved = await this.persist(record);
    await this.store.appendEvent(
      buildEvent('gate_raised', {
        stream: saved.stream,
        data: { id: saved.id, gate: saved.gate, owner: saved.owner },
      }),
    );
    return saved;
  }

  /** Async delegate decisions still in flight — `await settled()` in a test or a shutdown path. */
  private readonly inFlight = new Set<Promise<void>>();

  /** Resolves once every async delegate decision started so far has been persisted (or failed closed). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private settleLater(pending: HilRequest, deciding: Promise<GateDecision>, via: string): void {
    const task = (async () => {
      let decision: GateDecision;
      try {
        decision = await deciding;
      } catch (err) {
        // Fail closed: a delegate that crashes or times out denies, with the
        // failure as the rationale, rather than leaving the request pending
        // forever with nobody to answer it.
        decision = {
          decision: 'deny',
          by: pending.owner,
          rationale: `delegate failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      let current: HilRequest;
      try {
        current = this.get(pending.id);
      } catch {
        return; // request vanished (state reset) — nothing to resolve.
      }
      if (current.status !== 'pending') return; // a human answered first — theirs stands.
      const { reason: _reason, ...withoutReason } = current;
      const resolved = this.finalizeDecision(withoutReason, decision, this.clock(), via);
      const saved = await this.persist(resolved);
      await this.notifyResolved(saved);
    })().catch(() => {
      // Persist/notify failures are logged by the store; never unhandled here.
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private callDelegate(base: HilRequest): GateDecision | Promise<GateDecision> {
    const delegate = this.delegate;
    if (!delegate) throw new NoDelegateConfiguredError(base.id);
    return delegate({
      gate: base.gate,
      owner: base.owner,
      stream: base.stream,
      hilKind: base.hil_kind,
      summary: base.summary,
      note: base.note,
    });
  }

  private async autoDecide(base: HilRequest, now: Date, via: string): Promise<HilRequest> {
    return this.finalizeDecision(base, await this.callDelegate(base), now, via);
  }

  private finalizeDecision(
    base: HilRequest,
    decision: GateDecision,
    now: Date,
    via: string,
  ): HilRequest {
    // A resolved record carries no live deadline (review nit) — drop the key
    // entirely rather than setting it `undefined`, so yaml/json round-trip
    // never has to reason about an explicit-undefined field.
    const { deadline: _deadline, ...withoutDeadline } = base;
    return {
      ...withoutDeadline,
      status: 'resolved',
      decision: decision.decision,
      decided_by: decision.by,
      resolved_at: now.toISOString(),
      delegated: true,
      fyi: {
        to: 'human',
        body: `gate "${base.gate}" ${decision.decision === 'approve' ? 'approved' : 'denied'} by ${decision.by} (${via}, owner: ${base.owner})${decision.rationale ? ` — ${decision.rationale}` : ''}`,
        sent_at: now.toISOString(),
      },
    };
  }

  private async persist(record: HilRequest): Promise<HilRequest> {
    return this.store.putEntity(hilPath(record.id), validateHilRequest, record);
  }

  private async notifyResolved(req: HilRequest): Promise<void> {
    if (!req.delegated) return;
    await this.store.appendEvent(
      buildEvent('gate_resolved', {
        stream: req.stream,
        agent: req.decided_by,
        data: {
          id: req.id,
          decision: req.decision,
          ...(req.note !== undefined ? { note: req.note } : {}),
        },
      }),
    );
    // T039 review round 1 (blocker): a request resolved through the delegate
    // path (`addNote` or a `human_timeout` fallthrough) delivers its note to
    // the waiting agent exactly as `respond()` does.
    if (req.note !== undefined) {
      await this.deliverNote(
        req,
        req.decided_by ?? req.owner,
        `gate "${req.gate}" ${req.decision === 'approve' ? 'approved' : 'denied'} by ${req.decided_by ?? req.owner}`,
      );
    }
  }

  /**
   * A human (or anyone acting as the resolved owner) answers a pending
   * request directly. `note` is the free text typed on the Needs-you card
   * (T039, §17 "Control room v2"): it is persisted on the record, carried on
   * the `gate_resolved` event, and delivered as an `hil_response` bus message
   * to the agent that is waiting on the gate.
   */
  async respond(id: HilId, decision: HilDecision, by: string, note?: string): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    const trimmed = normalizeNote(note);
    const now = this.clock();
    const { deadline: _deadline, ...withoutDeadline } = current;
    const saved = await this.persist({
      ...withoutDeadline,
      status: 'resolved',
      decision,
      decided_by: by,
      resolved_at: now.toISOString(),
      ...(trimmed !== undefined ? { note: trimmed } : {}),
    });
    await this.store.appendEvent(
      buildEvent('gate_resolved', {
        stream: saved.stream,
        agent: by,
        data: {
          id: saved.id,
          decision: saved.decision,
          ...(saved.note !== undefined ? { note: saved.note } : {}),
        },
      }),
    );
    if (saved.note !== undefined) {
      await this.deliverNote(
        saved,
        by,
        `gate "${saved.gate}" ${saved.decision === 'approve' ? 'approved' : 'denied'} by ${by}`,
      );
    }
    return saved;
  }

  /**
   * A typed answer with no button press (T039, §17 "Control room v2"): the
   * note is stored on the still-`pending` request and, when a delegate is
   * configured, handed to it as a fresh delegate call carrying the note.
   * **It never resolves the gate by itself**; the delegate's approve/deny
   * (or a later button press) does. The waiting agent hears the note once
   * the gate is decided.
   */
  async addNote(id: HilId, note: string, by: string): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    const trimmed = normalizeNote(note);
    if (trimmed === undefined) throw new EmptyNoteError(id);
    const saved = await this.persist({ ...current, note: trimmed });
    if (this.delegate) {
      const outcome = this.callDelegate(saved);
      const deciding = outcome instanceof Promise ? outcome : Promise.resolve(outcome);
      this.settleLater(saved, deciding, 'human note');
    }
    return saved;
  }

  /**
   * Writes the note into the waiting agent's inbox (the session whose hook
   * or ACP call raised the gate) as a normal-priority `hil_response`, which
   * its next hook injects as additional context. A gate nobody is waiting
   * on has nobody to deliver to.
   */
  private async deliverNote(req: HilRequest, by: string, headline: string): Promise<void> {
    if (req.note === undefined) return;
    const waiting = this.waitingAgent(req);
    if (waiting === undefined) return;

    /**
     * T048: the raising agent gets a message written *to* it — "your gate was
     * decided, retry your call". It deliberately does not repeat
     * `req.summary` (the whole blocked command, already body-capped once on
     * the record): the agent knows what it just tried.
     */
    const decided =
      req.decision === 'approve' ? 'approved' : req.decision === 'deny' ? 'denied' : undefined;
    const body = (
      decided === undefined
        ? `${headline} — ${by} wrote: ${req.note}`
        : `your gate "${req.gate}" was ${decided} by ${by} — ${by} wrote: ${req.note}. Retry the call it blocked.`
    ).slice(0, MESSAGE_BODY_MAX_CHARS);
    // `by` is a free string on the wire (`--by pete`); only use it as the
    // message's `from` when it is actually a valid agent id, else attribute
    // the note to `human` (the card it was typed on).
    const from: AgentId = AgentIdSchema.safeParse(by).success ? (by as AgentId) : 'human';
    const message: AgentMessage = validateAgentMessage({
      id: ulid(),
      ts: this.clock().toISOString(),
      from,
      to: [waiting],
      kind: 'hil_response',
      priority: 'normal',
      body,
      refs: [hilPath(req.id)],
    });
    await this.store.putEntity(inboxPath(waiting, message.id), validateAgentMessage, message);
  }

  /**
   * The agent waiting on this gate: `requested_by` (T048) — the hook caller
   * or the ACP session whose call is parked on this decision — and nothing
   * else. T121 deleted the ticket-assignee fallback along with the ticket
   * model: the delivery key is now the stream plus the session that raised
   * the gate, so a gate the daemon raised on nobody's behalf simply has
   * nobody to deliver to.
   */
  private waitingAgent(req: HilRequest): AgentId | undefined {
    return req.requested_by;
  }

  /**
   * Falls every pending `human_timeout:<d>` request whose deadline has
   * passed through to the delegate ("proceed as the fallback owner would",
   * §16) — exactly at the deadline, not before (T018 acceptance). Without a
   * configured delegate, a due request stays `pending` with
   * `reason: "no delegate configured"` instead of silently resolving
   * (finding 4) and is not counted as "fallen through".
   */
  async tick(now: Date = this.clock()): Promise<HilRequest[]> {
    const fallenThrough: HilRequest[] = [];
    for (const req of this.list()) {
      if (req.status !== 'pending' || !req.deadline || !isHumanTimeoutOwner(req.owner)) continue;
      if (new Date(req.deadline).getTime() > now.getTime()) continue;

      if (!this.delegate) {
        if (req.reason !== NO_DELEGATE_REASON) {
          await this.persist({ ...req, reason: NO_DELEGATE_REASON });
        }
        continue;
      }

      const resolved = await this.autoDecide(req, now, 'human_timeout fallthrough');
      const saved = await this.persist(resolved);
      await this.notifyResolved(saved);
      fallenThrough.push(saved);
    }
    return fallenThrough;
  }

  /**
   * Spends an approved `classifier_review` gate's single allowed retry
   * (T138). The allowance is once, not standing: the hook calls this in the
   * same breath as the `allow` it renders, so a second attempt at the same
   * call is routed again rather than waved through.
   */
  async consume(id: HilId): Promise<HilRequest> {
    const run = this.consumeChain.then(async () => {
      // Re-read *inside* the critical section: the caller's own check
      // (`route-band.ts` looks for an approved, unconsumed gate) happened
      // before this await, so it is the read here that decides.
      const current = this.get(id);
      if (current.consumed_at !== undefined) throw new GateAlreadyConsumedError(id);
      return this.persist({ ...current, consumed_at: this.clock().toISOString() });
    });
    // Keep the chain alive even when one consume rejects (same shape as the
    // store's own mutex).
    this.consumeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get(id: HilId): HilRequest {
    try {
      return this.store.getEntity(hilPath(id), validateHilRequest);
    } catch (err) {
      if (err instanceof NotFoundError) throw new GateNotFoundError(id);
      throw err;
    }
  }

  /** Durable: reads `gates/**` fresh from disk every call (review finding 6). */
  list(): HilRequest[] {
    return this.store.listEntities(HIL_DIR, validateHilRequest);
  }
}
