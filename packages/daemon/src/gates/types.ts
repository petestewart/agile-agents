/**
 * Local types + hand-written validators for the gates module
 * (design/agile-agents-design.md §16 "HIL gates policy", §5 "HIL").
 *
 * T018 scope note: `HilRequest` and `BreakerState` are NOT shared zod
 * schemas — T018's file-ownership rule forbids a local zod schema in the
 * daemon ("schemas live in shared"), and neither entity has a shared
 * schema yet (T006, which owns the bus, is still in flight and this ticket
 * must not depend on its code). Both are modeled here as plain TypeScript
 * types with hand-written runtime validators (no `z.object` anywhere in
 * this file) and persisted through `StateStore`'s generic `putEntity` /
 * `getEntity` / `deleteEntity` trio under a path this ticket owns
 * (`board/hil/**`), per the manager's instructions. Where a field's shape
 * is already governed by a *shared* schema (`GateOwner`, `Policy`,
 * `GatesBlock`), this file reuses the shared export rather than
 * re-encoding it — see `resolve.ts`.
 *
 * DESIGN-GAP: this shape is offered to the manager as the candidate shared
 * schema once T006's bus lands for real (see the pipeline report) — until
 * then it lives here, as instructed.
 */

import { type GateOwner, HUMAN_TIMEOUT_PATTERN } from '@agile-agents/shared';

export type HilRequestStatus = 'pending' | 'resolved';
export type HilDecision = 'approve' | 'deny';

export interface HilFyi {
  to: 'human';
  body: string;
  sent_at: string;
}

/**
 * `.agile/board/hil/<id>.yaml` — one file per HIL request/response
 * (§5 "HIL": "`hil_request` has `kind: approve_decision | steer | demo |
 * unblock` and a `deadline`; daemon holds the related halt or sprint review
 * until `hil_response`"; §16 delegated gates: "produce the same artifact
 * (decision record, `by: em`, rationale) and send the human a low-priority
 * `fyi`").
 */
export interface HilRequest {
  id: string;
  gate: string;
  ticket?: string;
  /** Owner this request actually resolved to (post-breaker-override). */
  owner: GateOwner;
  status: HilRequestStatus;
  requested_at: string;
  /** Only set for a `human_timeout:<d>` owner (§16). */
  deadline?: string;
  /** Names the tripped breaker signal(s) when a breaker forced this to `human` (§16). */
  reason?: string;
  decision?: HilDecision;
  decided_by?: string;
  resolved_at?: string;
  /** True when an `em`/`architect` owner (policy or single-instance delegate) auto-decided this. */
  delegated?: boolean;
  /** The low-priority notice a delegated decision sends the human (§16) — bus wiring is a later ticket's job. */
  fyi?: HilFyi;
}

/**
 * "Circuit breaker: configurable signals (global halt this sprint, budget
 * over X%, integration tests red, escalation ladder exhausted,
 * reviewer/engineer deadlock) force every gate to human until cleared" (§16).
 * DESIGN-GAP: the design names five signals in prose; the T018 ticket text
 * names six ("global halt, budget %, integration red, ladder exhausted,
 * deadlock, N denials"). The sixth (repeated permission denials) has no
 * named signal id in the design, so it is modeled here as `denials`.
 */
export const BREAKER_SIGNALS = [
  'global_halt',
  'budget_pct',
  'integration_red',
  'ladder_exhausted',
  'deadlock',
  'denials',
] as const;
export type BreakerSignal = (typeof BREAKER_SIGNALS)[number];

