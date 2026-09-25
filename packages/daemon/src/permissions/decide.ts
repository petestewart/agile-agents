/**
 * `decidePermission`: classifies the raw ACP request, runs the
 * never-without-human list, the role table and then the pattern rules in
 * scope (the same pass as `hook/decide.ts`), and picks the ACP option:
 * `allow_once` for an allow, `reject_once` for a deny, never
 * `allow_always` (§14).
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

/** A `hil` decision: the route band's `classifier_review` draft. */
function hil(classified: PermissionRequest, reason: string, why = reason): Decision {
  return {
    kind: 'hil',
    reason,
    hilRequest: { hilKind: 'classifier_review', summary: summarize(classified, why), classified },
  };
}

/** `mcp__agile__<verb>` — the daemon's own MCP bridge, role-gated inside the verb. */
export function isDaemonVerb(title: string | undefined): boolean {
  return title !== undefined && /^mcp__agile__[a-z_]+$/.test(title);
}

/** The `RuleCheckContext` for one request: every path it names, and `edit` as the write case. */
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

  const policyCtx = {
    role: ctx.role,
    worktreePath: ctx.worktreePath,
    ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
    ...(ctx.hiddenRoots !== undefined ? { hiddenRoots: ctx.hiddenRoots } : {}),
  };
  // The daemon's own MCP verbs are never gated here: each enforces its own
  // role rules, and the vendor reports them as kind `other`, which every
  // role table denies (a live run's hook-less session was locked out of
  // its own verbs).
  // P20 (T280): a coordinator's table is stricter than the never list
  // (only its scratch session dir, which sits under `.agile/`), so it
  // decides alone: a write it allows is in the scratch dir, one it denies
  // is never a human prompt.
  const neverVerdict =
    ctx.role === 'coordinator' ? undefined : checkNeverWithoutHuman(classified, policyCtx);
  const verdict =
    neverVerdict ??
    (isDaemonVerb(classified.title)
      ? { action: 'allow' as const }
      : roleVerdict(ctx.role, classified, policyCtx));

  // The pattern rules (§5.2, §5.4), only for a call the role table cleared
  // or held (a settled call must not bump stats; a rule's deny beats a hold,
  // T343). The only gate a hook-less vendor (Cursor, Codex, Grok, §4.3) has.
  const rulePass =
    verdict.action !== 'deny'
      ? runPatternRules(ctx.patternRules, ruleCheckContext(ctx, classified))
      : undefined;
  const rulesEvaluated =
    rulePass !== undefined && rulePass.rulesEvaluated.length > 0
      ? rulePass.rulesEvaluated
      : undefined;

  if (rulePass?.reason !== undefined) {
    const option = findOption(options, 'reject_once');
    if (option === undefined)
      return hil(classified, `${rulePass.reason} (no reject_once option offered)`, rulePass.reason);
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
      // No allow_once offered: never pick allow_always; reject, or hil if even that is missing.
      const reject = findOption(options, 'reject_once');
      if (reject === undefined) {
        return hil(
          classified,
          'no allow_once/reject_once option offered for an allow verdict',
          'no safe option offered by the agent',
        );
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
    if (option === undefined)
      return hil(classified, `${verdict.reason} (no reject_once option offered)`, verdict.reason);
    return { kind: 'deny', optionId: option.optionId, reason: verdict.reason };
  }

  return hil(classified, verdict.reason);
}
