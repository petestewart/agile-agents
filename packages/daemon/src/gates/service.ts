/**
 * `GateService` — HIL requests, delegation, and the circuit breaker over a
 * `StateStore` (design/agile-agents-design.md §16 "HIL gates policy", §5
 * "HIL"). `HilRequest`/`BreakerState` are shared zod schemas
 * (`packages/shared/src/hil.ts`); this module owns only the resolution/
 * persistence/bus-notification logic over them.
 *
 * T018 review fix summary (see `.pipeline-review.md` "Independent review
 * (opus)" for the full findings):
 *  1. Entity schemas moved to `packages/shared/src/hil.ts` (this file just imports them).
 *  2/3. `request()` now requires a `hilKind` and writes real bus messages —
 *       an urgent `hil_request` for every pending outcome, a low-priority
 *       `fyi` for every delegated decision — to `bus/inbox/human/<ulid>.yaml`
 *       via the store's generic entity trio (T006's own layout).
 *  4. No default delegate: without one injected, an `em`/`architect`-owned
 *     gate (or a timed-out `human_timeout` gate) stays `pending` with
 *     `reason: "no delegate configured"` instead of auto-approving.
 *  6. `list()`/`tick()`/`get()` read `board/hil/**` from disk via the new
 *     `StateStore.listEntities`, so they survive a daemon restart — no more
 *     in-process-only index.
 *
 * Finding 5 (RPC param validation) is addressed in `rpc.ts`.
 */

import {
  type AgentId,
  AgentIdSchema,
  BREAKER_SIGNALS,
  type BreakerSignal,
  type BreakerState,
  type GateOwner,
  type GatesBlock,
  type HilDecision,
  type HilId,
  type HilKind,
  type HilRequest,
  MESSAGE_BODY_MAX_CHARS,
  type Message,
  type Policy,
  type TicketId,
  ulid,
  validateBreakerState,
  validateHilRequest,
  validateMessage,
} from '@agile-agents/shared';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import { parseDurationMs } from './duration';
import { resolveGate } from './resolve';
import { humanTimeoutDuration, isHumanTimeoutOwner } from './types';

const HIL_DIR = 'board/hil';
// Sibling of board/hil/, board/halts/, board/status/ — deliberately NOT
// nested under board/hil/ so `StateStore.listEntities(HIL_DIR, ...)` never
// has to special-case it (review nit).
const BREAKER_PATH = 'board/breaker.yaml';
const NO_DELEGATE_REASON = 'no delegate configured';
/** `reason` on a pending request an async delegate is still deciding. */
export const DELEGATE_DECIDING_REASON = 'delegate deciding';
// §5 "HIL": every hil_request message needs a deadline. A plain `human`
// owner has no HIL deadline semantics of its own (§16 only defines one for
// `human_timeout`), so a generous, non-enforced default is used purely to
// satisfy MessageSchema's contract for bus delivery/redelivery bookkeeping.
// DESIGN-GAP: not specified anywhere in the design.
const DEFAULT_MESSAGE_DEADLINE_MS = parseDurationMs('7d');

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
 * Auto-decides an `em`/`architect`-owned gate, or a `human_timeout` gate
 * that fell through at its deadline (§16: "tick(now) falls through to the
 * delegate at the deadline" reuses the same delegation logic as a
 * policy-delegated owner). No default is provided by this module — see
 * `GateServiceOptions.delegate`'s header (finding 4: fail closed, not open).
 */
export interface DelegateContext {
  gate: string;
  owner: GateOwner;
  ticket?: TicketId;
  hilKind?: HilKind;
  /** What was asked — see `HilRequest.summary`. */
  summary?: string;
  /** Free text the human typed on the card (T039). Present when a note was written without a button press, or when a noted decision is re-delegated. */
  note?: string;
}

/**
 * A synchronous delegate decides inline (the request is persisted already
 * resolved — every existing test/`--fake` delegate). An async one (the EM
 * session delegate, `em/delegate.ts`) is persisted `pending` with
 * `reason: "delegate deciding"` and resolved when its promise settles —
 * the hook that raised it must answer Claude within its own 5 s timeout
 * and cannot wait on a model turn.
 */
export type DelegateFn = (ctx: DelegateContext) => GateDecision | Promise<GateDecision>;

export interface GateServiceOptions {
  clock?: () => Date;
  /**
   * Injectable so tests (and, eventually, the EM/architect adapters) control
   * auto-decisions. Deliberately optional with NO default implementation
   * (review finding 4): a human-in-the-loop gate must never auto-approve
   * itself just because nobody wired a delegate yet. Without one, an
   * `em`/`architect`-owned request (or a timed-out `human_timeout` one)
   * stays `pending` with `reason: "no delegate configured"`.
   */
  delegate?: DelegateFn;
}

