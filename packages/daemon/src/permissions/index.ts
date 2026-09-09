/**
 * ACP permission policy by role (T010 — design/agile-agents-design.md §14).
 * See decide.ts / policy-tables.ts / responder.ts for the pieces; this is
 * just the public surface.
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
  type HilResolution,
  type PermissionResponderContext,
  type PermissionResponderHandle,
  type PermissionResponderSession,
} from './responder';
export { generateUlid } from './ulid';
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
