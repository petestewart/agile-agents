/**
 * `decidePreToolUse` — the pure PreToolUse decision function (T009 —
 * design/agile-agents-design.md §6 "Enforcement tiers and hook catalog",
 * minimum hook/gate set: "pre-tool-use / any"; §5 "Comms bus" → "Delivery by
 * priority"; §4 "Ticket" → `budget`; §7 "Tool framework" → `read_summary`).
 *
 * Order (§6, this ticket's Scope line, in the order given):
 *   1. halt covering the agent's ticket -> deny with the halt reason plus
 *      the standup_report to send; that one bus_send is allowed (`haltVerdict`).
 *   2. urgent unacked inbox -> deny with the message body as the reason.
 *   3. normal inbox -> additionalContext with the bodies (capped), ack them.
 *   4. big raw Read/Grep (over `limits.maxReadBytes`/`maxGrepBytes`) -> deny
 *      "use read_summary(path, question)".
 *   5. budget: `spent_tokens >= ceiling_tokens` -> deny.
 *   6. role × tool policy via `decidePermission`, T010's whole pipeline
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
 *   7. else allow.
 *
 * Review round fix (blocker 1): tier 3 (normal inbox) used to *return*
 * before tiers 4–6 ever ran, so a pending `answer` message let a big Read,
 * an over-budget ticket, or a `git push origin main` sail through as
 * `allow` — context injection was silently overriding the gate. Tiers 1–2
 * still short-circuit (a halt or an urgent message pre-empts everything,
 * §6's tier table), but tier 3 is now **additive**: the gate verdict is
 * computed first from tiers 4–6 (`computeGateVerdict`), and a pending
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
 * Only one tier among 1/2/4/5/6 fires per call — the first one that matches
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

import type { Halt } from '@agile-agents/shared';
import { decidePermission } from '../permissions';
import type {
  AcpPermissionOption,
  AcpPermissionRequestParams,
  AcpToolCall,
  AcpToolKind,
} from '../permissions';
// Not re-exported from `../permissions` (its `index.ts` is out of this
// ticket's ownership) — imported directly from the module that defines it.
import { qaBashPathVerdict } from '../permissions/policy-tables';
import { matchesAnyPattern, resolveRelToWorktree } from '../qa/deny';
import type { ClaudePreToolUsePayload, HookDecision, HookDecisionContext } from './types';

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
    role: ctx.role,
    ticket: ctx.ticket,
    worktreePath: ctx.worktreePath,
    request,
  });

  if (decision.kind === 'deny') return { decision: 'deny', reason: decision.reason };
  if (decision.kind === 'hil') return { decision: 'ask', reason: decision.reason };

  // `decidePermission`'s own `PolicyContext` (built inside
  // `permissions/decide.ts`, out of this ticket's ownership) carries only
  // `{role, worktreePath, ticket}` — no room for a per-ticket deny list
  // without touching that module. So the QA Bash-path check (§14: `cat`/
  // `head`/`grep` of a contract path reaches the file just as readily as a
  // raw `Read`) runs as an ADDITIONAL check here, using the deny list
  // `service.ts` already resolved onto `ctx.denyReadPaths` for the read-path
  // seam above — not folded into `decidePermission`'s own role-table walk.
  if (
    kind === 'execute' &&
    ctx.role === 'qa' &&
    ctx.denyReadPaths &&
    ctx.denyReadPaths.length > 0 &&
    payload.tool_input?.command !== undefined &&
    typeof payload.tool_input.command === 'string'
  ) {
    const bashVerdict = qaBashPathVerdict(
      payload.tool_input.command,
      ctx.worktreePath,
      ctx.denyReadPaths,
    );
    if (bashVerdict?.action === 'deny') {
      return { decision: 'deny', reason: bashVerdict.reason };
    }
  }

  return undefined;
}

/** Tiers 4–6: the gate verdict, computed independently of any normal-priority inbox message pending — see this file's header, review round fix (blocker 1). */
function computeGateVerdict(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 0. Role-extension seam (§13/§14): a per-role path deny-list
  // (`ctx.denyReadPaths`, resolved by `service.ts` — today only for QA's
  // `contract.inputs ∪ outputs`) checked for every path-bearing tool
  // (Read/Grep/Glob/Edit/Write/MultiEdit/NotebookEdit), BEFORE the size
  // gate below — so a denied contract read renders as a clear, correctly-
  // reasoned deny rather than being redirected to `read_summary` (which
  // would just read the file by another door) or silently allowed because
  // it happens to be under the size cap. This function has no QA-specific
  // knowledge: `denyReadPaths` is opaque per-role data.
  if (ctx.denyReadPaths && ctx.denyReadPaths.length > 0) {
    for (const path of pathsForToolCall(payload)) {
      const relPath = resolveRelToWorktree(path, ctx.worktreePath);
      if (matchesAnyPattern(relPath, ctx.denyReadPaths)) {
        return {
          decision: 'deny',
          reason: 'QA may not read contract inputs/outputs (§13)',
        };
      }
    }
  }

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

  // 5. Budget.
  const budget = ctx.ticketBudget;
  if (budget !== undefined && budget.spent_tokens >= budget.ceiling_tokens) {
    return {
      decision: 'deny',
      reason: `ticket ${ctx.ticket} budget exhausted (${budget.spent_tokens}/${budget.ceiling_tokens} tokens) — escalate rather than continue`,
    };
  }

  // 6. Role × tool policy (review round 3, opus item 1) — reuses T010's
  // whole `decidePermission` pipeline for every edit-kind tool and for
  // `Bash`, replacing the old Bash-only `checkNeverWithoutHuman` branch.
  // See `roleToolVerdict`'s doc comment above for the mapping; `undefined`
  // means this tool isn't gated at this tier and falls through to step 7.
  const roleTool = roleToolVerdict(ctx, payload);
  if (roleTool !== undefined) return roleTool;

  // 7. Else allow.
  return { decision: 'allow' };
}

