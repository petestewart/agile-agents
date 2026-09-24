/**
 * The route band (§8.1) for a `hil` verdict, from the role policy or a
 * classifier rule:
 *  1. fingerprint the call (tool + path, or tool + command);
 *  2. this session's approved, unspent gate on that fingerprint ⇒ allow
 *     once (and spend it); a denied one ⇒ deny with the human's note;
 *  3. otherwise raise (or reuse) a `classifier_review` gate and deny with
 *     the id to wait for, why, and "retry this exact call".
 * Dedupe matters: a denied model retries, and one card per attempt would
 * make the inbox nag (§3.3).
 */

import type {
  AgentId,
  GateCall,
  GateKind,
  HilId,
  HilRequest,
  KnowledgeId,
  Policy,
} from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { GateRequestContext, GateService } from '../gates/service';
import type { RuleStatsOutcome } from '../knowledge/service';
import type { HookDecision } from './types';

/** The slice of `GateService` the route band needs. */
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
  /** Why the call was routed. */
  reason: string;
  /** The classifier rule whose band routed this call (§6.3), if any. */
  rule?: KnowledgeId;
}

/** A routed verdict and the gate it is attributable to. */
export interface RoutedDecision {
  decision: HookDecision;
  gate: HilId;
  /** The approval this decision spent (`allowed_by` on the event). */
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

/** Runs the route band for one `hil` verdict. Its only writes: spending an approval, raising a gate. */
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

  // A spent approval doesn't answer this attempt; a denial stays the answer.
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
    // The card renders the call from `call`; the summary is why.
    summary: cap(ctx.reason),
  });
  return {
    decision: { decision: 'deny', reason: routedReason(raised.id, ctx.reason) },
    gate: raised.id,
  };
}

/** Spends an approval (`consume` is a compare-and-swap); `false` when another call spent it first. */
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

/** What `wireGateDecisionDelivery` needs of `AttachService`. */
export interface GateDecisionDelivery {
  deliverGateDecision(sessionId: string, gate: HilRequest): Promise<void>;
}

/** A decided `classifier_review` gate is delivered to the waiting session as a prompt. */
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

/** The write side of `KnowledgeService` the routed-answer statistic needs. */
export interface RouteStatsRules {
  recordFired(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

/**
 * §6.3: the human's deny on a routed call is a violation of the rule that
 * routed it, recorded as `resolved_violation` (the route already counted
 * the firing).
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
        // Telemetry: never fail a decision the human already made.
      }
    }
    return resolved;
  };
}
