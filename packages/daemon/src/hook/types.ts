/**
 * Types for the Claude hook gate (agile-agents-design §6 tier 1). A tool
 * call is made by a session attached to a stream. `decide.ts` is pure:
 * `service.ts` packs the world into `HookDecisionContext`, turns the
 * `HookDecision` into Claude's hook JSON, and performs the side effects.
 */

import type { AgentMessage, KnowledgeItem, SessionRole } from '@agile-agents/shared';
import type { VisibilityContext } from '../permissions/visibility';

/** The outcomes of the pure decision (spike-findings.md §B); `ask` never reaches the wire. */
export type HookVerdict = 'allow' | 'deny' | 'ask';

export interface HookLimits {
  /** Raw `Read`/`Grep` single-file size ceiling in bytes, above which the call is denied. Default 64 KiB. */
  maxReadBytes: number;
  /** A separate ceiling for `Grep` over a single file (default `maxReadBytes`); a directory is never size-gated. */
  maxGrepBytes?: number;
}

export const DEFAULT_MAX_READ_BYTES = 64 * 1024;

/** Everything `decidePreToolUse` needs about the caller and the world, resolved by `HookService`. */
export interface HookDecisionContext {
  /** The attached session this call came from (§8.1 step 1: session → stream → repo). */
  session: string;
  /** The stream that session is attached to. */
  stream: string;
  role: SessionRole;
  worktreePath: string;
  /** This session's unread inbox, by priority (`bus.poll(session)`). */
  inbox: AgentMessage[];
  limits: HookLimits;
  /** A file's size, or `undefined` if missing or not a plain file (a directory must not size-gate). */
  fileSize: (path: string) => number | undefined;
  /** The accepted pattern rules in scope (§5.3), in check order. None in scope gates nothing here. */
  patternRules?: readonly KnowledgeItem[];
  /** The repo's `protected_branches` (D8), resolved at check time. */
  protectedBranches?: readonly string[];
  /** `@{upstream}` of the worktree; called only for a push with no refspec. */
  upstreamBranch?: () => string | undefined;
  /** The worktree's checked-out branch; called only for a `git merge` with no preceding checkout. */
  headBranch?: () => string | undefined;
  /** P13: the node's repo, project and the registry; absent checks no visibility. */
  visibility?: VisibilityContext;
}

/** Raw Claude `PreToolUse` stdin payload (spike-findings.md §B). */
export interface ClaudePreToolUsePayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /**
   * A disambiguation hint, never a credential: written only by `agile
   * hook` (from `AGILE_AGENT`). Self-asserted by the caller's env, so it
   * may only pick among registry entries that already matched `cwd`.
   */
  agile_agent?: string;
  /**
   * Set by the Pi extension: its `tool_call` result can't carry
   * `additionalContext`, so normal-priority messages must not be folded
   * into (and acked by) this decision; `before_agent_start` delivers them.
   * Urgent messages still deny with the body as the reason.
   */
  no_additional_context_channel?: boolean;
  [key: string]: unknown;
}

export interface HookDecision {
  decision: HookVerdict;
  reason?: string;
  /** Context to inject: normal-priority inbox bodies, capped. */
  additionalContext?: string;
  /** Message ids `service.ts` acks once this decision is rendered (an urgent deny's reason is its delivery). */
  ack?: string[];
  /** The pattern rules evaluated, in order: `stats.fired` each (§5.7), written by `service.ts`. */
  rulesEvaluated?: string[];
  /** The rule this decision denied on: `stats.violated`, named in the reason. */
  ruleViolated?: string;
  /** The classifier rule that routed this call (`stats.routed`); a human deny later counts as `violated`. */
  ruleRouted?: string;
}
