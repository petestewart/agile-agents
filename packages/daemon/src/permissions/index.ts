/**
 * ACP permission policy by role (T010 — design/agile-agents-design.md §14).
 * See decide.ts / policy-tables.ts / responder.ts for the pieces; this is
 * just the public surface.
 *
 * ## Scope decision (manager, post-review — record this, don't re-litigate it)
 *
 * The ACP `session/request_permission` layer this module answers is a
 * **best-effort** command gate, not the enforcement backstop. Per
 * design §6's tier table and `design/spike-findings.md` §A/§B: Claude's
 * `tool_call`/permission-request payloads have never been observed to
 * carry a populated `rawInput` for an exec or edit (every recorded capture
 * in `spike/spike-out/*.json` shows `{}`), while the harness's project-level
 * `PreToolUse` hook (T009) provably receives `tool_input.command`/
 * `tool_input.file_path` on every call and can return a reason the model
 * sees. So:
 *
 * - **Kind-level policy is this module's guaranteed floor**: reviewer
 *   denies every `edit`/`execute` regardless of what text (if any)
 *   accompanies them; QA denies every `edit`; engineer confines `edit` to
 *   the worktree whenever a path is available and never picks
 *   `allow_always`. This floor holds even when `rawInput`/title parsing
 *   yields nothing to classify.
 * - **Command-level never-without-human enforcement (push target,
 *   force-push, branch delete, new dependency, the deny-listed commands)
 *   is primary in T009's PreToolUse hook**, which is the only measured
 *   carrier of the actual command text. This module still classifies
 *   command text correctly whenever it IS available here, tried in this
 *   order (round 3): `rawInput` when populated; else `toolCall.locations`
 *   (`{path, line?}[]` — a field no recorded capture or
 *   `spike/permission-matrix.ts` parse shows populated, included per
 *   review instruction as one some ACP tool calls are documented to
 *   carry, and checked ahead of `title` because it's structured data, not
 *   prose); else — since every recorded capture shows `rawInput: {}` and
 *   that is the branch that will actually run against a live vendor —
 *   `toolCall.title` via the narrow fallback in `classify.ts`
 *   (`^Run (.+)$` → command, `^(?:Edit|Write|Create) (.+)$` → path **only
 *   when the capture looks like a path** — round 3 closed a regression
 *   where free-form prose like "Edit the config file" resolved to a
 *   fictitious in-worktree path and turned the kind-level floor into a
 *   blanket allow; see `classify.ts`'s `looksLikeTitlePath` — `^Read(?:
 *   File)?$` → confirms a read). Anything outside all three sources stays
 *   kind-only. A permissive answer at this tier would defeat the hook even
 *   though the hook is the primary backstop, so the classifier in
 *   `command.ts`/`policy-tables.ts`/`classify.ts` is not decorative.
 * - When no command text is available at all for an `execute` request, the
 *   engineer verdict is `deny` (with a reason pointing at the hook-gated
 *   path), not `hil` — see the `// DESIGN-GAP:` comment in
 *   `policy-tables.ts`'s `engineerVerdict` for why a `hil` here would be
 *   too noisy.
 */

export { classifyPermissionRequest } from './classify';
export { decidePermission } from './decide';
export {
  checkNeverWithoutHuman,
  isPackageRegistryUrl,
  PACKAGE_REGISTRY_HOSTS,
  roleVerdict,
  type PolicyContext,
  type PolicyVerdict,
} from './policy-tables';
export {
  buildPermissionResponder,
  DEFAULT_HIL_DEADLINE_MS,
  type HilRequestInput,
  type HilResolution,
  type PermissionResponderContext,
  type PermissionResponderHandle,
  type PermissionResponderSession,
  type RequestHil,
} from './responder';
export type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionRequestParams,
  AcpToolCall,
  AcpToolKind,
  Decision,
  DecisionContext,
  HilRequestDraft,
  PermissionRequest,
  PermissionRole,
  ToolClass,
} from './types';
