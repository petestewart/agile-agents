/**
 * `decidePreToolUse` — the pure PreToolUse decision function (T009 —
 * design/agile-agents-design.md §6 "Enforcement tiers and hook catalog",
 * minimum hook/gate set: "pre-tool-use / any"; §5 "Comms bus" → "Delivery by
 * priority"; §4 "Ticket" → `budget`; §7 "Tool framework" → `read_summary`).
 *
 * Order (§6, this ticket's Scope line, in the order given):
 *   1. halt covering the agent's ticket -> deny with the halt reason plus
 *   2. urgent unacked inbox -> deny with the message body as the reason.
 *   3. normal inbox -> additionalContext with the bodies (capped), ack them.
 *   4. big raw Read/Grep (over `limits.maxReadBytes`/`maxGrepBytes`) -> deny
 *      "use read_summary(path, question)".
 *   5. role × tool policy via `decidePermission`, T010's whole pipeline
 *      reused whole (classify -> never-without-human -> role table — see
 *      `roleToolVerdict`'s doc comment below) for every edit-kind tool
 *      (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or any tool reporting
 *      `tool_input.kind === 'edit'`) and for `Bash` -> `hil` verdict maps
 *      to `ask`, `deny` maps to `deny`, `allow` falls through to step 7.
 *      Round 3 (opus item 1) replaced a Bash-only `checkNeverWithoutHuman`
 *      branch here: a reviewer's `Edit`/`Write`, and a reviewer's `Bash`
 *      running anything outside the read-only allow-list, used to reach
 *      this hook's step 7 `allow` untouched, because only ACP's separate
 *      "best-effort" permission layer (`permissions/index.ts`) ever
 *      consulted the role table — this tier (the actual enforcement
 *      backstop per that module's own file header) did not. Every role's
 *      command/edit policy — including the engineer's (git + repo scripts,
 *      per §14) — is now enforced here too, not only at ACP's tier 2.
 *   6. else allow.
 *
 * Review round fix (blocker 1): tier 3 (normal inbox) used to *return*
 * before tiers 4–6 ever ran, so a pending `answer` message let a big Read,
 * or a `git push origin main` sail through as
 * `allow` — context injection was silently overriding the gate. Tiers 1–2
 * still short-circuit (a halt or an urgent message pre-empts everything,
 * §6's tier table), but tier 3 is now **additive**: the gate verdict is
 * computed first from tiers 4–5 (`computeGateVerdict`), and a pending
 * normal message only ever *adds* `additionalContext` (+ acks) on top of
 * whatever that verdict already was — it can turn an `allow` into an
 * `allow` with context, or a `deny`/`ask` into the same `deny`/`ask` with
 * context, but it can never itself change `decision`. DESIGN-GAP: Claude's
 * hook docs don't explicitly confirm `additionalContext` is honoured
 * alongside a `deny`/`ask` `permissionDecision` (every capture to date only
 * exercises `additionalContext` on an `allow`) — attaching it unconditionally
 * is the simplest reading of "still deliver (attach the context to the deny
 * output if Claude accepts it, else keep the messages pending)"; if a live
 * run ever shows Claude drops `additionalContext` on a non-allow decision,
 * the fallback is to leave the messages unacked here (service.ts already
 * treats `ack` as this function's decision, not an unconditional side
 * effect) rather than silently losing them.
 *
 * Only one tier among 1/2/4/5 fires per call — the first one that matches
 * wins, same as §6's tier table reads (a halt pre-empts everything else, an
 * urgent message pre-empts the budget check, etc.). This mirrors
 * `decidePermission` (T010): a single pure function, side effects performed
 * by the caller.
 *
 * DESIGN-GAP (ack semantics for a `deny`-by-urgent-message, per this
 * ticket's Standing rules): §5 says urgent delivery is "until acknowledged"
 * but never says what un-blocks it — an urgent message with no other actor
 * to ack it would deny every tool call forever. Simplest reading adopted
 * here: the deny reason *is* the delivery (the model reads the body the
 * moment this decision denies the call), so the message is acked in the
 * same decision that surfaces it — `ack` carries its id, and `service.ts`
 * performs the actual `bus.ack` regardless of the tool call being denied.
 * The next tool call then sees the next-oldest urgent message, if any, or
 * falls through to the lower tiers.
 */

