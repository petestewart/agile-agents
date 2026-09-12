/**
 * ACP permission enforcement for the daemon's own EM vendor sessions (T041
 * review round 1, blocking finding — design §14 "Permissions per role", EM
 * row: read "state via daemon", write "sprints, assignments, policy
 * proposals" (MCP verbs only), run "none", network "none").
 *
 * Both EM sessions — the resident chat session (`resident.ts`) and the
 * one-shot gate delegate (`delegate.ts`) — are spawned directly rather than
 * through `runner/session.ts`'s `startAgentSession`, because neither is a
 * ticket session (no worktree, no `AgentRecord`, no ledger). But
 * `startAgentSession` was also the only place `buildPermissionResponder`
 * was ever attached, so without this module those sessions answer
 * `session/request_permission` with nothing at all. Two ways that bites:
 *
 *  1. `@agile-agents/acp-client` only auto-refuses an unanswered permission
 *     request when the session has **zero** listeners (`session.ts`'s
 *     `publicListenerCount === 0`). `resident.ts` attaches listeners (exit
 *     tracking, delta streaming), so that fail-closed fallback never fires
 *     and a gated vendor's request would hang until the turn timeout.
 *  2. On a vendor that does not gate exec/fs over ACP at all (Codex,
 *     design/spike-findings.md), the request never comes — which is exactly
 *     why the policy tier alone is not enough there and the session's own
 *     `cwd` (the repo root) is the blast radius. Nothing this module can do
 *     about that vendor; see the ticket report's note on hooks.
 *
 * What this does: answer EVERY `session/request_permission` through the same
 * `decidePermission`/policy-table path every other role uses, under role
 * `em` — allow reads, deny raw edits/execs/fetches — and never leave one
 * outstanding. A `hil` verdict (the never-without-human list, e.g. an exec
 * containing `git push`) has nowhere to park for an EM session: it is not a
 * ticket, there is no engineer waiting, and a chat turn must not block on a
 * human. So it is answered `cancelled` — refused, fail-closed — and logged.
 */

import type { AcpRequestId, SpawnedSession } from '@agile-agents/acp-client';
import { ulid } from '@agile-agents/shared';
import { type AcpPermissionRequestParams, buildPermissionResponder } from '../permissions';
import type { StateStore } from '../store';

const CANCELLED_RESULT = { outcome: { outcome: 'cancelled' } };

export interface EmPermissionGuardOptions {
  store: StateStore;
  session: SpawnedSession;
  /** The session's cwd (the repo root) — the containment root the policy's never-without-human checks measure paths against. */
  cwd: string;
  onNotice?: (line: string) => void;
}

/**
 * Attaches the `em`-role permission responder to an already-spawned EM
 * session. Returns the unsubscribe function (call it when the session is
 * dropped, like any other `session.on` listener).
 */
export function attachEmPermissionResponder(opts: EmPermissionGuardOptions): () => void {
  const notice = opts.onNotice ?? (() => {});
  let parkedHilId: string | undefined;

  const responder = buildPermissionResponder(opts.store, {
    role: 'em',
    agent: 'em',
    worktreePath: opts.cwd,
    session: opts.session,
    // Nothing may park on a human here (see the file header): record the id
    // so the caller below can immediately resolve it as cancelled. The
    // responder sets its own pending entry before `handleRequest` resolves,
    // so resolving after that await is race-free.
    requestHil: async () => {
      const id = ulid();
      parkedHilId = id;
      return { id };
    },
  });

  return opts.session.on((event) => {
    if (event.type !== 'event') return;
    const frame = event.event;
    if (frame.acp !== 'request' || frame.method !== 'session/request_permission') return;
    const requestId: AcpRequestId = frame.id;
    void (async () => {
      try {
        const decision = await responder.handleRequest(
          requestId,
          frame.params as AcpPermissionRequestParams,
        );
        if (decision.kind === 'hil') {
          const id = parkedHilId;
          parkedHilId = undefined;
          if (id !== undefined) await responder.resolveHil(id, { cancelled: true });
          notice(`em session permission refused (no human to ask): ${decision.reason}`);
        } else if (decision.kind === 'deny') {
          notice(`em session permission denied: ${decision.reason}`);
        }
      } catch (err) {
        // Fail closed, always: a store hiccup while logging must never
        // leave the vendor waiting on an answer that will never come.
        opts.session.respondPermission(requestId, CANCELLED_RESULT);
        notice(
          `em session permission handling failed, refused: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });
}
