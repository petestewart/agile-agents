/**
 * The route band of design/cockpit-design.md §8.1, without the classifier
 * (T138). T151 adds the classifier as a second source of routes onto this
 * same path.
 *
 * Before this, a `hil` verdict from `permissions/policy-tables.ts` (a
 * dependency-manifest edit, a force-push, a `git -C` outside the worktree)
 * became a plain deny telling the model to "file a hil_request" — a verb
 * that no longer exists — and nothing reached the human at all. The
 * twenty-ninth live run (2026-09-21) ended with the worker correctly
 * holding and Pete applying the edit by hand.
 *
 * What a routed verdict does now:
 *  1. fingerprint the call (`fingerprint.ts`): tool + path, or tool +
 *     command;
 *  2. look for this session's own resolved gate on that fingerprint —
 *     approved and unspent ⇒ **allow once** (and spend it); denied ⇒ deny
 *     with the human's note, because the answer was no and the model should
 *     hear it rather than be routed again;
 *  3. otherwise raise (or reuse) a `classifier_review` gate on the stream
 *     and deny with a reason the model can act on: the id it is waiting
 *     for, why, and "retry this exact call".
 *
 * Dedupe matters as much as the routing: a model that is denied retries,
 * and one card per attempt would make the inbox the thing that nags (§3.3
 * "empty is the goal state").
 */

import type {
  AgentId,
  GateCall,
  GateKind,
  HilId,
  HilRequest,
  Policy,
  RuleId,
} from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { GateRequestContext, GateService } from '../gates/service';
import type { RuleStatsOutcome } from '../rules/service';
import type { HookDecision } from './types';

/** The slice of `GateService` the route band needs — injected so `HookService` never depends on the whole gates module. */
export interface RouteBandGates {
  list(): HilRequest[];
  request(gate: GateKind, ctx: GateRequestContext): Promise<HilRequest>;
  /** Marks an approved gate's single allowed retry as spent. */
  consume(id: HilId): Promise<HilRequest>;
}

/** What the hook needs to place a routed call. */
export interface RouteBandContext {
  session: string;
  stream: string;
  policy: Policy;
  call: GateCall;
  /** The policy reason the call was routed for ("editing a dependency manifest/lockfile is never automatic"). */
  reason: string;
  /** T151 (§6.3): the classifier rule whose band routed this call, when one did. */
  rule?: RuleId;
}

/** A routed verdict, plus the gate it is attributable to (for the `hook_decision` event). */
export interface RoutedDecision {
  decision: HookDecision;
  gate: HilId;
  /** Set when this decision spent an approval — `hook_decision` records it as `allowed_by`. */
  allowedBy?: HilId;
}

function cap(text: string): string {
  return text.length > MESSAGE_BODY_MAX_CHARS ? text.slice(0, MESSAGE_BODY_MAX_CHARS) : text;
}

/** This session's gates on this exact call, newest first. */
function matching(gates: RouteBandGates, ctx: RouteBandContext): HilRequest[] {
  return gates
    .list()
    .filter(
      (gate) =>
        gate.gate === 'classifier_review' &&
        gate.session === ctx.session &&
        gate.call?.fingerprint === ctx.call.fingerprint,
    )
    .sort((a, b) =>
      a.requested_at === b.requested_at ? 0 : a.requested_at < b.requested_at ? 1 : -1,
    );
}

/**
 * Runs the route band for one `hil` verdict. Pure but for the two writes it
 * has to make (spend an approval, raise a gate) — the caller renders the
 * `HookDecision` and logs the event.
 */
