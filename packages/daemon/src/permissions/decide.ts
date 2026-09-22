/**
 * `decidePermission` — the one pure function this ticket exports (T010).
 * Classifies the raw ACP request, runs it through the never-without-human
 * list, the role table (policy-tables.ts) and then T143's **pattern rules**
 * in scope (`rule-checks.ts`, the same pass `hook/decide.ts` runs), and
 * picks the ACP option id for the result: **always `allow_once` for an allow, `reject_once`
 * for a deny, never `allow_always`** (§14 "Every permission decision is
 * logged with allow_once only").
 */

import { DEFAULT_PROTECTED_BRANCHES } from '@agile-agents/shared';
import { classifyPermissionRequest } from './classify';
import { checkNeverWithoutHuman, roleVerdict } from './policy-tables';
import { type RuleCheckContext, runPatternRules } from './rule-checks';
import type { AcpPermissionOption, Decision, DecisionContext, PermissionRequest } from './types';

function findOption(
  options: AcpPermissionOption[],
  kind: 'allow_once' | 'reject_once',
): AcpPermissionOption | undefined {
  return options.find((o) => o.kind === kind);
}

/** One line under the message body cap, for the gate's summary and the logged reason. */
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

/**
 * The `RuleCheckContext` for one classified ACP request. `toolClass:
 * 'edit'` is the write case `path_deny`'s worktree boundary is about; every
 * path the request names is checked, not just the first
 * (`classified.targetPaths` is the full `toolCall.locations` list).
 */
function ruleCheckContext(ctx: DecisionContext, classified: PermissionRequest): RuleCheckContext {
  const paths =
    classified.targetPaths ?? (classified.targetPath !== undefined ? [classified.targetPath] : []);
  return {
    worktreePath: ctx.worktreePath,
    ...(classified.command !== undefined ? { command: classified.command } : {}),
    paths,
    writes: classified.toolClass === 'edit',
    protectedBranches: ctx.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
    upstream: ctx.upstreamBranch ?? (() => undefined),
    head: ctx.headBranch ?? (() => undefined),
  };
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

  // T143: the pattern rules in scope (§5.2's pattern tier, §5.4's
  // built-ins), evaluated only for a call the role table already cleared —
  // a denied or routed call is settled, and charging rules' stats for it
  // would count a call that never happened. This tier matters because it is
  // the *only* gate for a vendor with no pre-tool-use hook (Cursor, Codex,
  // Grok — §4.3): without it, `no_push_protected` would not exist for them.
  const rulePass =
    verdict.action === 'allow'
      ? runPatternRules(ctx.patternRules, ruleCheckContext(ctx, classified))
      : undefined;
  const rulesEvaluated =
    rulePass !== undefined && rulePass.rulesEvaluated.length > 0
      ? rulePass.rulesEvaluated
      : undefined;

  if (rulePass?.reason !== undefined) {
    const option = findOption(options, 'reject_once');
    if (option === undefined) {
      return {
        kind: 'hil',
        reason: `${rulePass.reason} (no reject_once option offered)`,
        hilRequest: {
          hilKind: 'classifier_review',
          summary: summarize(classified, rulePass.reason),
          classified,
        },
      };
    }
    return {
      kind: 'deny',
      optionId: option.optionId,
      reason: rulePass.reason,
      ...(rulesEvaluated !== undefined ? { rulesEvaluated } : {}),
      ...(rulePass.ruleViolated !== undefined ? { ruleViolated: rulePass.ruleViolated } : {}),
    };
  }

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
            hilKind: 'classifier_review',
            summary: summarize(classified, 'no safe option offered by the agent'),
            classified,
          },
        };
      }
      return { kind: 'deny', optionId: reject.optionId, reason: 'no allow_once option offered' };
    }
    return {
      kind: 'allow',
      optionId: option.optionId,
      ...(rulesEvaluated !== undefined ? { rulesEvaluated } : {}),
    };
  }

  if (verdict.action === 'deny') {
    const option = findOption(options, 'reject_once');
    if (option === undefined) {
      return {
        kind: 'hil',
        reason: `${verdict.reason} (no reject_once option offered)`,
        hilRequest: {
          hilKind: 'classifier_review',
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
      hilKind: 'classifier_review',
      summary: summarize(classified, verdict.reason),
      classified,
    },
  };
}
