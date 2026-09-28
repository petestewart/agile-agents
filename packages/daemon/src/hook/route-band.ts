/**
 * The route band (§8.1) for a `hil` verdict, from the role policy or a
 * classifier rule:
 *  1. fingerprint the call (tool + path, or tool + command);
 *  2. this session's approved, unspent gate on that fingerprint ⇒ allow
 *     once (and spend it); a denied one ⇒ deny with the human's note;
 *  3. otherwise raise (or reuse) a `classifier_review` gate and deny with
 *     why and "retry this exact call". T460: no gate id; the agent has no
 *     use for one, and repeated it to the human.
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
import type { RoutedReadVerdict } from '../permissions/responder';
import type { HilRequestDraft } from '../permissions/types';
import { NotFoundError } from '../store';
import { fingerprintCall } from './fingerprint';
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
  /** T457: a read the Ask posture held: the dir "Always for this project" adds. */
  readRoot?: string;
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
      decision: { decision: 'deny', reason: routedReason(ctx.reason) },
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
          `The human denied this call: ${denied.note ?? 'no reason given'}. Do not retry this call; do the work another way or ask on the stream.`,
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
    ...(ctx.readRoot !== undefined ? { readRoot: ctx.readRoot } : {}),
    // The card renders the call from `call`; the summary is why.
    summary: cap(ctx.reason),
  });
  return {
    decision: { decision: 'deny', reason: routedReason(ctx.reason) },
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

function routedReason(why: string): string {
  return cap(
    `${why} — held for the human's approval (a card in their Needs me). Wait for their decision, then retry this exact call.`,
  );
}

/** The gate policy the route band resolves owners with; no `policy.yaml` means every gate is the human's (the shipped default). */
export function routePolicy(store: { getPolicy(): Policy }): Policy {
  try {
    return store.getPolicy();
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    return {
      gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
      breaker_signals: [],
    };
  }
}

/** Claude's tool names for the ACP classes a held read comes in, so the card and fingerprint read the same at both tiers. */
const ACP_TOOL_NAMES: Record<string, string> = { read: 'Read', execute: 'Bash' };

/**
 * T457: the ACP tier's route for a read the Ask posture held (a vendor
 * with no pre-tool-use hook): the hook's fingerprint, gate and "retry this
 * exact call", so an approval — or Always — answers the retry the same way.
 */
export function acpReadRouter(opts: {
  gates: RouteBandGates;
  store: { getPolicy(): Policy };
  session: string;
  stream: string;
  worktreePath: string;
}): (draft: HilRequestDraft, reason: string) => Promise<RoutedReadVerdict> {
  return async (draft, reason) => {
    const c = draft.classified;
    const call = fingerprintCall(
      {
        tool_name: ACP_TOOL_NAMES[c.toolClass] ?? c.toolClass,
        tool_input:
          c.command !== undefined
            ? { command: c.command }
            : c.targetPath !== undefined
              ? { file_path: c.targetPath }
              : {},
      },
      opts.worktreePath,
    );
    if (call === undefined) {
      return {
        decision: 'deny',
        reason: `${reason} — ask the operator on the stream before retrying`,
      };
    }
    const routed = await routeCall(opts.gates, {
      session: opts.session,
      stream: opts.stream,
      policy: routePolicy(opts.store),
      call,
      reason,
      ...(draft.readAsk?.root !== undefined ? { readRoot: draft.readAsk.root } : {}),
    });
    return routed.decision.decision === 'allow'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: routed.decision.reason ?? reason };
  };
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