import {
  type ClassifierBands,
  DEFAULT_PROTECTED_BRANCHES,
  type Rule,
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
import type { RuleCheckContext } from '../permissions/rule-checks';
import { patternRulesOf, runPatternRules } from '../permissions/rule-checks';
import type { ClaudePreToolUsePayload, HookDecision, HookDecisionContext } from './types';

/**
 * The permission-table role a session role is judged under. The table
 * (`permissions/policy-tables.ts`) still speaks the ticket-era vocabulary;
 * a worker is judged as the old engineer, a reviewer as the old reviewer.
 * T131 owns replacing the reviewer half with the read-only policy of
 * cockpit design §4.2 — this mapping is the seam it lands on.
 */
export function permissionRoleFor(role: SessionRole): PermissionRole {
  // T141: the lessons session reads the stream's material and writes
  // nothing but proposals, so it runs under the reviewer's read-only policy.
  return role === 'reviewer' || role === 'lessons' ? 'reviewer' : 'engineer';
}

/** §5 "Delivery by priority": normal inbox is injected, capped so a burst of messages can't blow past the message-body-cap spirit for the whole context injection. Pointer, not payload — bodies are already ≤800 chars each (`MESSAGE_BODY_MAX_CHARS`), this just bounds how many get concatenated. */
const ADDITIONAL_CONTEXT_MAX_CHARS = 4000;

const READ_LIKE_TOOLS = new Set(['Read', 'Grep']);

function isReadLikeTool(toolName: string | undefined): boolean {
  return toolName !== undefined && READ_LIKE_TOOLS.has(toolName);
}

/** `tool_input.file_path`/`path` for Read; `tool_input.path` for Grep (a single-file target — a directory target is never size-gated, per §6/ticket: "Grep over a directory -> allow, over a huge file -> deny"). */
function targetPathOf(payload: ClaudePreToolUsePayload): string | undefined {
  const input = payload.tool_input ?? {};
  const value = input.file_path ?? input.path;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Every path a built-in tool call's `tool_input` names, across the shapes
 * Claude's own tools use — not just Read/Grep's single `targetPathOf`
 * (§ "Big raw Read/Grep" tier): `Glob`'s `path` names a search directory,
 * and every edit tool (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) names its
 * target the same `file_path`/`path`/`notebook_path` way. Exported so
 * `service.ts` (or a test) can enumerate candidates without re-deriving
 * Claude's tool_input shapes. Role-agnostic — this is "what paths does this
 * tool call touch", not "is any of them denied".
 */
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

/** Concatenates normal-priority bodies up to the cap, pointer-not-payload (each already capped at the message level). */
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

// ---------------------------------------------------------------------------
// Role × tool policy (review round 3, opus item 1) — reuses T010's whole
// `decidePermission` pipeline (classify -> never-without-human -> role
// table) instead of the old Bash-only `checkNeverWithoutHuman` branch. See
// this file's header for why: reviewer/QA edits and a reviewer's `Bash`
// both used to sail through to step 7's `allow` because the role table was
// never consulted for this hook at all — only ACP's separate, "best-effort"
// permission layer (`permissions/index.ts`) ever ran it.
// ---------------------------------------------------------------------------

/** Claude's own tool names for a file edit — `NotebookEdit` edits a `notebook_path`, the rest a `file_path`/`path`. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Synthetic two-option menu handed to `decidePermission` (T010 always picks between `allow_once`/`reject_once`, §14: "never `allow_always`") — a Claude hook call carries no ACP `options` of its own, so this fakes just enough of one for the function to run; the `optionId` it ends up picking is discarded below, only `decision.kind`/`reason` matter here. */
const SYNTHETIC_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'deny', kind: 'reject_once' },
];

/**
 * Maps a Claude hook tool call onto the ACP `AcpToolKind` `decidePermission`
 * classifies on. `undefined` for anything this policy doesn't (yet) gate at
 * this tier — Read/Grep (handled by tier 4's size gate and otherwise always
 * allowed for every role) and every other built-in (Glob, Task, WebFetch,
 * …) fall through unchanged to step 7's `allow`, exactly as before this
 * round; only edit-kind tools and `Bash` are newly routed through the role
 * table.
 */