export interface GateRequestContext {
  policy: Policy;
  sprint?: GatesBlock;
  epic?: GatesBlock;
  team?: GatesBlock;
  ticket?: TicketId;
  /** `hil_request` kind (§5 "HIL"): approve_decision | steer | demo | unblock. Required. */
  hilKind: HilKind;
  /** Who to attribute the resulting bus message to. Defaults to `'daemon'`. */
  from?: AgentId;
  /** What was asked — stored on the record, shown in the notice, handed to the delegate. */
  summary?: string;
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
   * deadline; `em`/`architect` → immediately auto-decided via `delegate`
   * when one is configured (decision artifact + `fyi` bus message), else
   * left `pending` with `reason: "no delegate configured"`. Every pending
   * outcome also writes an urgent `hil_request` bus message to the human's
   * inbox (§5 "HIL").
   */
  async request(gate: string, ctx: GateRequestContext): Promise<HilRequest> {
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
      hil_kind: ctx.hilKind,
      ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}),
      owner,
      status: 'pending',
      requested_at: now.toISOString(),
      ...(breakerReason !== undefined ? { reason: breakerReason } : {}),
      ...(ctx.summary !== undefined ? { summary: ctx.summary } : {}),
    };

    let record: HilRequest;
    let deciding: Promise<GateDecision> | undefined;
    if (owner === 'em' || owner === 'architect') {
      if (!this.delegate) {
        record = { ...base, reason: base.reason ?? NO_DELEGATE_REASON };
      } else {
        const outcome = this.callDelegate(base);
        if (outcome instanceof Promise) {
          record = { ...base, reason: DELEGATE_DECIDING_REASON };
          deciding = outcome;
        } else {
          record = this.finalizeDecision(base, outcome, now, 'gate policy');
        }
      }
    } else if (isHumanTimeoutOwner(owner)) {
      const deadline = new Date(now.getTime() + parseDurationMs(humanTimeoutDuration(owner)));
      record = { ...base, deadline: deadline.toISOString() };
    } else {
      record = base; // plain human
    }

    const saved = await this.persist(record);
    await this.store.appendEvent(
      buildEvent('hil_requested', {
        ...(saved.ticket !== undefined ? { ticket: saved.ticket } : {}),
        data: { id: saved.id, gate: saved.gate, owner: saved.owner },
      }),
    );

    if (saved.status === 'resolved') {
      await this.notifyResolved(saved);
    } else {
      await this.notifyPending(saved, ctx.from ?? 'daemon');
    }
    if (deciding) this.settleLater(saved, deciding, 'gate policy');
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
      ticket: base.ticket,
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

  private async notifyPending(req: HilRequest, from: AgentId): Promise<void> {
    const deadline =
      req.deadline ??
      new Date(new Date(req.requested_at).getTime() + DEFAULT_MESSAGE_DEADLINE_MS).toISOString();
    const message: Message = {
      id: ulid(),
      ts: req.requested_at,
      from,
      to: ['human'],
      kind: 'hil_request',
      priority: 'urgent',
      ...(req.ticket !== undefined ? { ticket: req.ticket } : {}),
      body: `gate "${req.gate}" needs a human decision (${req.hil_kind})${req.summary ? `: ${req.summary}` : ''}${req.reason ? ` — ${req.reason}` : ''}`.slice(
        0,
        MESSAGE_BODY_MAX_CHARS,
      ),
      refs: [hilPath(req.id)],
      requires_ack: true,
      deadline,
      hil_kind: req.hil_kind,
    };
    const validated = validateMessage(message);
    await this.store.putEntity(inboxPath('human', validated.id), validateMessage, validated);
  }

  private async notifyResolved(req: HilRequest): Promise<void> {
    if (!req.delegated || !req.fyi) return;
    const message: Message = {
      id: ulid(),
      ts: req.fyi.sent_at,
      from: 'daemon',
      to: ['human'],
      kind: 'fyi',
      priority: 'low',
      ...(req.ticket !== undefined ? { ticket: req.ticket } : {}),
      body: req.fyi.body,
      refs: [hilPath(req.id)],
      requires_ack: false,
    };
    const validated = validateMessage(message);
    await this.store.putEntity(inboxPath('human', validated.id), validateMessage, validated);
    await this.store.appendEvent(
      buildEvent('hil_resolved', {
        ...(req.ticket !== undefined ? { ticket: req.ticket } : {}),
        agent: req.decided_by,
        data: {
          id: req.id,
          decision: req.decision,
          ...(req.note !== undefined ? { note: req.note } : {}),
        },
      }),
    );
    // T039 review round 1 (blocker): a request resolved through the delegate
    // path (`addNote` -> EM decides, single-instance delegation, or a
    // `human_timeout` fallthrough) used to send only the human `fyi` above,
    // so the agent actually waiting on the gate never saw the note it was
    // answered with. Deliver it exactly as `respond()` does — this is the
    // ticket's PRIMARY flow ("a note with no button press ... the EM delegate
    // reads it and decides").
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
   * the `hil_resolved` event, and delivered as an `hil_response` bus message
   * to the agent that is waiting on the gate and to the EM.
   */
  async respond(
    id: HilId,
    decision: HilDecision,
    by: string,
    note?: string,
  ): Promise<HilRequest> {
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
      buildEvent('hil_resolved', {
        ...(saved.ticket !== undefined ? { ticket: saved.ticket } : {}),
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
   * note is stored on the still-`pending` request and handed to the EM — as
   * an inbox message and, when a delegate is configured, as a fresh delegate
   * call carrying the note. **It never resolves the gate by itself**; the
   * delegate's approve/deny (or a later button press) does.
   */
  async addNote(id: HilId, note: string, by: string): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    const trimmed = normalizeNote(note);
    if (trimmed === undefined) throw new EmptyNoteError(id);
    const saved = await this.persist({ ...current, note: trimmed });
    await this.deliverNote(saved, by, `note on gate "${saved.gate}" (no decision yet)`, {
      emOnly: true,
    });
    if (this.delegate) {
      const outcome = this.callDelegate(saved);
      const deciding = outcome instanceof Promise ? outcome : Promise.resolve(outcome);
      this.settleLater(saved, deciding, 'human note');
    }
    return saved;
  }

  /**
   * Writes the note into the waiting agent's inbox (the ticket's assignee —
   * the agent whose hook raised the gate) and the EM's, as a normal-priority
   * `hil_response` (§5 "HIL": "daemon holds ... until `hil_response`"). Same
   * direct-to-inbox write `notifyPending`/`notifyResolved` use, so no bus
   * routing rule is involved.
   */
  private async deliverNote(
    req: HilRequest,
    by: string,
    headline: string,
    options: { emOnly?: boolean } = {},
  ): Promise<void> {
    if (req.note === undefined) return;
    const recipients: AgentId[] = ['em'];
    const waiting = options.emOnly ? undefined : this.waitingAgent(req);
    if (waiting !== undefined && waiting !== 'em') recipients.unshift(waiting);

    const body = `${headline} — ${by} wrote: ${req.note}`.slice(0, MESSAGE_BODY_MAX_CHARS);
    // `by` is a free string on the wire (`--by pete`); only use it as the
    // message's `from` when it is actually a valid agent id, else attribute
    // the note to `human` (the card it was typed on).
    const from: AgentId = AgentIdSchema.safeParse(by).success ? (by as AgentId) : 'human';
    const ts = this.clock().toISOString();
    for (const to of recipients) {
      const message: Message = {
        id: ulid(),
        ts,
        from,
        to: [to],
        kind: 'hil_response',
        priority: 'normal',
        ...(req.ticket !== undefined ? { ticket: req.ticket } : {}),
        body,
        refs: [hilPath(req.id)],
        requires_ack: false,
      };
      const validated = validateMessage(message);
      await this.store.putEntity(inboxPath(to, validated.id), validateMessage, validated);
    }
  }

  /** The agent waiting on this gate: the assignee of the request's ticket (the hook that raised an `unblock` runs in that agent's worktree). `undefined` for a ticketless or unassigned request. */
  private waitingAgent(req: HilRequest): AgentId | undefined {
    if (req.ticket === undefined) return undefined;
    let assignee: string | undefined;
    try {
      assignee = this.store.getTicket(req.ticket).assignee;
    } catch {
      return undefined;
    }
    // Review nit: never cast — an assignee that isn't a valid agent id would
    // otherwise throw out of `validateMessage` *after* the decision and its
    // event were already persisted. Skip the delivery instead.
    const parsed = AgentIdSchema.safeParse(assignee);
    return parsed.success ? (parsed.data as AgentId) : undefined;
  }

  /**
   * "Single-instance override: any pending `hil_request` can be delegated
   * from the attention queue without changing policy" (§16). Only usable
   * while `pending` — once used the request is `resolved`, so a second
   * `delegateRequest` call on the same id is refused (T018 acceptance).
   * Requires a `delegate` function (fail closed, same as `request()`).
   */
  async delegateRequest(id: HilId, to: 'em' | 'architect'): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    if (!this.delegate) throw new NoDelegateConfiguredError(id);
    const resolved = await this.autoDecide(
      { ...current, owner: to },
      this.clock(),
      'single-instance delegation',
    );
    const saved = await this.persist(resolved);
    await this.notifyResolved(saved);
    return saved;
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

  get(id: HilId): HilRequest {
    try {
      return this.store.getEntity(hilPath(id), validateHilRequest);
    } catch (err) {
      if (err instanceof NotFoundError) throw new GateNotFoundError(id);
      throw err;
    }
  }

  /** Durable: reads `board/hil/**` fresh from disk every call (review finding 6). */
  list(): HilRequest[] {
    return this.store.listEntities(HIL_DIR, validateHilRequest);
  }
}
