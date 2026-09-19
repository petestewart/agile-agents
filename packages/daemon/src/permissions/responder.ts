/**
 * `buildPermissionResponder` — turns a `decidePermission` verdict into the
 * ACP `respondPermission` call (T010). Allow/deny answer the pending ACP
 * request immediately by selecting the chosen option's id; a `hil` verdict
 * instead calls `requestHil` (default: writes a `hil_request` `Message` to
 * the bus) and leaves the ACP request unanswered until `resolveHil` is
 * called with the human's answer.
 *
 * Bus placement (design/agile-agents-design.md §5 "Storage":
 * `bus/inbox/<agent>/<ulid>.yaml`; ticket: "pick the §5 layout and
 * document"): the default `requestHil` writes to
 * `bus/inbox/human/<ulid>.yaml` — §5's routing rules name `human` as the
 * recipient of a `hil_request` ("anyone → human (hil_request)"), so this
 * follows the same `inbox/<agent>/` shape T006 uses for every other
 * recipient rather than inventing a `hil/` path.
 *
 * **Lifecycle ownership (review-round finding, opus should-fix 6/7)**:
 * this module does *not* own a `hil_request`'s lifecycle past writing it.
 * It does not run a timer against `deadline` — that belongs to T018's
 * `GateService` (§16's `human_timeout: <duration>` fallback is exactly
 * this case), and `resolveHil` no longer deletes/acks the written message
 * on resolve — acking a bus message is T006's job (`bus/inbox/<agent>/
 * done/`), and T018's `GateService` may track the same request under its
 * own `board/hil/<id>.yaml` record. `requestHil` is injectable
 * specifically so the manager can wire T018's `GateService` in as the
 * single owner of persistence/acking/timeout instead of this module's
 * default store-backed writer — this module then only needs the `{id}`
 * it returns to correlate a later `resolveHil` call.
 */

import { join } from 'node:path';
import type { AcpRequestId } from '@agile-agents/acp-client';
import { type AgentId, type TicketId, ulid, validateMessage } from '@agile-agents/shared';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
import { classifyPermissionRequest } from './classify';
import { decidePermission } from './decide';
import type { AcpPermissionRequestParams, Decision, PermissionRole } from './types';

/** Default time a human has to answer a `hil_request` before it's overdue. Not a CLAUDE.md tunable (none listed for this); kept local and overridable per ctx. Enforcing this deadline (ticking, escalating) is T018's `GateService`, not this module — see the file header. */
export const DEFAULT_HIL_DEADLINE_MS = 60 * 60 * 1000;

/** The slice of `SpawnedSession` this module needs — kept minimal so a test can fake it without spawning a real agent. */
export interface PermissionResponderSession {
  respondPermission(id: AcpRequestId, result: unknown): boolean;
}

/** What a `hil` verdict needs persisted somewhere a human (or T018's `GateService`) can see and eventually answer. */
export interface HilRequestInput {
  /** Absent for a session that is not a ticket session (T041's resident EM chat session). */
  ticket?: TicketId;
  agent: AgentId;
  hilKind: 'unblock';
  summary: string;
  /** ISO timestamp — computed here (from `hilDeadlineMs`), enforced by whoever owns the lifecycle (see file header). */
  deadline: string;
}

/** Persists one `hil_request` and returns an id `resolveHil` will later be called with. Injectable so T018's `GateService` can own persistence/acking/timeout instead of this module's default store-backed writer. */
export type RequestHil = (input: HilRequestInput) => Promise<{ id: string }>;

export interface PermissionResponderContext {
  role: PermissionRole;
  /** The session's ticket. Optional since T041: the EM's chat/gate sessions are not ticket sessions, and every policy path this module drives already treats an absent ticket as "no branch is this ticket's branch". */
  ticket?: TicketId;
  /** Concrete bus identity of the agent this session belongs to (e.g. `eng-3`) — `role` alone isn't a valid `AgentId`. */
  agent: AgentId;
  worktreePath: string;
  session: PermissionResponderSession;
  hilDeadlineMs?: number;
  /** Defaults to writing a `Message` at `bus/inbox/human/<ulid>.yaml` via `store.putEntity`. Override to hand persistence to T018's `GateService`. */
  requestHil?: RequestHil;
}

/** What `resolveHil` needs from the eventual `hil_response` (T018 decides how/when it arrives). */
export type HilResolution = { optionId: string } | { cancelled: true };

export interface PermissionResponderHandle {
  /** Decides and answers (or defers to hil) one `session/request_permission`. Returns the decision made, for logging/tests. */
  handleRequest(requestId: AcpRequestId, request: AcpPermissionRequestParams): Promise<Decision>;
  /**
   * Resolves a pending `hil_request` by the id `requestHil` returned (the
   * hook T018 calls once a `hil_response` message arrives). Returns
   * `false` if no such request is pending (already resolved, wrong id, or
   * never went through this responder). Does not touch the written
   * message/record — see the file header on lifecycle ownership.
   */
  resolveHil(hilRequestId: string, resolution: HilResolution): Promise<boolean>;
  /** Count of ACP requests currently parked on a human answer — for tests and liveness/attention-queue reporting. */
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
  const message = validateMessage({
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
    ...(input.ticket !== undefined ? { ticket: input.ticket } : {}),
    body: input.summary,
    refs: [],
    requires_ack: true,
    deadline: input.deadline,
    hil_kind: input.hilKind,
  });
  await store.putEntity(hilInboxPath(id), validateMessage, message);
  return { id };
}

export function buildPermissionResponder(
  store: StateStore,
  ctx: PermissionResponderContext,
): PermissionResponderHandle {
  const pending = new Map<string, AcpRequestId>();
  const requestHil: RequestHil = ctx.requestHil ?? ((input) => defaultRequestHil(store, input));

  async function logDecision(
    request: AcpPermissionRequestParams,
    decision: Decision,
  ): Promise<void> {
    const classified = classifyPermissionRequest(request);
    await store.appendEvent(
      buildEvent('hook_decision', {
        ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}),
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
        },
      }),
    );
  }

  return {
    async handleRequest(requestId, request) {
      const decision = decidePermission({
        role: ctx.role,
        ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}),
        worktreePath: ctx.worktreePath,
        request,
      });

      if (decision.kind === 'allow' || decision.kind === 'deny') {
        // Respond before the (fallible) event-log write (review fix, opus
        // should-fix 9): a store hiccup must not leave the agent's turn
        // hung on an already-decided answer.
        ctx.session.respondPermission(requestId, selectOption(decision.optionId));
        await logDecision(request, decision);
        return decision;
      }

      await logDecision(request, decision);
      const deadline = new Date(
        Date.now() + (ctx.hilDeadlineMs ?? DEFAULT_HIL_DEADLINE_MS),
      ).toISOString();
      const { id } = await requestHil({
        ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}),
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
