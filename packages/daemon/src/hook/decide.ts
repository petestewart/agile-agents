/**
 * `decidePreToolUse`: the pure PreToolUse decision function. Side effects
 * (acks, stats, events) are the caller's (`service.ts`). In order:
 *
 *   1. urgent unacked inbox → deny with the message body as the reason,
 *      acked in the same decision (the deny reason is the delivery; an
 *      urgent message nobody acks would otherwise deny every call forever);
 *   2. big raw Read/Grep (over `limits.maxReadBytes`/`maxGrepBytes`) → deny;
 *   2b. repo visibility (P13): a private repo's path outside the listed
 *      projects, or a write into any repo but the node's own → deny;
 *   3. role × tool policy through `decidePermission` for edit-kind tools and
 *      `Bash` (`hil` → `ask`, `deny` → `deny`), so every role's policy is
 *      enforced at the hook, not only at the ACP tier;
 *   4. pattern rules in scope;
 *   5. else allow.
 *
 * The normal-priority inbox is additive: steps 2-5 are computed first, and
 * pending messages only add `additionalContext` (+ acks) to whatever that
 * verdict was, never change it (a pending message once let a push to
 * `main` through as `allow`).
 */

import {
  type ClassifierBands,
  DEFAULT_PROTECTED_BRANCHES,
  type KnowledgeItem,
  type SessionRole,
} from '@agile-agents/shared';
import {
  type Answer,
  type Classifier,
  type ClassifierBand,
  type Noul,
  bandFor as classifierBand,
  noulFor,
} from '../classifier';
import { decidePermission } from '../permissions';
import type {
  AcpPermissionOption,
  AcpPermissionRequestParams,
  AcpToolCall,
  AcpToolKind,
} from '../permissions';
import type { PermissionRole } from '../permissions';
import { readDenyReason } from '../permissions/policy-tables';
import type { RuleCheckContext } from '../permissions/rule-checks';
import { patternRulesOf, runPatternRules } from '../permissions/rule-checks';
import { commandPaths, visibilityDenyReason } from '../permissions/visibility';
import type { ClaudePreToolUsePayload, HookDecision, HookDecisionContext } from './types';

/**
 * The permission-table role a session role is judged under: the table
 * speaks the older vocabulary (a worker is the engineer). The lessons
 * session writes nothing but proposals, so it gets the reviewer's policy.
 */
export function permissionRoleFor(role: SessionRole): PermissionRole {
  return role === 'reviewer' || role === 'lessons' ? 'reviewer' : 'engineer';
}

/** Caps the concatenated normal-priority bodies injected as context (each is already capped). */
const ADDITIONAL_CONTEXT_MAX_CHARS = 4000;

const READ_LIKE_TOOLS = new Set(['Read', 'Grep']);

function isReadLikeTool(toolName: string | undefined): boolean {
  return toolName !== undefined && READ_LIKE_TOOLS.has(toolName);
}

