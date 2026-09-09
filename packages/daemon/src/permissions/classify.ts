/**
 * Classification: ACP `session/request_permission` params → the internal
 * `PermissionRequest` the policy table matches on (T010, ticket
 * "Classification" paragraph; see types.ts's file-level DESIGN-GAP on
 * `rawInput` reliability).
 */

import type { AcpPermissionRequestParams, PermissionRequest, ToolClass } from './types';

const KNOWN_TOOL_CLASSES: ReadonlySet<string> = new Set(['read', 'edit', 'execute', 'fetch']);

function classifyToolKind(kind: string | undefined): ToolClass {
  if (kind !== undefined && KNOWN_TOOL_CLASSES.has(kind)) return kind as ToolClass;
  return 'other';
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function classifyPermissionRequest(params: AcpPermissionRequestParams): PermissionRequest {
  const toolCall = params.toolCall ?? { kind: undefined, title: undefined, rawInput: undefined };
  const rawInput = toolCall.rawInput ?? {};
  return {
    toolClass: classifyToolKind(toolCall.kind),
    title: toolCall.title,
    command: firstString(rawInput.command),
    targetPath: firstString(rawInput.file_path, rawInput.path, rawInput.abs_path),
    url: firstString(rawInput.url),
    raw: params,
  };
}
