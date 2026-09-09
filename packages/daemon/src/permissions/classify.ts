/**
 * Classification: ACP `session/request_permission` params → the internal
 * `PermissionRequest` the policy table matches on (T010, ticket
 * "Classification" paragraph; see types.ts's file-level DESIGN-GAP on
 * `rawInput` reliability).
 *
 * Fallback order (round-3 review requirement): `rawInput` > `toolCall.
 * locations[0].path` > `title` > kind-only. Each is tried only when
 * everything before it yielded nothing — none of them ever overrides a
 * value a higher-precedence source actually gave.
 *
 * Title fallback (round-2 QA/review requirement, tightened in round 3):
 * every recorded Claude capture (`spike/spike-out/*.json`) ships
 * `rawInput: {}`, so this is the branch that actually runs against a live
 * vendor. When nothing higher-precedence is available, `toolCall.title` —
 * model-authored prose, but conforming to a small set of observed shapes
 * ("Run npm test", "Edit small.txt", "Write new.txt", "Read File") — is
 * parsed as a fallback:
 *
 * - `^Run (.+)$` → `command`
 * - `^(?:Edit|Write|Create) (.+)$` → `targetPath`, but **only when the
 *   capture actually looks like a path** (round-3 fix — see
 *   `looksLikeTitlePath` below): free-form prose ("Edit the config file")
 *   does not resolve to a path at all, so it can't be laundered into an
 *   in-worktree `allow` by `isPathInside`'s default-relative-to-worktree
 *   resolution. A leading `~` is expanded against the real home directory
 *   and is never trusted as an in-worktree path (a ticket worktree is
 *   never literally the user's home directory).
 * - `^Read(?: File)?$` → confirms a `read` tool class when `kind` itself
 *   didn't already say so (kind, when present, is trusted over title)
 * - anything else (`"Terminal"`, free-form prose that doesn't match one of
 *   the shapes above) → no fallback; classification stays kind-only, and
 *   the policy table's existing safe defaults apply (see
 *   `policy-tables.ts`'s `// DESIGN-GAP` in `engineerVerdict` for why an
 *   engineer `execute` with nothing to classify denies rather than hils).
 *
 * `locationsUsed`/`titleFallbackUsed` record which non-`rawInput` source
 * (if any) a decision's `targetPath`/`command`/`toolClass` came from, so a
 * decision log or report can tell them apart from a `rawInput`-derived one.
 *
 * `targetPaths` (round-4 review fix) carries *every* path that needs
 * containment-checking — `locations` can list more than one, and a
 * `[inside, outside]` pair must not read as "verified" just because the
 * first entry passed. `targetPath` stays the single "primary" path (first
 * of `targetPaths`, or the only one `rawInput`/`title` ever produce) for
 * summaries and any caller that only needs one.
 */

import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import type {
  AcpLocation,
  AcpPermissionRequestParams,
  PermissionRequest,
  ToolClass,
} from './types';

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

/** Every valid path in `locations`, in order (round-4 review fix: a request can carry more than one, and every one of them needs containment-checking, not just the first). */
function allLocationPaths(locations: AcpLocation[] | undefined): string[] {
  if (locations === undefined) return [];
  return locations
    .filter((l): l is AcpLocation => typeof l?.path === 'string' && l.path.length > 0)
    .map((l) => l.path);
}

const RUN_TITLE_RE = /^Run (.+)$/;
const EDIT_TITLE_RE = /^(?:Edit|Write|Create) (.+)$/;
const READ_TITLE_RE = /^Read(?: File)?$/;

/** `"quoted content"` or `'quoted content'`, the whole capture (round-3: `Edit "src/a b.ts"` must still resolve, spaces and all). */
function unquote(raw: string): { text: string; wasQuoted: boolean } {
  const m = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  return m ? { text: m[1] ?? '', wasQuoted: true } : { text: raw, wasQuoted: false };
}

/**
 * Round-3 fix: an `Edit|Write|Create` title capture is only trusted as a
 * path when it actually looks like one — a bare English phrase like "the
 * config file" or "two files: a.ts and /etc/passwd" must not resolve to a
 * relative path that `isPathInside` then happily finds inside the
 * worktree. Trusted when: quoted (spaces allowed once unquoted), or
 * unquoted with no whitespace and either a `/` or a file extension
 * (`.\w{1,8}` at the end). Everything else → `undefined`, so the caller
 * falls back to kind-only classification (a `deny` on "cannot verify"
 * for an engineer edit, never a guessed `allow`).
 */
function looksLikeTitlePath(raw: string): string | undefined {
  const { text, wasQuoted } = unquote(raw);
  if (text.length === 0) return undefined;
  if (!wasQuoted && /\s/.test(text)) return undefined;
  if (text.includes('/') || /\.\w{1,8}$/.test(text)) return text;
  return undefined;
}

/** `~` / `~/rest` expanded against the real home directory — deliberately never trusted as in-worktree (a ticket worktree is never the user's home dir). `~otheruser/...` (unsupported) falls through to "not a path". */
function expandHomeTilde(raw: string): string | undefined {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return joinPath(homedir(), raw.slice(2));
  return undefined;
}

interface TitleFallback {
  command?: string;
  targetPath?: string;
  toolClass?: ToolClass;
}

/** Parses `title` per the shapes documented in this file's header. Returns `{}` when nothing matches — never guesses beyond these patterns. */
function parseTitle(title: string | undefined, currentToolClass: ToolClass): TitleFallback {
  if (title === undefined) return {};
  const runMatch = RUN_TITLE_RE.exec(title);
  if (runMatch) return { command: runMatch[1] };
  const editMatch = EDIT_TITLE_RE.exec(title);
  if (editMatch) {
    const captured = editMatch[1] ?? '';
    if (captured.startsWith('~')) {
      const expanded = expandHomeTilde(captured);
      return expanded !== undefined ? { targetPath: expanded } : {};
    }
    const path = looksLikeTitlePath(captured);
    return path !== undefined ? { targetPath: path } : {};
  }
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
  // Every path that must be containment-checked, not just `targetPath`
  // (the "primary"/first one, kept for summaries and back-compat callers).
  // rawInput/title only ever produce one path; `locations` can carry
  // several, and every one of them has to be verified (round-4 review fix
  // — a request with an inside path first and an outside one second must
  // not read as "the target" and stop looking).
  let targetPaths: string[] | undefined = rawTargetPath !== undefined ? [rawTargetPath] : undefined;
  let locationsUsed = false;
  let titleFallbackUsed = false;

  // Fallback order: rawInput (above) > locations > title > kind-only.
  // Each tier is tried only when every higher-precedence source gave nothing.
  if (rawCommand === undefined && rawTargetPath === undefined) {
    const locationPaths = allLocationPaths(toolCall.locations);
    if (locationPaths.length > 0) {
      targetPath = locationPaths[0];
      targetPaths = locationPaths;
      locationsUsed = true;
    } else {
      const fallback = parseTitle(toolCall.title, toolClass);
      if (fallback.command !== undefined) {
        command = fallback.command;
        titleFallbackUsed = true;
      } else if (fallback.targetPath !== undefined) {
        targetPath = fallback.targetPath;
        targetPaths = [fallback.targetPath];
        titleFallbackUsed = true;
      } else if (fallback.toolClass !== undefined) {
        toolClass = fallback.toolClass;
        titleFallbackUsed = true;
      }
    }
  }

  return {
    toolClass,
    title: toolCall.title,
    command,
    targetPath,
    targetPaths,
    url,
    raw: params,
    locationsUsed,
    titleFallbackUsed,
  };
}
