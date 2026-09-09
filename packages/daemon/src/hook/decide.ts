/**
 * `decidePreToolUse` — the pure PreToolUse decision function (T009 —
 * design/agile-agents-design.md §6 "Enforcement tiers and hook catalog",
 * minimum hook/gate set: "pre-tool-use / any"; §5 "Comms bus" → "Delivery by
 * priority"; §4 "Ticket" → `budget`; §7 "Tool framework" → `read_summary`).
 *
 * Order (§6, this ticket's Scope line, in the order given):
 *   1. halt covering the agent's ticket -> deny with the halt reason.
 *   2. urgent unacked inbox -> deny with the message body as the reason.
 *   3. normal inbox -> additionalContext with the bodies (capped), ack them.
 *   4. big raw Read/Grep (over `limits.maxReadBytes`/`maxGrepBytes`) -> deny
 *      "use read_summary(path, question)".
 *   5. budget: `spent_tokens >= ceiling_tokens` -> deny.
 *   6. command-level never-without-human via `checkNeverWithoutHuman`
 *      (reused from T010's permissions module — see this package's
 *      `permissions/index.ts` file header for why command-level
 *      enforcement is primary *here*, not in the ACP responder) for a
 *      `Bash` `tool_input.command` -> hil verdict maps to `ask`, deny maps
 *      to `deny`.
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

import { checkNeverWithoutHuman } from '../permissions';
import type { PermissionRequest } from '../permissions';
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

/** Tiers 4–6: the gate verdict, computed independently of any normal-priority inbox message pending — see this file's header, review round fix (blocker 1). */
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
          reason: `${path} is ${size} bytes (over the ${limit}-byte raw-read limit); use read_summary(path, question) instead.`,
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

  // 6. Command-level never-without-human, for Bash only (the only tool
  // this hook payload carries a real command string for).
  if (payload.tool_name === 'Bash') {
    const command = payload.tool_input?.command;
    if (typeof command === 'string' && command.length > 0) {
      const classified: PermissionRequest = {
        toolClass: 'execute',
        command,
        locationsUsed: false,
        titleFallbackUsed: false,
        raw: { toolCall: { kind: 'execute', title: 'Bash', rawInput: { command } }, options: [] },
      };
      const verdict = checkNeverWithoutHuman(classified, {
        role: ctx.role,
        worktreePath: ctx.worktreePath,
        ticket: ctx.ticket,
      });
      if (verdict?.action === 'hil') {
        return { decision: 'ask', reason: verdict.reason };
      }
      if (verdict?.action === 'deny') {
        return { decision: 'deny', reason: verdict.reason };
      }
    }
  }

  // 7. Else allow.
  return { decision: 'allow' };
}

export function decidePreToolUse(
  ctx: HookDecisionContext,
  payload: ClaudePreToolUsePayload,
): HookDecision {
  // 1. Halt covering this ticket (global or ticket-scoped) — §4 "Halts":
  // "Engineer-side pre-tool-use hook checks this directory before every
  // write or ticket pickup." `ctx.halts` is already `activeHaltsFor`'s
  // result, so any entry means a covering halt exists.
  const halt = ctx.halts[0];
  if (halt) {
    return { decision: 'deny', reason: halt.reason };
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
