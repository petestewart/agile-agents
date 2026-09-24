/**
 * ACP permission types (agile-agents-design §14, §6 tier 2). Wire shapes
 * follow `spike-findings.md` §A/§B: the agent sends `{ sessionId,
 * toolCall: { toolCallId, kind, title, rawInput }, options }` and the
 * client answers `{ outcome: { outcome: 'selected', optionId } |
 * { outcome: 'cancelled' } }`.
 *
 * Every recorded spike payload has `rawInput: {}`, so `classify.ts` treats
 * an empty `rawInput` as the expected case and falls back to
 * `toolCall.locations`, then a narrow parse of `title` (prose that doesn't
 * look like a path is rejected). With nothing left, classification is
 * kind-only and the table's safe defaults (deny/hil) apply.
 */

import type { Rule } from '@agile-agents/shared';

/** The permission-table role a session is judged under (`permissionRoleFor`): worker = `engineer`, reviewer/lessons = `reviewer`. */
export type PermissionRole = 'engineer' | 'reviewer';

/** ACP permission option kinds seen on the wire (spike-findings.md §A). */
export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: AcpPermissionOptionKind;
}

/** ACP `ToolKind` values policy reads; anything else classifies as `'other'` (safe-default deny). */
export type AcpToolKind = 'read' | 'edit' | 'execute' | 'fetch' | string;

/** One location an edit/read tool call names (a documented ACP field, unseen in captures). Only `path` is used. */
export interface AcpLocation {
  path: string;
  line?: number;
}

export interface AcpToolCall {
  toolCallId?: string;
  kind?: AcpToolKind;
  title?: string;
  rawInput?: Record<string, unknown>;
  locations?: AcpLocation[];
}

/** `session/request_permission` params, as forwarded by `SpawnedSession`'s `'request'` event. */
export interface AcpPermissionRequestParams {
  sessionId?: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

/** The internal tool-class vocabulary the policy table matches on. */
export type ToolClass = 'read' | 'edit' | 'execute' | 'fetch' | 'other';

/** The request reduced to what the policy table needs; `raw` keeps the original. */
export interface PermissionRequest {
  toolClass: ToolClass;
  title?: string;
  /** `rawInput.command` for `execute` tool calls. */
  command?: string;
  /** The primary path for `read`/`edit` (the first, when there are several). */
  targetPath?: string;
  /** Every path to containment-check: an `[inside, outside]` pair must not pass on its first entry. */
  targetPaths?: string[];
  /** `rawInput.url` for `fetch` tool calls. */
  url?: string;
  /** The path came from `toolCall.locations` (see the fallback order above). */
  locationsUsed: boolean;
  /** The command/path/class came from parsing `title`. */
  titleFallbackUsed: boolean;
  raw: AcpPermissionRequestParams;
}

export interface DecisionContext {
  role: PermissionRole;
  worktreePath: string;
  request: AcpPermissionRequestParams;
  /**
   * The pattern rules in scope (§5.3) and what their detectors need: this
   * tier is the only gate a hook-less vendor (Cursor, Codex, Grok, §4.3)
   * has, so it runs the same rules as the hook.
   */
  patternRules?: readonly Rule[];
  /** The stream's repo `protected_branches` (D8); defaults to `[main, master]`. */
  protectedBranches?: readonly string[];
  /** `@{upstream}` of the worktree (`worktreeBranchLookups`). */
  upstreamBranch?: () => string | undefined;
  /** The worktree's checked-out branch. */
  headBranch?: () => string | undefined;
}

/** `decidePermission`'s outcomes. */
export type Decision =
  | { kind: 'allow'; optionId: string; rulesEvaluated?: string[] }
  | {
      kind: 'deny';
      optionId: string;
      reason: string;
      /** Every pattern rule evaluated (`stats.fired`). */
      rulesEvaluated?: string[];
      /** The rule the reason names (`stats.violated`). */
      ruleViolated?: string;
    }
  | { kind: 'hil'; reason: string; hilRequest: HilRequestDraft };

/** What `decidePermission` hands the responder to raise a `classifier_review` gate; ids and clocks are the responder's. */
export interface HilRequestDraft {
  hilKind: 'classifier_review';
  /** One-line summary, under the body cap. */
  summary: string;
  classified: PermissionRequest;
}
