/**
 * `GateService` — HIL requests, delegation, and the circuit breaker over a
 * `StateStore` (design/agile-agents-design.md §16 "HIL gates policy", §5
 * "HIL"). See `types.ts`'s header for why `HilRequest`/`BreakerState` are
 * hand-validated local types rather than shared zod schemas, and why both
 * are stored under `board/hil/**` via the store's generic entity trio.
 *
 * Persistence note (DESIGN-GAP, flagged for the manager): `StateStore` has
 * no generic "list a directory of entities" method (only per-entity
 * `list*()` helpers for the kinds it knows about natively), and this ticket
 * may not add one (store/** is out of scope). Every request this service
 * creates or mutates is still durably written to its own
 * `board/hil/<id>.yaml` file via `putEntity` (so another process — or a
 * future `StateStore.listEntities` — can read it back), but `list()` itself
 * is served from an in-memory index scoped to this `GateService` instance,
 * so a restarted daemon starts `list()` empty until such a store method
 * exists. Recommended addition: `StateStore.listEntities(dir, validator)`.
 */

import type { GateOwner, GatesBlock, Policy } from '@agile-agents/shared';
import { NotFoundError, type StateStore } from '../store';
import { parseDurationMs } from './duration';
import { resolveGate } from './resolve';
import {
  type BreakerSignal,
  type BreakerState,
  type HilDecision,
  type HilRequest,
  humanTimeoutDuration,
  isHumanTimeoutOwner,
  validateBreakerState,
  validateHilRequest,
} from './types';

const HIL_DIR = 'board/hil';
const BREAKER_PATH = `${HIL_DIR}/_breaker.yaml`;

function hilPath(id: string): string {
  return `${HIL_DIR}/${id}.yaml`;
}

function newHilId(): string {
  return `hil_${crypto.randomUUID()}`;
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
 * policy-delegated owner).
 */
export type DelegateFn = (ctx: {
  gate: string;
  owner: GateOwner;
  ticket?: string;
}) => GateDecision;

const DEFAULT_DELEGATE: DelegateFn = ({ owner }) => ({
  decision: 'approve',
  by: owner === 'em' || owner === 'architect' ? owner : 'em',
});

export interface GateServiceOptions {
  clock?: () => Date;
  /** Injectable so tests (and, eventually, the EM/architect adapters) control auto-decisions. */
  delegate?: DelegateFn;
}

export interface GateRequestContext {
  policy: Policy;
  sprint?: GatesBlock;
  epic?: GatesBlock;
  team?: GatesBlock;
  ticket?: string;
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

export class GateService {
  private readonly clock: () => Date;
  private readonly delegate: DelegateFn;
  /** See file header: the durable copy is one file per id under board/hil/; this is the in-process index `list()` reads. */
  private readonly requests = new Map<string, HilRequest>();

  constructor(
    private readonly store: StateStore,
    options: GateServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.delegate = options.delegate ?? DEFAULT_DELEGATE;
  }

  // ------------------------------------------------------------- Breaker

  private async loadBreaker(): Promise<BreakerState> {
    try {
      return this.store.getEntity(BREAKER_PATH, validateBreakerState);
    } catch (err) {
      if (err instanceof NotFoundError) return { tripped: {} };
      throw err;
    }
  }

  async trippedSignals(): Promise<BreakerSignal[]> {
    const state = await this.loadBreaker();
    return Object.keys(state.tripped) as BreakerSignal[];
  }

  /** "force every gate to human until cleared" (§16). */
  async trip(signal: BreakerSignal, detail: string): Promise<BreakerState> {
    const state = await this.loadBreaker();
    return this.store.putEntity(BREAKER_PATH, validateBreakerState, {
      tripped: { ...state.tripped, [signal]: detail },
    });
  }

  async clear(signal: BreakerSignal): Promise<BreakerState> {
    const state = await this.loadBreaker();
    const tripped = { ...state.tripped };
    delete tripped[signal];
    return this.store.putEntity(BREAKER_PATH, validateBreakerState, { tripped });
  }

  // ------------------------------------------------------------- Requests

