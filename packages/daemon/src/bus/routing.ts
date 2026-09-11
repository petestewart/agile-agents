/**
 * Routing rules (design/agile-agents-design.md §5 "Comms bus" → "Routing
 * rules (daemon rejects the rest)"):
 *
 *   - engineer → em (question, discovery, escalate); → reviewer (review_request)
 *   - reviewer / qa → engineer (verdict), → em (copy)
 *   - architect → em; → ticket:* (decision); → broadcast (halt / resume)
 *   - em → anyone; human → anyone; anyone → human (hil_request)
 *   - Engineers never message each other directly. Cross-ticket needs go
 *     through the EM.
 *
 * T015 fix (grant): the bullet list above is §5's own "Routing rules"
 * subsection, but it is not the *only* place §5 names a sender/recipient
 * for a message kind — "Discovery -> standup -> resume" step 3 also does:
 * "Architect creates the halt file ... sends `halt`. Daemon fans out at
 * urgent. **Affected agents' next tool call is blocked; they commit/stash
 * WIP and reply `standup_report`**." The reply target is the standup owner
 * — "A standup = EM reads the board and writes a `decisions` stanza" (§4
 * "Board") and this ticket's own T015 scope line ("collect `standup_report`
 * messages via bus polling of em's inbox") both name `em` as that owner, so
 * this is `<affected agent> -> em (standup_report)`. Every role but
 * engineer already reaches `em` with *any* kind ("reviewer/qa -> em
 * (copy)"; architect -> em has no kind restriction below) — engineer is the
 * only sender-role §5 restricts to a fixed kind list, so `standup_report`
 * needed adding there and nowhere else. Re-checked every other kind §5
 * names against every row below (see the per-row citations that follow);
 * no other gap was found — nothing beyond `standup_report` on the engineer
 * row was added, and no row was widened past what its own citation says.
 *
 * "→ qa via em on done" (scope note) means an engineer never addresses qa
 * directly at all — only em can, which the generic `em → anyone` rule
 * already covers; no separate engineer→qa rule exists below.
 *
 * DESIGN-GAP: "reviewer/qa → engineer (verdict)" is read as *the specific*
 * verdict kind each role emits (`review_verdict` for reviewer,
 * `qa_verdict` for qa) rather than either kind from either role, since the
 * schema gives each role its own verdict kind and nothing in §5 or §12/§13
 * says a reviewer ever emits `qa_verdict` or vice versa.
 *
 * DESIGN-GAP: "Cross-ticket needs go through the EM" is a process norm, not
 * a checkable routing predicate — a `Message` doesn't carry the sender's
 * "home" ticket to compare against `message.ticket`. Not enforced here;
 * left as a comment rather than invented machinery.
 */

import type { AgentId, MessageKind } from '@agile-agents/shared';

export type Role = 'em' | 'architect' | 'engineer' | 'reviewer' | 'qa' | 'human' | 'daemon';

export function roleOf(id: string): Role {
  if (id === 'em' || id === 'architect' || id === 'human' || id === 'daemon') return id;
  if (id.startsWith('eng-')) return 'engineer';
  if (id.startsWith('reviewer-')) return 'reviewer';
  if (id.startsWith('qa-')) return 'qa';
  throw new Error(`routing: unrecognized agent id ${JSON.stringify(id)}`);
}

export interface RouteCheckInput {
  from: AgentId;
  /** One recipient token: an AgentId, `'broadcast'`, or `'ticket:TKT-...'`. */
  to: string;
  kind: MessageKind;
}

export interface RouteCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Kinds §5 names for `engineer -> em`: the "Routing rules" bullet's own
 * `(question, discovery, escalate)`, plus `standup_report` (§5 "Discovery
 * -> standup -> resume" step 3 — see the file header's T015-fix note). Named
 * for the recipient rather than "question kinds" now that it also covers a
 * reply, not just a question-shaped message.
 */
const ENGINEER_TO_EM_KINDS: readonly MessageKind[] = [
  'question',
  'discovery',
  'escalate',
  'standup_report',
];

/** Checks one (from, to, kind) edge against the §5 routing table. */
export function checkRoute({ from, to, kind }: RouteCheckInput): RouteCheckResult {
  const fromRole = roleOf(from);

  // "Engineers never message each other directly" — checked before the
  // generic em/human bypasses below since it's an absolute rule with no
  // sender-role exception (an engineer is never `em` or `human` anyway, but
  // stating it first keeps the rule visibly unconditional).
  if (fromRole === 'engineer' && to.startsWith('eng-')) {
    return {
      allowed: false,
      reason: 'engineers never message each other directly — route through em',
    };
  }

  // "em → anyone; human → anyone"
  if (fromRole === 'em' || fromRole === 'human') {
    return { allowed: true };
  }

  // daemon: system-originated messages (liveness escalation, redelivery
  // escalation, halt/resume broadcast) — not named in the human-team rule
  // list, so scoped to exactly what the daemon itself needs to send.
  if (fromRole === 'daemon') {
    if (to === 'em') return { allowed: true };
    if (to === 'broadcast' && (kind === 'halt' || kind === 'resume')) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'daemon may only message em, or broadcast halt/resume',
    };
  }

  // "anyone → human (hil_request)" — evaluated for every remaining sender
  // role (engineer, reviewer, qa, architect); em/human/daemon are handled above.
  if (to === 'human') {
    return kind === 'hil_request'
      ? { allowed: true }
      : { allowed: false, reason: 'only hil_request may be sent to human' };
  }

  if (to === 'broadcast') {
    if (fromRole === 'architect' && (kind === 'halt' || kind === 'resume')) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'broadcast is allowed only for halt/resume from em, architect, or daemon',
    };
  }

  if (to.startsWith('ticket:')) {
    if (fromRole === 'architect' && kind === 'decision') return { allowed: true };
    return {
      allowed: false,
      reason: 'ticket:* fan-out is allowed only for an architect decision',
    };
  }

  const toRole = roleOf(to);

  if (fromRole === 'engineer') {
    if (toRole === 'em' && ENGINEER_TO_EM_KINDS.includes(kind)) return { allowed: true };
    if (toRole === 'reviewer' && kind === 'review_request') return { allowed: true };
    return {
      allowed: false,
      reason:
        'engineer may only send question/discovery/escalate/standup_report to em, or review_request to reviewer',
    };
  }

  if (fromRole === 'reviewer') {
    if (toRole === 'engineer' && kind === 'review_verdict') return { allowed: true };
    if (toRole === 'em') return { allowed: true };
    return {
      allowed: false,
      reason: 'reviewer may only send review_verdict to engineer, or copy em',
    };
  }

  if (fromRole === 'qa') {
    if (toRole === 'engineer' && kind === 'qa_verdict') return { allowed: true };
    if (toRole === 'em') return { allowed: true };
    return {
      allowed: false,
      reason: 'qa may only send qa_verdict to engineer, or copy em',
    };
  }

  if (fromRole === 'architect') {
    if (toRole === 'em') return { allowed: true };
    return {
      allowed: false,
      reason: 'architect may only message em directly (or ticket:*/broadcast, handled above)',
    };
  }

  return { allowed: false, reason: `no routing rule permits ${fromRole} -> ${toRole} (${kind})` };
}
