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
 * DESIGN-GAP (verify-before-build finding, updated round 3): every
 * recorded spike payload in `spike/spike-out/*.json` shows `rawInput: {}`
 * for every tool call, including edits and execs — the harness never
 * captured populated `rawInput`. Whether the *permission request's own*
 * `rawInput` is ever populated for Claude is unmeasured, not proven empty
 * (a follow-up spike run against a live vendor recording
 * `params.toolCall.rawInput` unconditionally would settle it) — but since
 * every capture to date shows `{}`, `classify.ts` treats `rawInput` empty
 * as the expected case, not the exceptional one, and falls back **in this
 * order**: `rawInput` > `toolCall.locations` (an array of `{path, line?}`
 * some ACP tool calls carry for edit/read targets, independent of
 * `rawInput` and of the model-authored `title`) > `title` — model-authored
 * prose, observed to follow a small set of shapes ("Run npm test", "Edit
 * small.txt", "Write new.txt", "Read File") — parsed narrowly
 * (`classify.ts`'s file header has the exact patterns and, since round 3,
 * a "does this actually look like a path" check: prose like "Edit the
 * config file" is deliberately rejected rather than resolved into a false
 * in-worktree allow). Anything past all three sources leaves classification
 * kind-only, at which point the policy table's existing safe defaults apply
 * (deny/hil, never allow, on an unidentifiable target).
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

/**
 * One location an edit/read tool call touches. Not modeled anywhere in
 * `@agile-agents/acp-client`'s types (that package models the JSON-RPC
 * session/reply contract, not `session/request_permission`'s own payload
 * shape) and not present in any recorded spike capture — included per the
 * round-3 review instruction as a field some ACP tool calls are documented
 * to carry, independent of `rawInput` and of `title`. `line` is accepted
 * on the wire but unused by this policy (path is all containment checks need).
 */
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
  /** `rawInput.file_path` / `rawInput.path` for `read`/`edit` tool calls — the primary/first path when there's more than one (see `targetPaths`). */
  targetPath?: string;
  /** Every path that must be containment-checked (round-4 review fix: `toolCall.locations` can carry more than one, and a `[inside, outside]` pair must not pass just because the first entry does). `rawInput`/`title` only ever produce one, so this is `[targetPath]` in that case; `undefined` alongside `targetPath === undefined`. */
  targetPaths?: string[];
  /** `rawInput.url` for `fetch` tool calls. */
  url?: string;
  /** True when `targetPath` came from `toolCall.locations[0].path` (`rawInput` had neither a command nor a path) — see `classify.ts`'s file header for the fallback order. */
  locationsUsed: boolean;
  /** True when `command`/`targetPath`/`toolClass` came from parsing `title` (`rawInput` and `locations` both had nothing) rather than from either of those — see `classify.ts`'s file header. */
  titleFallbackUsed: boolean;
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
