/**
 * ACP `session/request_permission` params → the `PermissionRequest` the
 * policy table matches on. Sources, each tried only when all before it
 * gave nothing: `rawInput` > `toolCall.locations` > `title` > kind-only.
 *
 * Every recorded Claude capture has `rawInput: {}`, so the `title` parse
 * (observed shapes like "Run npm test", "Edit small.txt", "Read File") is
 * what runs against a live vendor:
 *
 * - `^Run (.+)$` → `command`;
 * - `^(?:Edit|Write|Create) (.+)$` → `targetPath`, only when the capture
 *   looks like a path (prose like "Edit the config file" must not resolve
 *   into an in-worktree allow); a leading `~` expands against the real
 *   home, never trusted as in-worktree;
 * - `^Read(?: File)?$` → a `read` class when `kind` didn't say;
 * - anything else: kind-only, and the table's safe defaults apply.
 *
 * `locationsUsed`/`titleFallbackUsed` record the source. `targetPaths`
 * carries every path to check (an `[inside, outside]` pair must not pass
 * on its first entry); `targetPath` is the primary one.
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

/** Every valid path in `locations`, in order. */
function allLocationPaths(locations: AcpLocation[] | undefined): string[] {
  if (locations === undefined) return [];
  return locations
    .filter((l): l is AcpLocation => typeof l?.path === 'string' && l.path.length > 0)
    .map((l) => l.path);
}

const RUN_TITLE_RE = /^Run (.+)$/;
/** T476: other vendors' exec titles: "`git ls-files`", "Terminal: git ls-files", "Shell: …". */
const BACKTICK_TITLE_RE = /^`([^`]+)`$/;
const LABELLED_RUN_TITLE_RE = /^(?:Terminal|Shell|Execute|Command|Bash|Run command):\s*(.+)$/i;

/**
 * T476: an exec's command where vendors put it: `command` (Claude, most),
 * `cmd`, `commandLine`/`command_line`, or an argv array under any of them.
 */
function rawCommandOf(rawInput: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'commandLine', 'command_line']) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      return (value as string[]).map(shellWord).join(' ');
    }
  }
  return undefined;
}

/** One argv word as the shell would read it back: quoted when it holds anything special. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** T476: the first text block of a call's `content` (a vendor may put the command there alone). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const inner = (block as { content?: { type?: unknown; text?: unknown } } | null)?.content;
    if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.trim() !== '') {
      return inner.text.trim();
    }
  }
  return undefined;
}
const EDIT_TITLE_RE = /^(?:Edit|Write|Create) (.+)$/;
const READ_TITLE_RE = /^Read(?: File)?$/;

/** A whole-capture `"quoted"` or `'quoted'` string (`Edit "src/a b.ts"` must resolve). */
function unquote(raw: string): { text: string; wasQuoted: boolean } {
  const m = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  return m ? { text: m[1] ?? '', wasQuoted: true } : { text: raw, wasQuoted: false };
}

/**
 * An `Edit|Write|Create` capture is trusted as a path only when quoted, or
 * unquoted with no whitespace and a `/` or a file extension. Otherwise
 * `undefined`: kind-only, so an engineer edit denies "cannot verify" rather
 * than guess an allow.
 */
function looksLikeTitlePath(raw: string): string | undefined {
  const { text, wasQuoted } = unquote(raw);
  if (text.length === 0) return undefined;
  if (!wasQuoted && /\s/.test(text)) return undefined;
  if (text.includes('/') || /\.\w{1,8}$/.test(text)) return text;
  return undefined;
}

/** `~` / `~/rest` against the real home (never in-worktree); `~user` is not a path. */
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

/** Parses `title` per the shapes above; `{}` when none matches. */
function parseTitle(title: string | undefined, currentToolClass: ToolClass): TitleFallback {
  if (title === undefined) return {};
  const runMatch = RUN_TITLE_RE.exec(title);
  if (runMatch) return { command: runMatch[1] };
  if (currentToolClass === 'execute') {
    const run = BACKTICK_TITLE_RE.exec(title) ?? LABELLED_RUN_TITLE_RE.exec(title);
    if (run) return { command: run[1]?.trim() };
  }
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
  const rawCommand = rawCommandOf(rawInput);
  const rawTargetPath = firstString(rawInput.file_path, rawInput.path, rawInput.abs_path);
  const url = firstString(rawInput.url);

  let command = rawCommand;
  let targetPath = rawTargetPath;
  // Every path to containment-check (`targetPath` is the primary one);
  // only `locations` can yield several.
  let targetPaths: string[] | undefined = rawTargetPath !== undefined ? [rawTargetPath] : undefined;
  let locationsUsed = false;
  let titleFallbackUsed = false;

  // Fallback order: rawInput (above) > locations > title > kind-only.
  if (rawCommand === undefined && rawTargetPath === undefined) {
    const locationPaths = allLocationPaths(toolCall.locations);
    if (locationPaths.length > 0) {
      targetPath = locationPaths[0];
      targetPaths = locationPaths;
      locationsUsed = true;
    } else {
      const fallback = parseTitle(toolCall.title, toolClass);
      // T476: an exec whose command is only in its content (one plain line).
      const fromContent =
        toolClass === 'execute' && fallback.command === undefined
          ? contentText(toolCall.content)
          : undefined;
      if (fromContent !== undefined && !fromContent.includes('\n')) {
        command = fromContent;
        titleFallbackUsed = true;
      } else if (fallback.command !== undefined) {
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
