/**
 * `buildPermissionResponder` — turns a `decidePermission` verdict into the
 * ACP `respondPermission` call (T010). Allow/deny answer the pending ACP
 * request immediately by selecting the chosen option's id; a `hil` verdict
 * instead writes a `hil_request` `Message` to the bus and leaves the ACP
 * request unanswered until `resolveHil` is called with the human's answer
 * (T018 owns the gate/attention-queue policy that decides *when* that
 * happens — this module only exposes the hook).
 *
 * Bus placement (design/agile-agents-design.md §5 "Storage":
 * `bus/inbox/<agent>/<ulid>.yaml`; ticket: "pick the §5 layout and
 * document"): written to `bus/inbox/human/<ulid>.yaml` — §5's routing rules
 * name `human` as the recipient of a `hil_request` ("anyone → human
 * (hil_request)"), so this follows the same `inbox/<agent>/` shape T006
 * uses for every other recipient rather than inventing a `hil/` path.
 */

import { join } from 'node:path';
import type { AcpRequestId } from '@agile-agents/acp-client';
import { type AgentId, type Message, type TicketId, validateMessage } from '@agile-agents/shared';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
import { classifyPermissionRequest } from './classify';
import { decidePermission } from './decide';
import type { AcpPermissionRequestParams, Decision, PermissionRole } from './types';
import { generateUlid } from './ulid';

/** Default time a human has to answer a `hil_request` before it's overdue. Not a CLAUDE.md tunable (none listed for this); kept local and overridable per ctx. */
export const DEFAULT_HIL_DEADLINE_MS = 60 * 60 * 1000;

/** The slice of `SpawnedSession` this module needs — kept minimal so a test can fake it without spawning a real agent. */
export interface PermissionResponderSession {
  respondPermission(id: AcpRequestId, result: unknown): boolean;
}

export interface PermissionResponderContext {
  role: PermissionRole;
  ticket: TicketId;
  /** Concrete bus identity of the agent this session belongs to (e.g. `eng-3`) — `role` alone isn't a valid `AgentId`. */
  agent: AgentId;
  worktreePath: string;
  session: PermissionResponderSession;
  hilDeadlineMs?: number;
}

/** What `resolveHil` needs from the eventual `hil_response` (T018 decides how/when it arrives). */
export type HilResolution = { optionId: string } | { cancelled: true };

export interface PermissionResponderHandle {
  /** Decides and answers (or defers to hil) one `session/request_permission`. Returns the decision made, for logging/tests. */
  handleRequest(requestId: AcpRequestId, request: AcpPermissionRequestParams): Promise<Decision>;
  /**
   * Resolves a pending `hil_request` by its message id (the hook T018 calls
   * once a `hil_response` message arrives). Returns `false` if no such
   * request is pending (already resolved, wrong id, or never went through
   * this responder).
   */
  resolveHil(hilMessageId: string, resolution: HilResolution): Promise<boolean>;
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

export function buildPermissionResponder(
  store: StateStore,
  ctx: PermissionResponderContext,
): PermissionResponderHandle {
  const pending = new Map<string, AcpRequestId>();

  async function logDecision(
    request: AcpPermissionRequestParams,
    decision: Decision,
  ): Promise<void> {
    const classified = classifyPermissionRequest(request);
    await store.appendEvent(
      buildEvent('hook_decision', {
        ticket: ctx.ticket,
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

  async function writeHilRequest(decision: Extract<Decision, { kind: 'hil' }>): Promise<Message> {
    const id = generateUlid();
    const deadline = new Date(
      Date.now() + (ctx.hilDeadlineMs ?? DEFAULT_HIL_DEADLINE_MS),
    ).toISOString();
    const message = validateMessage({
      id,
      ts: new Date().toISOString(),
      from: ctx.agent,
      to: ['human'],
      kind: 'hil_request',
      // hil_request blocks the requesting agent's turn until answered —
      // treated as urgent delivery (§5's priority table names `halt` and
      // `standup_call` explicitly but not `hil_request`; DESIGN-GAP,
      // resolved by analogy since this, too, blocks progress).
      priority: 'urgent',
      ticket: ctx.ticket,
      body: decision.hilRequest.summary,
      refs: [],
      requires_ack: true,
      deadline,
      hil_kind: decision.hilRequest.hilKind,
    });
    await store.putEntity(hilInboxPath(id), validateMessage, message);
    return message;
  }

  return {
    async handleRequest(requestId, request) {
      const decision = decidePermission({
        role: ctx.role,
        ticket: ctx.ticket,
        worktreePath: ctx.worktreePath,
        request,
      });
      await logDecision(request, decision);

      if (decision.kind === 'allow' || decision.kind === 'deny') {
        ctx.session.respondPermission(requestId, selectOption(decision.optionId));
        return decision;
      }

      const message = await writeHilRequest(decision);
      pending.set(message.id, requestId);
      return decision;
    },

    async resolveHil(hilMessageId, resolution) {
      const requestId = pending.get(hilMessageId);
      if (requestId === undefined) return false;
      pending.delete(hilMessageId);

      const result =
        'cancelled' in resolution ? CANCELLED_RESULT : selectOption(resolution.optionId);
      ctx.session.respondPermission(requestId, result);

      // Best-effort: clear the now-settled request out of the human's
      // inbox. T006 owns bus/** ack semantics generally; this only removes
      // the entity this responder itself wrote, so a double-resolve or a
      // message T006 already acked some other way is not an error here.
      try {
        await store.deleteEntity(hilInboxPath(hilMessageId));
      } catch {
        // already gone — fine.
      }
      return true;
    },

    pendingHilCount() {
      return pending.size;
    },
  };
}
