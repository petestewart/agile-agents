/**
 * The ACP permission layer (agile-agents-design §14). A best-effort gate,
 * not the enforcement backstop: Claude's permission requests have never
 * been seen carrying `rawInput`, while the PreToolUse hook always gets the
 * command and path and can explain a deny. So:
 *
 * - Kind-level policy is the guaranteed floor: a reviewer is denied every
 *   `edit`/`execute`, an engineer's edits stay in the worktree whenever a
 *   path is known, and `allow_always` is never picked.
 * - Command-level never-without-human enforcement is primary in the hook;
 *   this layer still classifies command text whenever it has some
 *   (`rawInput`, then `locations`, then a narrow `title` parse), since a
 *   permissive answer here would defeat the hook.
 * - An `execute` with no command text is denied for the engineer, not
 *   routed (see `policy-tables.ts`'s `engineerVerdict`).
 */

export { classifyPermissionRequest } from './classify';
export { decidePermission } from './decide';
export {
  CANNOT_DETERMINE_REASON,
  type PushDetectorContext,
  detectProtectedBranchWrite,
  detectPush,
} from './push-detector';
export { type RuleCheckContext, checkPatternRule } from './rule-checks';
export { buildGrokFsPolicy, canWriteViaClientFs, type VendorFsImpl } from './vendor-fs';
export { cursorModeIdFor } from './vendor-modes';
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
