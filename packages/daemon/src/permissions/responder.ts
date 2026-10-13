/**
 * `buildPermissionResponder`: turns a `decidePermission` verdict into the
 * ACP `respondPermission` call. Allow/deny answer at once by option id
 * (`allow_once`/`reject_once`, never `allow_always`).
 *
 * T524: a `hil` verdict is never parked. It goes through the hook's route
 * band (`routeHil`, `hook/route-band.ts`'s `acpHilRouter`): a Needs me card
 * and a refusal now, and once the human says yes the retry of that exact
 * call is allowed once (the decision is prompted in,
 * `wireGateDecisionDelivery`). With no route (no gate service, the
 * Director) it is refused, as the hook refuses a call it can't route.
 *
 * Every request is answered exactly once: one still being routed when the
 * session stops is answered `cancelled` (`cancelPending`, ACP's answer to
 * a pending request at `session/cancel`), and the route's late answer is
 * dropped.
 */

import type { AcpRequestId } from '@agile-agents/acp-client';
import type { AgentId, PermissionPosture } from '@agile-agents/shared';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
import { classifyPermissionRequest } from './classify';
import { decidePermission } from './decide';
import { worktreeBranchLookups, worktreeGitAliases } from './push-detector';
import type { PatternRuleGate } from './rule-checks';
import type {
  AcpPermissionRequestParams,
  Decision,
  HilRequestDraft,
  PermissionRole,
} from './types';

/** The slice of `SpawnedSession` this module needs. */
export interface PermissionResponderSession {
  respondPermission(id: AcpRequestId, result: unknown): boolean;
}

export interface PermissionResponderContext {
  role: PermissionRole;
  /** The session's own id (its ULID) — `role` alone isn't a valid `AgentId`. */
  agent: AgentId;
  worktreePath: string;
  session: PermissionResponderSession;
  /**
   * The pattern rules this session is judged by, bound to its stream: the
   * only gate a vendor without a pre-tool-use hook (Cursor, Codex, Grok,
   * §4.3) has. Absent means the role table only.
   */
  patternRules?: PatternRuleGate;
  /** T305, T330 (P20): where a read may reach beyond the cwd, and what it never may (as `DecisionContext`). */
  readRoots?: readonly string[];
  hiddenRoots?: readonly string[];
  /** T457: the node's permission posture (as `DecisionContext`). */
  posture?: PermissionPosture;
  /** T476: the vendor has a pre-tool hook (as `DecisionContext`); absent counts as hooked. */
  hooked?: boolean;
  /**
   * T457, T524: how a held call is placed: the hook's route band
   * (`hook/route-band.ts`): a Needs me card and a deny to retry, the retry
   * allowed once the human says yes. Absent: the call is refused.
   */
  routeHil?: (draft: HilRequestDraft, reason: string) => Promise<RoutedVerdict>;
}

/** What the route band said about one held call at this tier. */
export type RoutedVerdict =
  | {
      decision: 'allow';
      /** The approval this answer spent (`allowed_by` on the event, as the hook logs it). */
      allowedBy?: string;
    }
  | { decision: 'deny'; reason: string };

export interface PermissionResponderHandle {
  /** Decides and answers one `session/request_permission`; a held call is routed to a card first. */
  handleRequest(requestId: AcpRequestId, request: AcpPermissionRequestParams): Promise<Decision>;
  /**
   * T524: the session is stopping: every request not yet answered (a held
   * call still being routed) is answered `cancelled` now, and so is a held
   * call that arrives later. Returns how many were answered now.
   */
  cancelPending(): number;
}

function selectOption(optionId: string): unknown {
  return { outcome: { outcome: 'selected', optionId } };
}

const CANCELLED_RESULT = { outcome: { outcome: 'cancelled' } };

/** A held call's answer: the decision to log and return, and what goes on the wire. */
interface HeldAnswer {
  decision: Decision;
  result: unknown;
  allowedBy?: string;
}