/** `.agile/board/hil/_breaker.yaml` — one file, tripped signal -> human-readable detail. */
export interface BreakerState {
  tripped: Partial<Record<BreakerSignal, string>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isHumanTimeoutOwner(owner: GateOwner): boolean {
  return HUMAN_TIMEOUT_PATTERN.test(owner);
}

/** The `<d>` half of a `human_timeout:<d>` owner. */
export function humanTimeoutDuration(owner: GateOwner): string {
  return owner.slice('human_timeout:'.length);
}

function isGateOwnerValue(value: unknown): value is GateOwner {
  return (
    value === 'human' ||
    value === 'em' ||
    value === 'architect' ||
    (typeof value === 'string' && HUMAN_TIMEOUT_PATTERN.test(value))
  );
}

function isHilDecision(value: unknown): value is HilDecision {
  return value === 'approve' || value === 'deny';
}

export class InvalidHilRequestError extends Error {
  constructor(reason: string) {
    super(`invalid HilRequest: ${reason}`);
    this.name = 'InvalidHilRequestError';
  }
}

export function validateHilRequest(input: unknown): HilRequest {
  if (!isPlainObject(input)) throw new InvalidHilRequestError('expected an object');
  const v = input;

  if (!isNonEmptyString(v.id)) throw new InvalidHilRequestError('id must be a non-empty string');
  if (!isNonEmptyString(v.gate))
    throw new InvalidHilRequestError('gate must be a non-empty string');
  if (v.ticket !== undefined && !isNonEmptyString(v.ticket)) {
    throw new InvalidHilRequestError('ticket must be a non-empty string when present');
  }
  if (!isGateOwnerValue(v.owner)) {
    throw new InvalidHilRequestError('owner must be human | em | architect | human_timeout:<d>');
  }
  if (v.status !== 'pending' && v.status !== 'resolved') {
    throw new InvalidHilRequestError('status must be "pending" or "resolved"');
  }
  if (!isNonEmptyString(v.requested_at)) {
    throw new InvalidHilRequestError('requested_at must be a non-empty string');
  }
  if (v.deadline !== undefined && !isNonEmptyString(v.deadline)) {
    throw new InvalidHilRequestError('deadline must be a non-empty string when present');
  }
  if (v.reason !== undefined && !isNonEmptyString(v.reason)) {
    throw new InvalidHilRequestError('reason must be a non-empty string when present');
  }
  if (v.decision !== undefined && !isHilDecision(v.decision)) {
    throw new InvalidHilRequestError('decision must be "approve" or "deny" when present');
  }
  if (v.decided_by !== undefined && !isNonEmptyString(v.decided_by)) {
    throw new InvalidHilRequestError('decided_by must be a non-empty string when present');
  }
  if (v.resolved_at !== undefined && !isNonEmptyString(v.resolved_at)) {
    throw new InvalidHilRequestError('resolved_at must be a non-empty string when present');
  }
  if (v.delegated !== undefined && typeof v.delegated !== 'boolean') {
    throw new InvalidHilRequestError('delegated must be a boolean when present');
  }
  if (v.fyi !== undefined) {
    if (
      !isPlainObject(v.fyi) ||
      v.fyi.to !== 'human' ||
      !isNonEmptyString(v.fyi.body) ||
      !isNonEmptyString(v.fyi.sent_at)
    ) {
      throw new InvalidHilRequestError(
        'fyi must be { to: "human", body: string, sent_at: string } when present',
      );
    }
  }

  return {
    id: v.id,
    gate: v.gate,
    ...(v.ticket !== undefined ? { ticket: v.ticket } : {}),
    owner: v.owner,
    status: v.status,
    requested_at: v.requested_at,
    ...(v.deadline !== undefined ? { deadline: v.deadline } : {}),
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    ...(v.decision !== undefined ? { decision: v.decision } : {}),
    ...(v.decided_by !== undefined ? { decided_by: v.decided_by } : {}),
    ...(v.resolved_at !== undefined ? { resolved_at: v.resolved_at } : {}),
    ...(v.delegated !== undefined ? { delegated: v.delegated } : {}),
    ...(v.fyi !== undefined
      ? {
          fyi: {
            to: 'human' as const,
            body: (v.fyi as Record<string, unknown>).body as string,
            sent_at: (v.fyi as Record<string, unknown>).sent_at as string,
          },
        }
      : {}),
  };
}

function isBreakerSignalValue(value: unknown): value is BreakerSignal {
  return typeof value === 'string' && (BREAKER_SIGNALS as readonly string[]).includes(value);
}

export class InvalidBreakerStateError extends Error {
  constructor(reason: string) {
    super(`invalid BreakerState: ${reason}`);
    this.name = 'InvalidBreakerStateError';
  }
}

export function validateBreakerState(input: unknown): BreakerState {
  if (!isPlainObject(input) || !isPlainObject(input.tripped)) {
    throw new InvalidBreakerStateError('expected { tripped: Record<signal, string> }');
  }
  const tripped: Partial<Record<BreakerSignal, string>> = {};
  for (const [signal, detail] of Object.entries(input.tripped)) {
    if (!isBreakerSignalValue(signal)) {
      throw new InvalidBreakerStateError(`unknown breaker signal: ${signal}`);
    }
    if (!isNonEmptyString(detail)) {
      throw new InvalidBreakerStateError(`detail for ${signal} must be a non-empty string`);
    }
    tripped[signal] = detail;
  }
  return { tripped };
}