export async function routeCall(
  gates: RouteBandGates,
  ctx: RouteBandContext,
): Promise<RoutedDecision> {
  const candidates = matching(gates, ctx);
  const approved = candidates.find(
    (gate) => gate.decision === 'approve' && gate.consumed_at === undefined,
  );
  if (approved !== undefined && (await spend(gates, approved.id))) {
    return {
      decision: {
        decision: 'allow',
        reason: `${approved.id} approved by ${approved.decided_by ?? 'human'} — allowed once for this call.`,
      },
      gate: approved.id,
      allowedBy: approved.id,
    };
  }

  const open = candidates.find((gate) => gate.status === 'pending');
  if (open !== undefined) {
    return {
      decision: { decision: 'deny', reason: routedReason(open.id, ctx.reason) },
      gate: open.id,
    };
  }

  // A decided-and-spent gate is not an answer to this attempt; a *denied*
  // one is, and stays the answer until the human changes their mind.
  const denied = candidates.find((gate) => gate.decision === 'deny');
  if (denied !== undefined) {
    return {
      decision: {
        decision: 'deny',
        reason: cap(
          `${denied.id} was denied: ${denied.note ?? 'no reason given'}. Do not retry this call; do the work another way or ask on the stream.`,
        ),
      },
      gate: denied.id,
    };
  }

  const raised = await gates.request('classifier_review', {
    policy: ctx.policy,
    stream: ctx.stream,
    session: ctx.session as AgentId,
    requestedBy: ctx.session as AgentId,
    call: ctx.call,
    ...(ctx.rule !== undefined ? { rule: ctx.rule } : {}),
    // The call itself is on `call`, and the inbox card renders it from
    // there (`inbox/service.ts`) — the summary is why it was routed.
    summary: cap(ctx.reason),
  });
  return {
    decision: { decision: 'deny', reason: routedReason(raised.id, ctx.reason) },
    gate: raised.id,
  };
}

/**
 * Spends an approval, returning false when someone else spent it first.
 * `GateService.consume` is a compare-and-swap since T151: two identical
 * in-flight calls used to both read the same approved-and-unconsumed record
 * and both be allowed by the one approval. The loser routes again.
 */
async function spend(gates: RouteBandGates, id: HilId): Promise<boolean> {
  try {
    await gates.consume(id);
    return true;
  } catch {
    return false;
  }
}

function routedReason(id: HilId, why: string): string {
  return cap(
    `${why} — routed to your inbox as ${id}. Wait for the human's decision, then retry this exact call.`,
  );
}

/** What `wireGateDecisionDelivery` needs of `AttachService` (T137's delivery path). */
export interface GateDecisionDelivery {
  deliverGateDecision(sessionId: string, gate: HilRequest): Promise<void>;
}

/**
 * Resolving a `classifier_review` gate prompts the session that is waiting
 * on it (T137: delivery is a prompt, not a mailbox). Wired the same way
 * `wireLandGateResolution` is, and for the same reason: `GateService` has
 * no business knowing what any one gate kind means.
 */
export function wireGateDecisionDelivery(gates: GateService, attach: GateDecisionDelivery): void {
  const respond = gates.respond.bind(gates);
  gates.respond = async (id, decision, by, note) => {
    const resolved = await respond(id, decision, by, note);
    if (resolved.gate === 'classifier_review' && resolved.session !== undefined) {
      await attach.deliverGateDecision(resolved.session, resolved);
    }
    return resolved;
  };
}

/** The write side of `RulesService` the routed-answer statistic needs (§5.7). */
export interface RouteStatsRules {
  recordFired(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

/**
 * T151 (§6.3, last line): "the answer allows or denies and increments
 * `stats`". The route itself already bumped `routed` when the gate was
 * raised; the human's *deny* is what turns that routed call into a
 * violation of the rule that asked. Wired the same way
 * `wireGateDecisionDelivery` is, so `GateService` keeps knowing nothing
 * about what a gate kind means.
 *
 * T153: the outcome is `resolved_violation`, not `violated`, because this
 * is the *same* action the hook already counted as a firing when it routed
 * it. Recording it as an ordinary firing made one routed-then-denied call
 * read `fired: 2, routed: 1, violated: 1`, which is the number §5.7's
 * pruning report divides by.
 */
export function wireClassifierRouteStats(
  gates: { respond: GateService['respond'] },
  rules: RouteStatsRules,
): void {
  const respond = gates.respond.bind(gates as GateService);
  gates.respond = async (id, decision, by, note) => {
    const resolved = await respond(id, decision, by, note);
    if (
      resolved.gate === 'classifier_review' &&
      resolved.decision === 'deny' &&
      resolved.rule !== undefined
    ) {
      try {
        await rules.recordFired(resolved.rule, 'resolved_violation');
      } catch {
        // Telemetry (§5.7's pruning input): losing a counter must never
        // turn a decision the human already made into an error.
      }
    }
    return resolved;
  };
}