  /**
   * Resolves `gate`'s owner (most-specific-wins, overridden to `human` with
   * a naming `reason` while any breaker is tripped) and opens a `HilRequest`:
   * `human` → pending, no deadline; `human_timeout:<d>` → pending with a
   * deadline; `em`/`architect` → immediately auto-decided via `delegate`
   * (the decision artifact + `fyi`, §16).
   */
  async request(gate: string, ctx: GateRequestContext): Promise<HilRequest> {
    const resolved = resolveGate(gate, ctx);
    const tripped = await this.trippedSignals();
    const breakerActive = tripped.length > 0;
    const owner: GateOwner = breakerActive ? 'human' : resolved;
    const reason = breakerActive ? `circuit breaker tripped: ${tripped.join(', ')}` : undefined;

    const now = this.clock();
    const base: HilRequest = {
      id: newHilId(),
      gate,
      ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}),
      owner,
      status: 'pending',
      requested_at: now.toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };

    let record: HilRequest;
    if (owner === 'em' || owner === 'architect') {
      record = this.autoDecide(base, owner, now, 'gate policy');
    } else if (isHumanTimeoutOwner(owner)) {
      const deadline = new Date(now.getTime() + parseDurationMs(humanTimeoutDuration(owner)));
      record = { ...base, deadline: deadline.toISOString() };
    } else {
      record = base;
    }

    return this.persist(record);
  }

  private autoDecide(
    base: HilRequest,
    owner: string,
    now: Date,
    via: 'gate policy' | 'single-instance delegation' | 'human_timeout fallthrough',
  ): HilRequest {
    const decision = this.delegate({ gate: base.gate, owner: base.owner, ticket: base.ticket });
    return {
      ...base,
      status: 'resolved',
      decision: decision.decision,
      decided_by: decision.by,
      resolved_at: now.toISOString(),
      delegated: true,
      fyi: {
        to: 'human',
        body: `gate "${base.gate}" ${decision.decision}d by ${decision.by} (${via}, owner: ${owner})${decision.rationale ? ` — ${decision.rationale}` : ''}`,
        sent_at: now.toISOString(),
      },
    };
  }

  private async persist(record: HilRequest): Promise<HilRequest> {
    const saved = await this.store.putEntity(hilPath(record.id), validateHilRequest, record);
    this.requests.set(saved.id, saved);
    return saved;
  }

  /** A human (or anyone acting as the resolved owner) answers a pending request directly. */
  async respond(id: string, decision: HilDecision, by: string): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    const now = this.clock();
    return this.persist({
      ...current,
      status: 'resolved',
      decision,
      decided_by: by,
      resolved_at: now.toISOString(),
    });
  }

  /**
   * "Single-instance override: any pending `hil_request` can be delegated
   * from the attention queue without changing policy" (§16). Only usable
   * while `pending` — once used the request is `resolved`, so a second
   * `delegateRequest` call on the same id is refused (T018 acceptance).
   */
  async delegateRequest(id: string, to: 'em' | 'architect'): Promise<HilRequest> {
    const current = this.get(id);
    if (current.status !== 'pending') throw new GateAlreadyResolvedError(id);
    return this.persist(
      this.autoDecide({ ...current, owner: to }, to, this.clock(), 'single-instance delegation'),
    );
  }

  /**
   * Falls every pending `human_timeout:<d>` request whose deadline has
   * passed through to the delegate ("proceed as the fallback owner would",
   * §16) — exactly at the deadline, not before (T018 acceptance).
   */
  async tick(now: Date = this.clock()): Promise<HilRequest[]> {
    const fallenThrough: HilRequest[] = [];
    for (const req of this.requests.values()) {
      if (req.status !== 'pending' || !req.deadline || !isHumanTimeoutOwner(req.owner)) continue;
      if (new Date(req.deadline).getTime() > now.getTime()) continue;
      fallenThrough.push(
        await this.persist(this.autoDecide(req, req.owner, now, 'human_timeout fallthrough')),
      );
    }
    return fallenThrough;
  }

  get(id: string): HilRequest {
    const cached = this.requests.get(id);
    if (cached) return cached;
    try {
      const loaded = this.store.getEntity(hilPath(id), validateHilRequest);
      this.requests.set(id, loaded);
      return loaded;
    } catch (err) {
      if (err instanceof NotFoundError) throw new GateNotFoundError(id);
      throw err;
    }
  }

  list(): HilRequest[] {
    return Array.from(this.requests.values());
  }
}