function claudeToolKind(payload: ClaudePreToolUsePayload): AcpToolKind | undefined {
  if (payload.tool_name !== undefined && EDIT_TOOL_NAMES.has(payload.tool_name)) return 'edit';
  // Generic escape hatch (review instruction: "any tool with kind: edit") —
  // a custom/MCP tool that reports its own ACP-style kind on `tool_input`;
  // none of Claude's built-in tools do this today, but nothing here should
  // require a hardcoded name list to be exhaustive.
  if (payload.tool_input?.kind === 'edit') return 'edit';
  if (payload.tool_name === 'Bash') return 'execute';
  return undefined;
}

/** `rawInput` for the synthetic `AcpToolCall` — just enough of Claude's `tool_input` for `classifyPermissionRequest` to read a command/path back out. */
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

/**
 * The role × tool verdict for an edit-kind tool or `Bash`, or `undefined`
 * when this tool isn't one of those (the caller falls through to step 7).
 * `decidePermission`'s three outcomes map onto `HookVerdict` as: `allow` ->
 * fall through to the same `allow` step 7 would give anyway (`undefined`
 * here, not a duplicate `{decision:'allow'}`); `deny` -> `deny`; `hil` ->
 * `ask` (this hook's own vocabulary for "needs a human", translated into a
 * durable HIL request by `service.ts`).
 */
function roleToolVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision | undefined {
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
    request,
  });

  if (decision.kind === 'deny') return { decision: 'deny', reason: decision.reason };
  if (decision.kind === 'hil') return { decision: 'ask', reason: decision.reason };

  return undefined;
}

// ---------------------------------------------------------------------------
// Pattern rules (T143 — design §5.2's pattern tier, §5.4's built-ins, §8.1
// step 2). The hook consults the rules in scope, not a hardcoded table:
// each rule's `pattern.kind` has one checker in `permissions/rule-checks.ts`,
// a deny names the rule, and every rule the pass evaluated is reported back
// so `service.ts` can bump its `stats` (§5.7).
// ---------------------------------------------------------------------------

function commandOf(payload: ClaudePreToolUsePayload): string | undefined {
  const command = payload.tool_input?.command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

/** True when this tool call writes — the half of `no_worktree_escape` that is about paths (§5.4). */
function isWritingToolCall(payload: ClaudePreToolUsePayload): boolean {
  if (payload.tool_name !== undefined && EDIT_TOOL_NAMES.has(payload.tool_name)) return true;
  return payload.tool_input?.kind === 'edit';
}

/**
 * Tier 5b: the pattern rules in scope, in order, through the same
 * `runPatternRules` the ACP responder tier uses — so the deny wording and
 * the stats accounting cannot drift between the two enforcement tiers.
 * `undefined` when no pattern rule is in scope.
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

/** Tiers 4–5: the gate verdict, computed independently of any normal-priority inbox message pending — see this file's header, review round fix (blocker 1). */
function computeGateVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 4. Big raw Read/Grep — §7 "Tool framework": a matched raw call is
  // denied with the tool's redirect already named.
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
    // No resolvable path (Grep over a directory/pattern, or a path this
    // hook can't stat) — never size-gated; falls through to allow below.
  }

  // 5. Role × tool policy (review round 3, opus item 1) — reuses T010's
  // whole `decidePermission` pipeline for every edit-kind tool and for
  // `Bash`, replacing the old Bash-only `checkNeverWithoutHuman` branch.
  // See `roleToolVerdict`'s doc comment above for the mapping; `undefined`
  // means this tool isn't gated at this tier and falls through to step 7.
  const roleTool = roleToolVerdict(ctx, payload);
  if (roleTool !== undefined) return roleTool;

  // 5b. Pattern rules in scope (T143, §8.1 step 2). Reached only when the
  // role policy had nothing to say: a call the role table already denied or
  // routed is settled, and evaluating rules against it would bump their
  // stats for a call that never happened.
  const patternRule = patternRuleVerdict(ctx, payload);
  if (patternRule !== undefined) return patternRule;

  // 6. Else allow.
  return { decision: 'allow' };
}