/** The one MCP verb an affected agent may still call under a halt: its `standup_report` (§5 step 3). */
const BUS_SEND_TOOL = 'mcp__agile__bus_send';

function haltScopeLabel(halt: Halt): string {
  return Array.isArray(halt.scope) ? halt.scope.join(',') : halt.scope;
}

/**
 * Tier 1 — a halt covering this agent. §5 step 3: "Affected agents' next
 * tool call is blocked; they commit/stash WIP and reply `standup_report`."
 * Quorum (`halts/index.ts`) reaches when every affected agent has reported,
 * or on the 10-minute timeout. Fifteen live runs before this fix reached it
 * only by the timeout — `reported: []` on every halt file — because this
 * tier denied *every* tool, the `bus_send` carrying the report included, and
 * the deny reason was the bare halt reason, which never told the agent to
 * report. Every halt therefore cost the full ten minutes of a denied,
 * re-spawned, re-denied team.
 *
 * Now: a `bus_send` whose `kind` is `standup_report` and whose `refs` name
 * this halt is allowed (and only that — `processStandupReports` needs the
 * `H-<n>` ref to fold the report into the halt, so a report without it is
 * denied with the exact shape to send instead). Everything else is still
 * denied, and the reason says what to do. The urgent `standup_call` for this
 * halt is acked in the same decision: it *is* the delivery, and left unacked
 * it would deny the agent once more (tier 2) after the halt is released.
 * Hooks are the enforcement layer, prompts the intent layer — the
 * instruction rides on the deny so no brief has to carry it.
 */
function haltVerdict(
  ctx: HookDecisionContext,
  halt: Halt,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  const ack = ctx.inbox
    .filter((m) => m.kind === 'standup_call' && (m.refs ?? []).includes(halt.id))
    .map((m) => m.id);
  const withAck = (decision: HookDecision): HookDecision =>
    ack.length > 0 ? { ...decision, ack } : decision;

  const reportShape = `mcp__agile__bus_send { to: ["em"], kind: "standup_report", refs: ["${halt.id}"], body: "<one line: what you were doing, what is uncommitted>" }`;

  if (payload.tool_name === BUS_SEND_TOOL && payload.tool_input?.kind === 'standup_report') {
    const refs = payload.tool_input.refs;
    if (Array.isArray(refs) && refs.includes(halt.id)) return withAck({ decision: 'allow' });
    return withAck({
      decision: 'deny',
      reason: `standup_report for halt ${halt.id} must name it in refs, or the EM cannot count it: send ${reportShape}`,
    });
  }

  return withAck({
    decision: 'deny',
    reason: `halt ${halt.id} (${haltScopeLabel(halt)}): ${halt.reason}\nEvery tool is blocked until this halt is released. Report in now with exactly one call: ${reportShape} — then stop and end your turn. Your worktree is kept; you will be re-prompted with the ruling.`,
  });
}

export function decidePreToolUse(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 1. Halt covering this ticket (global or ticket-scoped) — §4 "Halts":
  // "Engineer-side pre-tool-use hook checks this directory before every
  // write or ticket pickup." `ctx.halts` is already `activeHaltsFor`'s
  // result, so any entry means a covering halt exists.
  // The architect is exempt: it is the role that *raises* a halt
  // (`discovery_triage`) and the only one that can release it
  // (`decision_publish`). On the fourth live run the architect triaged the
  // planted contradiction, its own halt then denied every tool call it
  // made afterwards — the ruling it had reached survived only as hook deny
  // reasons in the event log and never reached the oracle.
  const halt = ctx.halts[0];
  if (halt && ctx.role !== 'architect') {
    return haltVerdict(ctx, halt, payload);
  }

  // 2. Urgent unacked inbox — oldest first (ctx.inbox is already ordered
  // urgent -> normal -> low, ties broken by ulid/send order per Bus.poll).
  const urgent = ctx.inbox.find((m) => m.priority === 'urgent');
  if (urgent) {
    return { decision: 'deny', reason: urgent.body, ack: [urgent.id] };
  }

  // Tiers 4–6, computed BEFORE tier 3 so a pending normal message can never
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
