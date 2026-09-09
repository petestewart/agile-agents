/**
 * ACP permission policy by role (T010 — design/agile-agents-design.md §14
 * "Permissions per role", §6 "Enforcement tiers and hook catalog" tier 2,
 * §16 "HIL gates policy" for the `hil_request` shape).
 *
 * Wire shapes below model `session/request_permission` as observed in
 * `design/spike-findings.md` §A/§B and `spike/permission-matrix.ts` (real
 * payloads: `spike/spike-out/claude-default-perm.json`): the agent sends
 * `{ sessionId, toolCall: { toolCallId, kind, title, rawInput }, options }`
 * and the client answers with `{ outcome: { outcome: 'selected', optionId }
 * | { outcome: 'cancelled' } }`.
 *
 * DESIGN-GAP (verify-before-build finding): every recorded spike payload in
 * `spike/spike-out/*.json` shows `rawInput: {}` for every tool call,
 * including edits and execs — the harness never captured populated
 * `rawInput`. The ticket's instruction to parse
 * `rawInput.command`/`file_path`/`path` is still the right target (it is
 * the field the ACP spec and the Claude bridge define for this purpose,
 * and ourAnswer/title strings in the same payloads confirm the bridge does
 * carry structured tool arguments elsewhere in its own tool-call
 * bookkeeping) — but a real run may hand this policy an empty `rawInput`.
 * Classification degrades to `targetPath`/`command` both `undefined` in
 * that case, and every rule below treats "can't identify the target" as
 * the safe default (deny/hil, never allow) rather than guessing from
 * `title` text, which is human-readable prose the bridge is free to
 * reformat. Flagged for the manager: a follow-up spike run against a
 * Claude Code build that populates `rawInput` would confirm the field
 * names before this ships against a live vendor.
 */

/** The three roles this ticket's policy table covers (§14's Architect/EM/Reader rows are out of scope here). */
export type PermissionRole = 'engineer' | 'reviewer' | 'qa';

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

/**
 * ACP `ToolKind` values relevant to policy. Anything else (`delete`,
 * `move`, `search`, `think`, `switch_mode`, `other`, or an absent/unknown
 * string) classifies as `'other'` and hits the safe-default deny.
 */
export type AcpToolKind = 'read' | 'edit' | 'execute' | 'fetch' | string;

export interface AcpToolCall {
  toolCallId?: string;
  kind?: AcpToolKind;
  title?: string;
  rawInput?: Record<string, unknown>;
}

/** `session/request_permission` params, as forwarded by `SpawnedSession`'s `'request'` event. */
export interface AcpPermissionRequestParams {
  sessionId?: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

/** The internal tool-class vocabulary the policy table matches on. */
export type ToolClass = 'read' | 'edit' | 'execute' | 'fetch' | 'other';

/**
 * The ACP request reduced to what the policy table needs: {tool class,
 * target path(s), command} (ticket "Classification" paragraph). `raw`
 * carries the untouched request so a rule can fall back to `options`/`title`
 * when it needs to.
 */
export interface PermissionRequest {
  toolClass: ToolClass;
  title?: string;
  /** `rawInput.command` for `execute` tool calls. */
  command?: string;
  /** `rawInput.file_path` / `rawInput.path` for `read`/`edit` tool calls. */
  targetPath?: string;
  /** `rawInput.url` for `fetch` tool calls. */
  url?: string;
  raw: AcpPermissionRequestParams;
}

export interface DecisionContext {
  role: PermissionRole;
  ticket: string;
  worktreePath: string;
  request: AcpPermissionRequestParams;
}

/** `decidePermission`'s three possible outcomes (ticket "Export" list). */
export type Decision =
  | { kind: 'allow'; optionId: string }
  | { kind: 'deny'; optionId: string; reason: string }
  | { kind: 'hil'; reason: string; hilRequest: HilRequestDraft };

/**
 * What `decidePermission` hands the responder to build the actual
 * `hil_request` `Message` (§5 "HIL": `kind: approve_decision | steer | demo
 * | unblock`, plus a `deadline`). Everything role/ticket/session-scoped is
 * filled in by `buildPermissionResponder`, not by the pure decision
 * function, so `decidePermission` stays free of clock/ID concerns.
 */
export interface HilRequestDraft {
  hilKind: 'unblock';
  /** One-line summary for the message body (kept under the 800-char cap by construction). */
  summary: string;
  classified: PermissionRequest;
}
