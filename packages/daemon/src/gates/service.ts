/**
 * `GateService`: HIL requests, delegation and the circuit breaker over a
 * `StateStore`. The schemas are shared (`packages/shared/src/hil.ts`);
 * this module owns resolution, persistence and notification. Pending
 * requests live under `gates/` (read fresh from disk, so they survive a
 * restart) and the inbox shows them; the only bus write left is a note
 * delivered to the session parked on a gate.
 *
 * There is no default delegate: without one, a timed-out `human_timeout`
 * gate stays `pending` with `reason: "no delegate configured"` rather than
 * auto-approving.
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
  type KnowledgeId,
  MESSAGE_BODY_MAX_CHARS,
  type Policy,
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
// A sibling of `gates/`, not inside it, so `listEntities(HIL_DIR)` needn't skip it.
const BREAKER_PATH = 'breaker.yaml';
const NO_DELEGATE_REASON = 'no delegate configured';
function hilPath(id: HilId): string {
  return `${HIL_DIR}/${id}.yaml`;
}

function newHilId(): HilId {
  return `HIL-${ulid()}` as HilId;
}

/** Trims, caps at the message-body cap, maps blank to `undefined`. */
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
 * What the delegate sees: a `human_timeout` gate at its deadline, or a
 * pending gate a human added a note to.
 */
export interface DelegateContext {
  gate: GateKind;
  owner: GateOwner;
  /** The stream the gate was raised on. */
  stream: string;
  hilKind?: HilKind;
  /** What was asked (`HilRequest.summary`). */
  summary?: string;
  /** The human's note: written without a button press, or carried by a re-delegated decision. */
  note?: string;
}

/**
 * A delegate may decide inline or asynchronously; an async decision is
 * persisted when its promise settles, unless a human answered first.
 */
export type DelegateFn = (ctx: DelegateContext) => GateDecision | Promise<GateDecision>;

export interface GateServiceOptions {
  clock?: () => Date;
  /** Injectable, with no default: a human gate must never approve itself because nobody wired a delegate. */
  delegate?: DelegateFn;
}

export interface GateRequestContext {
  policy: Policy;
  /** The stream this gate is raised on: required, or it has nowhere to show in the inbox (§3.2). */
  stream: string;
  /**
   * The agent whose blocked call raised this gate (`HilRequest.requested_by`),
   * to deliver the decision back to. Unset for a gate raised on nobody's behalf.
   */
  requestedBy?: AgentId;
  /** What was asked: stored, shown, handed to the delegate. */
  summary?: string;
  /**
   * The route band (§8.1): the blocked tool call and its session, persisted
   * verbatim because an approval means "this one call, from this session,
   * once" (the hook matches the fingerprint on the retry).
   */
  call?: GateCall;
  session?: AgentId;
  /** The classifier rule whose band routed this call, so the answer is attributed back (§6.3). */
  rule?: KnowledgeId;
}

/**
 * An approved gate's single retry was already spent. Thrown, so that of
 * two identical in-flight calls only one is allowed by one approval; the
 * loser falls back to routing.
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
  /** Serializes `consume` so its read-decide-write is one critical section. */
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
      // The gate and kind are the same closed set, so they can never drift apart.
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

  /** Async delegate decisions in flight. */
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
        // Fail closed: a delegate that crashes or times out denies, rather
        // than leaving the request pending with nobody to answer it.
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
        return; // vanished (state reset)
      }
      if (current.status !== 'pending') return; // a human answered first: theirs stands
      const { reason: _reason, ...withoutReason } = current;
      const resolved = this.finalizeDecision(withoutReason, decision, this.clock(), via);
      const saved = await this.persist(resolved);
      await this.notifyResolved(saved);
    })().catch(() => {
      // Never unhandled.
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
    // A resolved record has no live deadline: drop the key, not `undefined`.
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
    await this.announce(req, req.decided_by ?? req.owner);
  }

  /** The `gate_resolved` event and, when the human wrote one, the note to the waiting agent. */
  private async announce(req: HilRequest, by: string): Promise<void> {
    await this.store.appendEvent(
      buildEvent('gate_resolved', {
        stream: req.stream,
        agent: by,
        data: {
          id: req.id,
          decision: req.decision,
          ...(req.note !== undefined ? { note: req.note } : {}),
        },
      }),
    );
    if (req.note !== undefined) {
      await this.deliverNote(
        req,
        by,
        `gate "${req.gate}" ${req.decision === 'approve' ? 'approved' : 'denied'} by ${by}`,
      );
    }
  }

  /**
   * A human (or the resolved owner) answers a pending request. `note`, the
   * card's free text, is persisted, carried on the event and delivered to
   * the waiting agent.
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
    await this.announce(saved, by);
    return saved;
  }

  /**
   * A typed answer with no button press: stored on the still-pending
   * request and handed to the delegate, if any. It never resolves the gate
   * itself; the waiting agent hears it once the gate is decided.
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
   * Writes the note into the waiting agent's inbox as a normal-priority
   * `hil_response`, which its next hook injects as context.
   */
  private async deliverNote(req: HilRequest, by: string, headline: string): Promise<void> {
    if (req.note === undefined) return;
    const waiting = req.requested_by;
    if (waiting === undefined) return;

    // Addressed to the agent ("retry your call"), without repeating the
    // blocked command it already knows.
    const decided =
      req.decision === 'approve' ? 'approved' : req.decision === 'deny' ? 'denied' : undefined;
    const body = (
      decided === undefined
        ? `${headline} — ${by} wrote: ${req.note}`
        : `your gate "${req.gate}" was ${decided} by ${by} — ${by} wrote: ${req.note}. Retry the call it blocked.`
    ).slice(0, MESSAGE_BODY_MAX_CHARS);
    // `by` is free text (`--by pete`): use it as `from` only when it is a valid agent id.
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
   * Falls every pending `human_timeout:<d>` request at or past its deadline
   * through to the delegate. Without one, it stays `pending` with
   * `reason: "no delegate configured"` and does not count as fallen through.
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
   * Spends an approved `classifier_review` gate's single retry. Once, not
   * standing: a second attempt at the same call is routed again.
   */
  async consume(id: HilId): Promise<HilRequest> {
    const run = this.consumeChain.then(async () => {
      // Re-read inside the critical section: this read decides, not the caller's.
      const current = this.get(id);
      if (current.consumed_at !== undefined) throw new GateAlreadyConsumedError(id);
      return this.persist({ ...current, consumed_at: this.clock().toISOString() });
    });
    // Keep the chain alive when one consume rejects.
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

  /** Durable: reads `gates/**` fresh from disk every call. */
  list(): HilRequest[] {
    return this.store.listEntities(HIL_DIR, validateHilRequest);
  }
}