/** `tool_input.file_path`/`path` for Read/Grep: a directory target is never size-gated. */
function targetPathOf(payload: ClaudePreToolUsePayload): string | undefined {
  const input = payload.tool_input ?? {};
  const value = input.file_path ?? input.path;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Every path a built-in tool call's `tool_input` names (`file_path`, `path`, `notebook_path`). */
const PATH_BEARING_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

export function pathsForToolCall(payload: ClaudePreToolUsePayload): string[] {
  if (payload.tool_name === undefined || !PATH_BEARING_TOOL_NAMES.has(payload.tool_name)) {
    return [];
  }
  const input = payload.tool_input ?? {};
  const candidates = [input.file_path, input.path, input.notebook_path].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return [...new Set(candidates)];
}

function formatInboxBody(message: HookDecisionContext['inbox'][number]): string {
  return `[${message.kind} from ${message.from}] ${message.body}`;
}

/** Concatenates normal-priority bodies up to the cap. */
function buildAdditionalContext(messages: HookDecisionContext['inbox']): string {
  const lines: string[] = [];
  let total = 0;
  for (const message of messages) {
    const line = formatInboxBody(message);
    if (total + line.length > ADDITIONAL_CONTEXT_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

// Role × tool policy: `decidePermission`'s pipeline (classify →
// never-without-human → role table), for edit-kind tools and `Bash`.

/** Claude's own file-edit tool names. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A synthetic allow/reject menu so `decidePermission` can run on a hook call (which has no ACP `options`); only its `kind`/`reason` are used. */
const SYNTHETIC_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'deny', kind: 'reject_once' },
];

/**
 * Maps a Claude tool call onto the ACP kind `decidePermission` classifies.
 * `undefined` for anything not gated here (Read/Grep have the size gate;
 * Glob, Task, WebFetch, ... are allowed).
 */
function claudeToolKind(payload: ClaudePreToolUsePayload): AcpToolKind | undefined {
  if (payload.tool_name !== undefined && EDIT_TOOL_NAMES.has(payload.tool_name)) return 'edit';
  // A custom/MCP tool that reports its own ACP-style kind.
  if (payload.tool_input?.kind === 'edit') return 'edit';
  if (payload.tool_name === 'Bash') return 'execute';
  return undefined;
}

/** Just enough of `tool_input` for `classifyPermissionRequest` to read the command or path back. */
function claudeToolRawInput(
  kind: AcpToolKind,
  payload: ClaudePreToolUsePayload,
): Record<string, unknown> {
  const input = payload.tool_input ?? {};
  if (kind === 'execute') {
    return typeof input.command === 'string' ? { command: input.command } : {};
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  return typeof path === 'string' ? { file_path: path } : {};
}

/** Claude's built-in read tools: their paths go through the same read allow-list as Bash's. */
const BUILT_IN_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

/** T213: the deny reason for a built-in read outside what this node may read. */
function builtInReadDenyReason(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): string | undefined {
  if (payload.tool_name === undefined || !BUILT_IN_READ_TOOLS.has(payload.tool_name)) {
    return undefined;
  }
  const input = payload.tool_input ?? {};
  const paths = [input.file_path, input.path, input.notebook_path].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  const policy = {
    worktreePath: ctx.worktreePath,
    ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
    ...(ctx.hiddenRoots !== undefined ? { hiddenRoots: ctx.hiddenRoots } : {}),
  };
  for (const raw of paths) {
    const reason = readDenyReason(raw, policy);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * The role × tool verdict: `deny` → `deny`, `hil` → `ask` (translated into
 * the route band by `service.ts`), `allow` → `undefined` (fall through).
 */
function roleToolVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision | undefined {
  const readDenied = builtInReadDenyReason(ctx, payload);
  if (readDenied !== undefined) return { decision: 'deny', reason: readDenied };
  const kind = claudeToolKind(payload);
  if (kind === undefined) return undefined;

  const toolCall: AcpToolCall = {
    kind,
    title: payload.tool_name,
    rawInput: claudeToolRawInput(kind, payload),
  };
  const request: AcpPermissionRequestParams = { toolCall, options: SYNTHETIC_OPTIONS };
  const decision = decidePermission({
    role: permissionRoleFor(ctx.role),
    worktreePath: ctx.worktreePath,
    ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
    ...(ctx.hiddenRoots !== undefined ? { hiddenRoots: ctx.hiddenRoots } : {}),
    request,
  });

  if (decision.kind === 'deny') return { decision: 'deny', reason: decision.reason };
  if (decision.kind === 'hil') return { decision: 'ask', reason: decision.reason };

  return undefined;
}

// Pattern rules (§5.2, §5.4, §8.1 step 2): each `pattern.kind` has one
// checker in `permissions/rule-checks.ts`; a deny names the rule, and every
// rule evaluated is reported for its stats (§5.7).

function commandOf(payload: ClaudePreToolUsePayload): string | undefined {
  const command = payload.tool_input?.command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

/** This call writes: the path half of `no_worktree_escape` (§5.4). */
function isWritingToolCall(payload: ClaudePreToolUsePayload): boolean {
  if (payload.tool_name !== undefined && EDIT_TOOL_NAMES.has(payload.tool_name)) return true;
  return payload.tool_input?.kind === 'edit';
}

/**
 * The pattern rules in scope through the same `runPatternRules` the ACP
 * tier uses, so deny wording and stats cannot drift between tiers.
 * `undefined` when none is in scope.
 */
function patternRuleVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision | undefined {
  const rules = patternRulesOf(ctx.patternRules);
  if (rules.length === 0) return undefined;

  const command = commandOf(payload);
  const checkCtx: RuleCheckContext = {
    worktreePath: ctx.worktreePath,
    ...(command !== undefined ? { command } : {}),
    paths: pathsForToolCall(payload),
    writes: isWritingToolCall(payload),
    protectedBranches: ctx.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
    upstream: ctx.upstreamBranch ?? (() => undefined),
    head: ctx.headBranch ?? (() => undefined),
  };

  const outcome = runPatternRules(rules, checkCtx);
  if (outcome.reason !== undefined) {
    return {
      decision: 'deny',
      reason: outcome.reason,
      rulesEvaluated: outcome.rulesEvaluated,
      ...(outcome.ruleViolated !== undefined ? { ruleViolated: outcome.ruleViolated } : {}),
    };
  }
  return { decision: 'allow', rulesEvaluated: outcome.rulesEvaluated };
}

/** Steps 2-4: the gate verdict, independent of any pending normal-priority message. */
function computeGateVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 2. Big raw Read/Grep.
  if (isReadLikeTool(payload.tool_name)) {
    const path = targetPathOf(payload);
    if (path !== undefined) {
      const size = ctx.fileSize(path);
      const limit =
        payload.tool_name === 'Grep'
          ? (ctx.limits.maxGrepBytes ?? ctx.limits.maxReadBytes)
          : ctx.limits.maxReadBytes;
      if (size !== undefined && size > limit) {
        return {
          decision: 'deny',
          reason: `${path} is ${size} bytes (over the ${limit}-byte raw-read limit); use read_summary(path, question) via MCP instead.`,
        };
      }
    }
    // No resolvable path (a directory, or unstattable): not size-gated.
  }

  // 2b. Repo visibility (P13), a built-in path check.
  if (ctx.visibility !== undefined) {
    const command = payload.tool_name === 'Bash' ? commandOf(payload) : undefined;
    const shell = command !== undefined ? commandPaths(command) : { reads: [], writes: [] };
    const reason =
      visibilityDenyReason(ctx.visibility, pathsForToolCall(payload), isWritingToolCall(payload)) ??
      visibilityDenyReason(ctx.visibility, shell.writes, true) ??
      visibilityDenyReason(ctx.visibility, shell.reads, false);
    if (reason !== undefined) return { decision: 'deny', reason };
  }

  // 3. Role × tool policy.
  const roleTool = roleToolVerdict(ctx, payload);
  if (roleTool !== undefined) {
    // A role-policy deny that an accepted pattern rule also covers names
    // the rule: the human wrote it for exactly this call. Same verdict,
    // better reason, and the rule's stats count it. A rule's deny also beats
    // a role hold (T343): the human already said no to this call.
    if (roleTool.decision === 'deny' || roleTool.decision === 'ask') {
      const byRule = patternRuleVerdict(ctx, payload);
      if (byRule?.decision === 'deny') return byRule;
    }
    return roleTool;
  }

  // 4. Pattern rules, only when the role policy had nothing to say: a
  // settled call must not bump rule stats for a call that never happened.
  const patternRule = patternRuleVerdict(ctx, payload);
  if (patternRule !== undefined) return patternRule;

  // 5. Else allow.
  return { decision: 'allow' };
}

export function decidePreToolUse(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 1. Urgent unacked inbox, oldest first (`Bus.poll` orders by priority then send order).
  const urgent = ctx.inbox.find((m) => m.priority === 'urgent');
  if (urgent) {
    return { decision: 'deny', reason: urgent.body, ack: [urgent.id] };
  }

  // Steps 2-4 before the normal inbox, so a pending message can't change the verdict.
  const gate = computeGateVerdict(ctx, payload);

  // Normal inbox: additive, on top of whatever `gate` decided (§5: inject
  // the inbox as additional context).
  // DESIGN-GAP: Claude isn't confirmed to honour `additionalContext` on a
  // deny/ask; if it drops it, leave the messages unacked here instead.
  const normal = ctx.inbox.filter((m) => m.priority === 'normal');
  if (normal.length === 0) return gate;

  return {
    ...gate,
    additionalContext: buildAdditionalContext(normal),
    ack: normal.map((m) => m.id),
  };
}

// The classifier tier (§6, §8.1 step 3). Async (one network round trip),
// but kept beside the other tiers because the order is the design. The
// caller runs it only when the tiers above allowed the call, and owns
// every side effect.

/** An `action` item judged by the classifier, not by a pattern (§6). */
export function classifierRulesOf(rules: readonly KnowledgeItem[] | undefined): KnowledgeItem[] {
  return (rules ?? []).filter(
    (rule) =>
      rule.enforcement === 'action' &&
      rule.check?.by === 'classifier' &&
      rule.status === 'accepted',
  );
}

/** How much of a diff or file body goes into the state: enough to judge. */
const CLASSIFIER_STATE_MAX_CHARS = 4000;

function clip(text: string, max = CLASSIFIER_STATE_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * §6.2's state for a per-action check: the tool, the command or the paths
 * plus the diff hunk, and one line naming the stream and repo. The scrub
 * (§6.5) runs inside the adapter, so no caller can route around it.
 */
export function buildClassifierState(
  ctx: Pick<HookDecisionContext, 'stream' | 'worktreePath'> & { repo?: string },
  payload: ClaudePreToolUsePayload,
): string {
  const lines: string[] = [`tool: ${payload.tool_name ?? 'unknown'}`];
  const command = commandOf(payload);
  if (command !== undefined) {
    lines.push(`command: ${clip(command)}`);
  } else {
    for (const path of pathsForToolCall(payload)) lines.push(`path: ${path}`);
    const diff = diffHunkOf(payload);
    if (diff !== undefined) lines.push('diff:', clip(diff));
  }
  lines.push(`stream: ${ctx.stream}${ctx.repo !== undefined ? ` · repo: ${ctx.repo}` : ''}`);
  return lines.join('\n');
}

/** The change an edit-kind tool call proposes, in the shapes Claude's own edit tools use. */
function diffHunkOf(payload: ClaudePreToolUsePayload): string | undefined {
  const input = payload.tool_input ?? {};
  const parts: string[] = [];
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  for (const raw of edits) {
    const edit = (raw ?? {}) as Record<string, unknown>;
    if (typeof edit.old_string === 'string') parts.push(prefixLines('-', edit.old_string));
    if (typeof edit.new_string === 'string') parts.push(prefixLines('+', edit.new_string));
  }
  // `Write` (and `NotebookEdit`) carry the whole new body instead.
  const content = input.content ?? input.new_source;
  if (parts.length === 0 && typeof content === 'string') parts.push(prefixLines('+', content));
  return parts.length === 0 ? undefined : parts.join('\n');
}

function prefixLines(marker: string, text: string): string {
  return text
    .split('\n')
    .map((line) => `${marker}${line}`)
    .join('\n');
}

/** What one classifier tier pass decided, plus everything its caller has to record. */
export interface ClassifierTierOutcome {
  /** `deny`/`route` name a rule; `allow` is the whole set passing. */
  band: ClassifierBand;
  /** Every classifier rule asked about: `stats.fired` for each (§5.7). */
  evaluated: string[];
  /** The rule this pass denied or routed on. */
  rule?: string;
  /** The deny/route reason naming the rule; reaches the model verbatim. */
  reason?: string;
  /** Wall-clock time of the one call (§6.2). */
  latency_ms: number;
  /** Questions carried by the one call. */
  questions: number;
  /** §6.4: the rules that went unchecked because the call failed. */
  unchecked?: string[];
  /** Present when the call failed. */
  error?: string;
}

export interface ClassifierTierInput {
  /** The accepted classifier rules in scope, in order. */
  rules: readonly KnowledgeItem[];
  bands: ClassifierBands;
  classifier: Classifier;
  /** §6.2's state (`buildClassifierState`). */
  state: string;
  now?: () => number;
}

/**
 * §8.1 step 3: one call, one Noul per rule, §6.3's bands, and §6.4's fail
 * policy for answers the call could not produce. Precedence is deny →
 * route → allow, in rule order.
 */
export async function decideClassifierTier(
  input: ClassifierTierInput,
): Promise<ClassifierTierOutcome> {
  const now = input.now ?? Date.now;
  const rules = input.rules;
  const questions: Noul[] = rules.map(noulFor);
  const evaluated = rules.map((rule) => rule.id);

  const started = now();
  let answers: Answer[] | undefined;
  let error: string | undefined;
  try {
    answers = await input.classifier.ask(input.state, questions);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const latency_ms = now() - started;

  const byId = new Map((answers ?? []).map((answer) => [answer.id, answer]));
  const unchecked: string[] = [];
  let denied: { rule: KnowledgeItem; reason: string } | undefined;
  let routed: { rule: KnowledgeItem; reason: string } | undefined;

  for (const rule of rules) {
    const answer = byId.get(rule.id);
    if (answer === undefined) {
      // §6.4 per rule: no answer (failed call, or left out) denies a
      // critical rule and leaves any other unchecked.
      if (rule.critical) {
        denied ??= {
          rule,
          reason: `${ruleLabel(rule)} is a critical classifier rule and the classifier could not answer (${error ?? 'no answer returned'}); the call is denied until it can.`,
        };
      } else {
        unchecked.push(rule.id);
      }
      continue;
    }
    const band = classifierBand(answer, input.bands);
    if (band === 'deny') {
      denied ??= {
        rule,
        reason: `${ruleLabel(rule)}: ${rule.text}`,
      };
    } else if (band === 'route') {
      routed ??= { rule, reason: `${ruleLabel(rule)}: ${rule.text}` };
    }
  }

  const base = {
    evaluated,
    latency_ms,
    questions: questions.length,
    ...(unchecked.length > 0 ? { unchecked } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  if (denied !== undefined) {
    return { ...base, band: 'deny', rule: denied.rule.id, reason: denied.reason };
  }
  if (routed !== undefined) {
    return { ...base, band: 'route', rule: routed.rule.id, reason: routed.reason };
  }
  return { ...base, band: 'allow' };
}

/** A rule as named in a reason: `name (id)`, or the id. */
function ruleLabel(rule: KnowledgeItem): string {
  return rule.name !== undefined ? `${rule.name} (${rule.id})` : rule.id;
}