export function decidePreToolUse(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 2. Urgent unacked inbox — oldest first (ctx.inbox is already ordered
  // urgent -> normal -> low, ties broken by ulid/send order per Bus.poll).
  const urgent = ctx.inbox.find((m) => m.priority === 'urgent');
  if (urgent) {
    return { decision: 'deny', reason: urgent.body, ack: [urgent.id] };
  }

  // Tiers 4–5, computed BEFORE tier 3 so a pending normal message can never
  // change the verdict (review round fix, blocker 1).
  const gate = computeGateVerdict(ctx, payload);

  // 3. Normal inbox — additive only: attaches additionalContext (+ acks) on
  // top of `gate`, whatever `gate` already decided (§5: "hook allows the
  // call and injects inbox as additional context" — extended here to "the
  // hook renders whatever decision it was going to render, PLUS injects
  // inbox as additional context").
  const normal = ctx.inbox.filter((m) => m.priority === 'normal');
  if (normal.length === 0) return gate;

  return {
    ...gate,
    additionalContext: buildAdditionalContext(normal),
    ack: normal.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// The classifier tier (T151 — design/cockpit-design.md §6, §8.1 step 3).
//
// Everything above is pure and synchronous; this is not, because the tier is
// one network round trip. It is kept here, next to the other tiers, because
// the *order* is the design (§8.1: role policy → pattern rules → classifier)
// and a tier that lived somewhere else would drift out of it. `service.ts`
// runs this only when the tiers above allowed the call, and owns every side
// effect it implies (stats, the `classifier_call` event, the
// `hook_unchecked` thread entry, the route).
// ---------------------------------------------------------------------------

/** A rule judged by the classifier, not by a pattern (§5.2). */
export function classifierRulesOf(rules: readonly Rule[] | undefined): Rule[] {
  return (rules ?? []).filter(
    (rule) => rule.enforcement === 'classifier' && rule.status === 'accepted',
  );
}

/**
 * §6.3's bands live in `classifier/bands.ts` and are re-exported here for
 * the hook's callers. T151 and T152 each grew a copy on their own branch;
 * one implementation is what §6.3 requires, so the hook uses the
 * classifier's — "the two can never disagree about what 0.8 means".
 */
export { bandFor as classifierBand, type ClassifierBand } from '../classifier';

/** How much of a diff or a file body goes into the state — enough to judge, not the whole file. */
const CLASSIFIER_STATE_MAX_CHARS = 4000;

function clip(text: string, max = CLASSIFIER_STATE_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * §6.2's state for a per-action check: "the tool name, the command or the
 * path plus the diff hunk, and one line naming the stream and repo".
 *
 * The scrub (§6.5) is **not** applied here — it runs inside the adapter, on
 * whatever state it is handed, so no caller can route around it.
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
  /** Every classifier rule this pass asked about — `stats.fired` for each (§5.7). */
  evaluated: string[];
  /** The rule this pass denied or routed on. */
  rule?: string;
  /** The deny/route reason, naming the rule — it reaches the model verbatim (§8.1). */
  reason?: string;
  /** Wall-clock time of the one call, for the `classifier_call` event (§6.2). */
  latency_ms: number;
  /** How many questions the one call carried — the one-call-N-questions property. */
  questions: number;
  /** §6.4: the rules that went unchecked because the call failed. */
  unchecked?: string[];
  /** Present when the call failed at all — already stringified. */
  error?: string;
}

export interface ClassifierTierInput {
  /** The accepted classifier rules in scope, in order. */
  rules: readonly Rule[];
  bands: ClassifierBands;
  classifier: Classifier;
  /** §6.2's state, already built (`buildClassifierState`). */
  state: string;
  now?: () => number;
}

/**
 * §8.1 step 3: one call, one Noul per rule, then §6.3's bands — with §6.4's
 * fail policy standing in for the answers the call could not produce.
 *
 * Precedence between rules is deny → route → allow, in rule order: the
 * first rule that says no is the answer, and a rule that wants a human
 * outranks the rules that were happy.
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
  let denied: { rule: Rule; reason: string } | undefined;
  let routed: { rule: Rule; reason: string } | undefined;

  for (const rule of rules) {
    const answer = byId.get(rule.id);
    if (answer === undefined) {
      // §6.4's fail policy, per rule: a rule the call could not answer for
      // — because the whole call failed, or because the response left it
      // out — denies when it is critical, and is otherwise unchecked.
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

/** How a rule is named in a reason the model reads — the short name when it has one, the id otherwise. */
function ruleLabel(rule: Rule): string {
  return rule.name !== undefined ? `${rule.name} (${rule.id})` : rule.id;
}
