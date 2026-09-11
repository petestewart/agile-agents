/**
 * `decidePermission` — the one pure function this ticket exports (T010).
 * Classifies the raw ACP request, runs it through the never-without-human
 * list and then the role table (policy-tables.ts), and picks the ACP
 * option id for the result: **always `allow_once` for an allow, `reject_once`
 * for a deny, never `allow_always`** (§14 "Every permission decision is
 * logged with allow_once only").
 */

import { classifyPermissionRequest } from './classify';
import { checkNeverWithoutHuman, roleVerdict } from './policy-tables';
import type { AcpPermissionOption, Decision, DecisionContext, PermissionRequest } from './types';

function findOption(
  options: AcpPermissionOption[],
  kind: 'allow_once' | 'reject_once',
): AcpPermissionOption | undefined {
  return options.find((o) => o.kind === kind);
}

/** One line under the message body cap, for the `hil_request`'s summary and the logged reason. */
function summarize(classified: PermissionRequest, reason: string): string {
  const target =
    classified.command ?? classified.targetPath ?? classified.url ?? classified.title ?? '';
  const head = target ? `${classified.toolClass} "${target.slice(0, 200)}"` : classified.toolClass;
  return `${head}: ${reason}`.slice(0, 800);
}

/** `mcp__agile__<verb>` — the daemon's own MCP bridge, role-gated inside the verb. */
export function isDaemonVerb(title: string | undefined): boolean {
  return title !== undefined && /^mcp__agile__[a-z_]+$/.test(title);
}

export function decidePermission(ctx: DecisionContext): Decision {
  const classified = classifyPermissionRequest(ctx.request);
  const options = ctx.request.options ?? [];

  const policyCtx = { role: ctx.role, worktreePath: ctx.worktreePath, ticket: ctx.ticket };
  // The daemon's own MCP verbs (`mcp__agile__*`) are never gated here: each
  // verb enforces its own role rules server-side, and the vendor reports
  // them as kind `other`, which every role table denies as an unknown tool.
  // Fifteenth/sixteenth live runs (2026-09-11): a session whose hook config
  // had been stashed fell through to this tier and its engineer was locked
  // out of bus_send/board_post/test_run for the rest of the run.
  const neverVerdict = checkNeverWithoutHuman(classified, policyCtx);
  const verdict =
    neverVerdict ??
    (isDaemonVerb(classified.title)
      ? { action: 'allow' as const }
      : roleVerdict(ctx.role, classified, policyCtx));

  if (verdict.action === 'allow') {
    const option = findOption(options, 'allow_once');
    if (option === undefined) {
      // The agent offered no allow_once option at all — can't honor an
      // allow verdict safely, so fall back to reject_once (or hil if even
      // that is missing) rather than pick an allow_always/other option.
      const reject = findOption(options, 'reject_once');
      if (reject === undefined) {
        return {
          kind: 'hil',
          reason: 'no allow_once/reject_once option offered for an allow verdict',
          hilRequest: {
            hilKind: 'unblock',
            summary: summarize(classified, 'no safe option offered by the agent'),
            classified,
          },
        };
      }
      return { kind: 'deny', optionId: reject.optionId, reason: 'no allow_once option offered' };
    }
    return { kind: 'allow', optionId: option.optionId };
  }

  if (verdict.action === 'deny') {
    const option = findOption(options, 'reject_once');
    if (option === undefined) {
      return {
        kind: 'hil',
        reason: `${verdict.reason} (no reject_once option offered)`,
        hilRequest: {
          hilKind: 'unblock',
          summary: summarize(classified, verdict.reason),
          classified,
        },
      };
    }
    return { kind: 'deny', optionId: option.optionId, reason: verdict.reason };
  }

  return {
    kind: 'hil',
    reason: verdict.reason,
    hilRequest: {
      hilKind: 'unblock',
      summary: summarize(classified, verdict.reason),
      classified,
    },
  };
}
