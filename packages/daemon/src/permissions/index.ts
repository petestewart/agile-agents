/**
 * The ACP permission layer (agile-agents-design §14): a best-effort gate,
 * since Claude's permission requests carry no `rawInput` while the
 * PreToolUse hook always sees the command. Kind-level policy is the floor
 * (a reviewer gets no `edit`/`execute`, engineer edits stay in the
 * worktree, never `allow_always`); command text is still classified
 * whenever this layer has some, since a permissive answer here would
 * defeat the hook.
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
