/**
 * Shared types for the Claude hook gate (T009 — design/agile-agents-design.md
 * §6 "Enforcement tiers and hook catalog" tier 1, §5 "Comms bus" → "Delivery
 * by priority", §4 "Ticket" → `budget`, §7 "Tool framework" → `read_summary`).
 *
 * `decide.ts` is pure: everything it needs about the world is packed into
 * `HookDecisionContext` by `service.ts`, which is the only place that reads
 * `StateStore`/`Bus`/the filesystem. `HookDecision` is the pure function's
 * output; `service.ts` turns it into the actual Claude hook JSON contract
 * (`hookSpecificOutput.permissionDecision`/`permissionDecisionReason`/
 * `additionalContext`) and performs the side effects (ack, heartbeat,
 * `hook_decision` event) the decision implies.
 */

import type { AgentId, Halt, Message, TicketBudget, TicketId } from '@agile-agents/shared';
import type { PermissionRole } from '../permissions';

/** The three decision outcomes a Claude PreToolUse hook can render (spike-findings.md §B; `spike/permission-matrix.ts:119`). */
export type HookVerdict = 'allow' | 'deny' | 'ask';

export interface HookLimits {
  /** Raw `Read`/`Grep`-over-a-single-file size ceiling in bytes, above which the tool call is denied in favour of `read_summary` (§7). Default 64 KiB (ticket text: "default e.g. 64 KiB"). */
  maxReadBytes: number;
  /** Optional separate ceiling for `Grep` over a single (non-directory) target — falls back to `maxReadBytes` when unset. Grep over a directory is never size-gated here (§6/ticket: "Grep over a directory → allow, over a huge file → deny"). */
  maxGrepBytes?: number;
}

export const DEFAULT_MAX_READ_BYTES = 64 * 1024;

/**
 * Everything `decidePreToolUse` needs about the calling agent/ticket/world,
 * resolved by `HookService` before the pure decision runs.
 */
export interface HookDecisionContext {
  agent: AgentId;
  ticket: TicketId;
  role: PermissionRole;
  worktreePath: string;
  /** Halts covering this ticket (global or ticket-scoped) — `activeHaltsFor(store, ticket)`, already filtered. */
  halts: Halt[];
  /** This agent's unread inbox, urgent/normal first (§5's poll ordering) — `bus.poll(agent)`. */
  inbox: Message[];
  ticketBudget: TicketBudget | undefined;
  limits: HookLimits;
  /** Returns a file's size in bytes, or `undefined` if it doesn't exist / isn't a plain file (e.g. a directory — Grep-over-directory must not size-gate). Injectable for tests; `service.ts` wires `node:fs.statSync`. */
  fileSize: (path: string) => number | undefined;
}

/** Raw Claude `PreToolUse` hook stdin payload (spike-findings.md §B; Claude Code hooks reference: `hook_event_name`, `tool_name`, `tool_input`, plus `cwd`/`session_id`/`transcript_path` common to every hook event). */
export interface ClaudePreToolUsePayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HookDecision {
  decision: HookVerdict;
  reason?: string;
  /** Pointer-not-payload text to inject as additional context (normal-priority inbox bodies, capped). */
  additionalContext?: string;
  /** Message ids the caller (`service.ts`) should ack once this decision is rendered — see decide.ts's DESIGN-GAP on urgent-inbox ack semantics. */
  ack?: string[];
}
