/**
 * `buildPermissionResponder`: turns a `decidePermission` verdict into the
 * ACP `respondPermission` call. Allow/deny answer at once by option id; a
 * `hil` verdict calls `requestHil` (default: an urgent `hil_request` at
 * `bus/inbox/human/<ulid>.yaml`) and leaves the ACP request pending until
 * `resolveHil`.
 *
 * This module doesn't own a `hil_request` past writing it: no deadline
 * timer (the `GateService`'s job), no acking on resolve. `requestHil` is
 * injectable so the gate service can own persistence, acking and timeout.
 */

import { join } from 'node:path';
import type { AcpRequestId } from '@agile-agents/acp-client';
import { type AgentId, ulid, validateAgentMessage } from '@agile-agents/shared';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
import { classifyPermissionRequest } from './classify';
import { decidePermission } from './decide';
import { worktreeBranchLookups } from './push-detector';
import type { PatternRuleGate } from './rule-checks';
import type { AcpPermissionRequestParams, Decision, PermissionRole } from './types';

/** Default time a human has to answer before a `hil_request` is overdue (enforced by the lifecycle owner). */
export const DEFAULT_HIL_DEADLINE_MS = 60 * 60 * 1000;

/** The slice of `SpawnedSession` this module needs. */
export interface PermissionResponderSession {
  respondPermission(id: AcpRequestId, result: unknown): boolean;
}

/** What a `hil` verdict persists for a human to answer. */
export interface HilRequestInput {
  agent: AgentId;
  hilKind: 'classifier_review';
  summary: string;
  /** ISO timestamp, computed here, enforced by the lifecycle owner. */
  deadline: string;
}

/** Persists one `hil_request`; returns the id `resolveHil` will be called with. */
export type RequestHil = (input: HilRequestInput) => Promise<{ id: string }>;

export interface PermissionResponderContext {
  role: PermissionRole;
  /** The session's own id (its ULID) — `role` alone isn't a valid `AgentId`. */
  agent: AgentId;
  worktreePath: string;
  session: PermissionResponderSession;
  hilDeadlineMs?: number;
  /** Defaults to an `AgentMessage` at `bus/inbox/human/<ulid>.yaml`. */
  requestHil?: RequestHil;
  /**
   * The pattern rules this session is judged by, bound to its stream: the
   * only gate a vendor without a pre-tool-use hook (Cursor, Codex, Grok,
   * §4.3) has. Absent means the role table only.
   */
  patternRules?: PatternRuleGate;
  /** T330 (P20): where a read may reach beyond the cwd, and what it never may (as `DecisionContext`). */
  readRoots?: readonly string[];
  hiddenRoots?: readonly string[];
}

/** How a pending `hil_request` was answered. */
export type HilResolution = { optionId: string } | { cancelled: true };

export interface PermissionResponderHandle {
  /** Decides and answers (or parks on a human) one `session/request_permission`. */
  handleRequest(requestId: AcpRequestId, request: AcpPermissionRequestParams): Promise<Decision>;
  /**
   * Resolves a pending `hil_request` by the id `requestHil` returned;
   * `false` if none is pending. Leaves the written record alone.
   */
  resolveHil(hilRequestId: string, resolution: HilResolution): Promise<boolean>;
  /** ACP requests parked on a human answer. */
  pendingHilCount(): number;
}

function selectOption(optionId: string): unknown {
  return { outcome: { outcome: 'selected', optionId } };
}

const CANCELLED_RESULT = { outcome: { outcome: 'cancelled' } };

function hilInboxPath(messageId: string): string {
  return join('bus', 'inbox', 'human', `${messageId}.yaml`);
}

async function defaultRequestHil(
  store: StateStore,
  input: HilRequestInput,
): Promise<{ id: string }> {
  const id = ulid();
  const message = validateAgentMessage({
    id,
    ts: new Date().toISOString(),
    from: input.agent,
    to: ['human'],
    kind: 'hil_request',
    // hil_request blocks the requesting agent's turn until answered —
    // treated as urgent delivery (§5's priority table names `halt` and
    // `standup_call` explicitly but not `hil_request`; DESIGN-GAP,
    // resolved by analogy since this, too, blocks progress).
    priority: 'urgent',
    body: input.summary,
    refs: [],
    hil_kind: input.hilKind,
  });
  await store.putEntity(hilInboxPath(id), validateAgentMessage, message);
  return { id };
}

export function buildPermissionResponder(
  store: StateStore,
  ctx: PermissionResponderContext,
): PermissionResponderHandle {
  const pending = new Map<string, AcpRequestId>();
  const requestHil: RequestHil = ctx.requestHil ?? ((input) => defaultRequestHil(store, input));

  // Lazy + memoized per session: an ordinary allow, or a push naming an
  // explicit branch, never spawns a `git rev-parse` at all.
  const branches = worktreeBranchLookups(ctx.worktreePath);

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
  ): Promise<void> {
    const classified = classifyPermissionRequest(request);
    await store.appendEvent(
      buildEvent('hook_decision', {
        agent: ctx.agent,
        data: {
          role: ctx.role,
          toolClass: classified.toolClass,
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
        },
      }),
    );
  }

  return {
    async handleRequest(requestId, request) {
      const gate = ctx.patternRules;
      const decision = decidePermission({
        role: ctx.role,
        worktreePath: ctx.worktreePath,
        request,
        ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
        ...(ctx.hiddenRoots !== undefined ? { hiddenRoots: ctx.hiddenRoots } : {}),
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
        ctx.session.respondPermission(requestId, selectOption(decision.optionId));
        await recordRuleStats(decision);
        await logDecision(request, decision);
        return decision;
      }

      await logDecision(request, decision);
      const deadline = new Date(
        Date.now() + (ctx.hilDeadlineMs ?? DEFAULT_HIL_DEADLINE_MS),
      ).toISOString();
      const { id } = await requestHil({
        agent: ctx.agent,
        hilKind: decision.hilRequest.hilKind,
        summary: decision.hilRequest.summary,
        deadline,
      });
      pending.set(id, requestId);
      return decision;
    },

    async resolveHil(hilRequestId, resolution) {
      const requestId = pending.get(hilRequestId);
      if (requestId === undefined) return false;
      pending.delete(hilRequestId);

      const result =
        'cancelled' in resolution ? CANCELLED_RESULT : selectOption(resolution.optionId);
      ctx.session.respondPermission(requestId, result);
      // Deliberately does not ack/delete the underlying message/record —
      // see the file header on lifecycle ownership.
      return true;
    },

    pendingHilCount() {
      return pending.size;
    },
  };
}
