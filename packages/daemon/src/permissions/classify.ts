/**
 * Classification: ACP `session/request_permission` params → the internal
 * `PermissionRequest` the policy table matches on (T010, ticket
 * "Classification" paragraph; see types.ts's file-level DESIGN-GAP on
 * `rawInput` reliability).
 *
 * Title fallback (round-2 QA/review requirement): every recorded Claude
 * capture (`spike/spike-out/*.json`) ships `rawInput: {}`, so this is the
 * branch that actually runs against a live vendor. When `rawInput` carries
 * neither a command nor a path, `toolCall.title` — model-authored prose,
 * but conforming to a small set of observed shapes ("Run npm test", "Edit
 * small.txt", "Write new.txt", "Read File") — is parsed as a **fallback
 * only**, never overriding a `rawInput` value that's actually present:
 *
 * - `^Run (.+)$` → `command`
 * - `^(?:Edit|Write|Create) (.+)$` → `targetPath` (a relative path here
 *   resolves against the worktree the same way a `rawInput`-sourced one
 *   does — `isPathInside` in `command.ts` calls `resolve(worktree, path)`,
 *   which is a no-op for an already-absolute path)
 * - `^Read(?: File)?$` → confirms a `read` tool class when `kind` itself
 *   didn't already say so (kind, when present, is trusted over title)
 * - anything else (`"Terminal"`, free-form prose that doesn't match one of
 *   the shapes above) → no fallback; classification stays kind-only, and
 *   the policy table's existing safe defaults apply (see
 *   `policy-tables.ts`'s `// DESIGN-GAP` in `engineerVerdict` for why an
 *   engineer `execute` with nothing to classify denies rather than hils).
 *
 * `titleFallbackUsed` records whether a decision's command/path came from
 * this fallback rather than `rawInput`, so a decision log or report can
 * tell a title-derived classification apart from a `rawInput`-derived one.
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

const RUN_TITLE_RE = /^Run (.+)$/;
const EDIT_TITLE_RE = /^(?:Edit|Write|Create) (.+)$/;
const READ_TITLE_RE = /^Read(?: File)?$/;

interface TitleFallback {
  command?: string;
  targetPath?: string;
  toolClass?: ToolClass;
}

/** Parses `title` per the shapes documented in this file's header. Returns `{}` when nothing matches — never guesses beyond these three patterns. */
function parseTitle(title: string | undefined, currentToolClass: ToolClass): TitleFallback {
  if (title === undefined) return {};
  const runMatch = RUN_TITLE_RE.exec(title);
  if (runMatch) return { command: runMatch[1] };
  const editMatch = EDIT_TITLE_RE.exec(title);
  if (editMatch) return { targetPath: editMatch[1] };
  if (currentToolClass === 'other' && READ_TITLE_RE.test(title)) return { toolClass: 'read' };
  return {};
}

export function classifyPermissionRequest(params: AcpPermissionRequestParams): PermissionRequest {
  const toolCall = params.toolCall ?? { kind: undefined, title: undefined, rawInput: undefined };
  const rawInput = toolCall.rawInput ?? {};

  let toolClass = classifyToolKind(toolCall.kind);
  const rawCommand = firstString(rawInput.command);
  const rawTargetPath = firstString(rawInput.file_path, rawInput.path, rawInput.abs_path);
  const url = firstString(rawInput.url);

  let command = rawCommand;
  let targetPath = rawTargetPath;
  let titleFallbackUsed = false;

  // Fallback only — never overrides a rawInput value that's actually present.
  if (rawCommand === undefined && rawTargetPath === undefined) {
    const fallback = parseTitle(toolCall.title, toolClass);
    if (fallback.command !== undefined) {
      command = fallback.command;
      titleFallbackUsed = true;
    } else if (fallback.targetPath !== undefined) {
      targetPath = fallback.targetPath;
      titleFallbackUsed = true;
    } else if (fallback.toolClass !== undefined) {
      toolClass = fallback.toolClass;
      titleFallbackUsed = true;
    }
  }

  return {
    toolClass,
    title: toolCall.title,
    command,
    targetPath,
    url,
    raw: params,
    titleFallbackUsed,
  };
}