export function buildPermissionResponder(
  store: StateStore,
  ctx: PermissionResponderContext,
): PermissionResponderHandle {
  /** T524: requests received and not yet answered; `answer` takes each out once. */
  const unanswered = new Set<AcpRequestId>();
  /** T524: set by `cancelPending`: the session is stopping, nothing new is routed. */
  let stopping = false;
  /**
   * T524: held calls are routed one at a time, so a second identical call
   * in flight finds the first one's card instead of raising its own.
   */
  let routing: Promise<unknown> = Promise.resolve();

  // Lazy + memoized per session: an ordinary allow, or a push naming an
  // explicit branch, never spawns a `git rev-parse` at all.
  const branches = worktreeBranchLookups(ctx.worktreePath);

  /** Answers a request once; `false` when it was already answered (cancelled at a stop). */
  function answer(requestId: AcpRequestId, result: unknown): boolean {
    if (!unanswered.delete(requestId)) return false;
    ctx.session.respondPermission(requestId, result);
    return true;
  }

  /** §5.7's counters for every rule the decision evaluated — `fired` always, `violated` for the one it denied on. */
  async function recordRuleStats(decision: Decision): Promise<void> {
    const gate = ctx.patternRules;
    if (gate === undefined || decision.kind === 'hil') return;
    for (const id of decision.rulesEvaluated ?? []) {
      const violated = decision.kind === 'deny' && id === decision.ruleViolated;
      await gate.record(id, violated ? 'violated' : 'fired');
    }
  }

  async function logDecision(
    request: AcpPermissionRequestParams,
    decision: Decision,
    extra: { allowedBy?: string; cancelled?: boolean } = {},
  ): Promise<void> {
    const classified = classifyPermissionRequest(request);
    await store.appendEvent(
      buildEvent('hook_decision', {
        agent: ctx.agent,
        data: {
          role: ctx.role,
          toolClass: classified.toolClass,
          // T476: the request's own shape, so a vendor's unread naming is diagnosable from the log.
          ...(request.toolCall?.kind !== undefined ? { kind: request.toolCall.kind } : {}),
          ...(request.toolCall?.title !== undefined
            ? { title: request.toolCall.title.slice(0, 200) }
            : {}),
          input_keys: Object.keys(request.toolCall?.rawInput ?? {}).slice(0, 20),
          ...(classified.targetPath !== undefined ? { targetPath: classified.targetPath } : {}),
          ...(classified.command !== undefined ? { command: classified.command } : {}),
          ...(classified.url !== undefined ? { url: classified.url } : {}),
          decision: decision.kind,
          ...(decision.kind !== 'hil' ? { optionId: decision.optionId } : {}),
          ...(decision.kind !== 'allow' ? { reason: decision.reason } : {}),
          // T143: which rule refused this call, so "why was I denied" is
          // answerable from the log alone at this tier too.
          ...(decision.kind === 'deny' && decision.ruleViolated !== undefined
            ? { rule: decision.ruleViolated }
            : {}),
          // T524: allowed because a human approved the card that held it (as the hook logs it).
          ...(extra.allowedBy !== undefined ? { allowed_by: extra.allowedBy } : {}),
          // T524: answered `cancelled`: the session stopped, or no reject option was offered.
          ...(extra.cancelled === true ? { outcome: 'cancelled' } : {}),
        },
      }),
    );
  }

  /** Runs `run` after every held call routed before it (see `routing`). */
  function serially<T>(run: () => Promise<T>): Promise<T> {
    const next = routing.then(run, run);
    routing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * T524: a held call's answer. Routed to a card when it can be (a deny
   * now, its retry allowed once approved), else refused: there is no
   * route, no `allow_once` to let the retry through with (never
   * `allow_always`), or no `reject_once` (then `decidePermission` holds
   * even a deny it can't say, which is no card for the human to override;
   * the refusal is `cancelled`).
   */
  async function placeHeld(
    decision: Extract<Decision, { kind: 'hil' }>,
    request: AcpPermissionRequestParams,
  ): Promise<HeldAnswer> {
    const options = request.options ?? [];
    const allow = options.find((o) => o.kind === 'allow_once');
    const reject = options.find((o) => o.kind === 'reject_once');
    const refuse = (reason: string): HeldAnswer =>
      reject !== undefined
        ? {
            decision: { kind: 'deny', optionId: reject.optionId, reason },
            result: selectOption(reject.optionId),
          }
        : { decision: { ...decision, reason }, result: CANCELLED_RESULT };

    // The session is stopping: no card for a call nobody will retry.
    if (stopping) return { decision, result: CANCELLED_RESULT };
    if (allow === undefined || reject === undefined) {
      const missing = allow === undefined ? 'allow_once' : 'reject_once';
      return refuse(`${decision.reason} (no ${missing} option offered, so no card)`);
    }
    if (ctx.routeHil === undefined) {
      return refuse(`${decision.reason} — nothing here can hold it for the human`);
    }
    const route = ctx.routeHil;
    let verdict: RoutedVerdict;
    try {
      verdict = await serially(() => route(decision.hilRequest, decision.reason));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return refuse(`${decision.reason} — it could not be held for the human (${why})`);
    }
    if (verdict.decision === 'deny') return refuse(verdict.reason);
    return {
      decision: { kind: 'allow', optionId: allow.optionId },
      result: selectOption(allow.optionId),
      ...(verdict.allowedBy !== undefined ? { allowedBy: verdict.allowedBy } : {}),
    };
  }

  /** Decides and answers one request (`handleRequest` makes sure it is answered). */
  async function decideAndAnswer(
    requestId: AcpRequestId,
    request: AcpPermissionRequestParams,
  ): Promise<Decision> {
    const gate = ctx.patternRules;
    const decision = decidePermission({
      role: ctx.role,
      worktreePath: ctx.worktreePath,
      request,
      // T476: the agent's own session id (for its verbs as a hook-less vendor names them).
      session: ctx.agent,
      ...(ctx.hooked !== undefined ? { hooked: ctx.hooked } : {}),
      ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
      ...(ctx.hiddenRoots !== undefined ? { hiddenRoots: ctx.hiddenRoots } : {}),
      ...(ctx.posture !== undefined ? { posture: ctx.posture } : {}),
      // T525: per request, so an alias the operator adds mid-session counts.
      gitAlias: worktreeGitAliases(ctx.worktreePath),
      ...(gate !== undefined
        ? {
            patternRules: gate.rules(),
            protectedBranches: gate.protectedBranches(),
            upstreamBranch: branches.upstream,
            headBranch: branches.head,
          }
        : {}),
    });

    if (decision.kind === 'allow' || decision.kind === 'deny') {
      // Respond before the (fallible) event-log write (review fix, opus
      // should-fix 9): a store hiccup must not leave the agent's turn
      // hung on an already-decided answer.
      answer(requestId, selectOption(decision.optionId));
      await recordRuleStats(decision);
      await logDecision(request, decision);
      return decision;
    }

    // T457, T524: a held call is routed like the hook's (a card, deny now, the retry allowed once).
    const held = await placeHeld(decision, request);
    if (!answer(requestId, held.result)) {
      // The session stopped while it was routed: already answered `cancelled`.
      await logDecision(request, decision, { cancelled: true });
      return decision;
    }
    await logDecision(request, held.decision, {
      ...(held.allowedBy !== undefined ? { allowedBy: held.allowedBy } : {}),
      ...(held.result === CANCELLED_RESULT ? { cancelled: true } : {}),
    });
    return held.decision;
  }

  return {
    async handleRequest(requestId, request) {
      unanswered.add(requestId);
      try {
        return await decideAndAnswer(requestId, request);
      } finally {
        // T524: never left waiting: a throw before the answer refuses the call.
        const reject = (request.options ?? []).find((o) => o.kind === 'reject_once');
        answer(requestId, reject !== undefined ? selectOption(reject.optionId) : CANCELLED_RESULT);
      }
    },

    cancelPending() {
      stopping = true;
      const ids = [...unanswered];
      for (const id of ids) answer(id, CANCELLED_RESULT);
      return ids.length;
    },
  };
}
