/**
 * T543: Pi's tool calls as the Claude-shaped payload `decide.ts` reads, as
 * `codexToClaudePayload` does for Codex. The `agile` Pi extension
 * (`pi/agile-extension.ts`) forwards Pi's own `toolName` and `input` to
 * `hook.pre_tool_use` unmapped, and `pi-acp` raises no ACP permission
 * requests (spike-findings §C4), so the hook is Pi's only gate. The mapping
 * runs in the daemon, picked by the session's registry record (`vendor:
 * 'pi'`), so an installed extension of any age is gated.
 *
 * Pi's built-in tools (`@earendil-works/pi-coding-agent@0.85.1`,
 * `dist/core/tools/*.js`; `ToolName` in `tools/index.d.ts`; the `read`,
 * `bash`, `edit` and `write` shapes also in `spike/spike-out/pi-hook-calls.jsonl`):
 *
 * | Pi         | input                                        | here              |
 * |------------|----------------------------------------------|-------------------|
 * | bash       | `command`, `timeout?`                        | `Bash`            |
 * | read       | `path`, `offset?`, `limit?`                  | `Read`            |
 * | write      | `path`, `content`                            | `Write`           |
 * | edit       | `path`, `edits: [{oldText, newText}]`        | `Edit`            |
 * | grep       | `pattern`, `path?` (default `.`), `glob?`, … | `Grep`            |
 * | find       | `pattern`, `path?` (default `.`), `limit?`   | `Glob`            |
 * | ls         | `path?` (default `.`), `limit?`              | `LS`              |
 * | powershell | `command` (PowerShell, not POSIX sh)         | kind `other`      |
 *
 * Pi looks a tool up by its exact name (`agent-loop.js` `prepareToolCall`),
 * so `Bash` or `READ` is never Pi's `bash` or `read`: any name not in the
 * table (another extension's tool, `powershell`, whose commands the POSIX
 * parser can't read) is marked `agile_tool_kind: 'other'` and gets the ACP
 * tier's verdict for kind `other`, whatever it is called. Pi's `tool_call`
 * event carries the validated arguments (`agent-session.js`: `input: args`,
 * after the tool's `prepareArguments`), so an `edit` arrives with `edits`
 * already an array.
 *
 * A path is resolved as Pi's `resolveToCwd` does (`utils/paths.js`
 * `normalizePath`): Unicode spaces become spaces, a leading `@` is dropped,
 * `~` and `~/…` expand to the home dir, a `file://` URL becomes its path, and
 * a relative path is taken from `cwd`. Checking the raw string instead would
 * let `@/etc/passwd` or `~/.agile/config.yaml` pass as a path in the worktree.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudePreToolUsePayload } from './types';

/** The vendor id of a Pi session's registry record (`provider.id`). */
export const PI_VENDOR = 'pi';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The characters Pi's `normalizePath` turns into a plain space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The absolute path Pi's file tools would touch for `raw`, from `cwd`
 * (`resolveToCwd`). `undefined` for a missing or empty value, or a `file:`
 * URL Pi could not open either.
 */
export function piPath(raw: unknown, cwd: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let path = raw.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  if (/^file:\/\//.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  }
  if (path.length === 0) return undefined;
  return isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path);
}

/** Pi's one-file tools, as Claude names them: `path` is the file. */
const PI_FILE_TOOLS: ReadonlyMap<string, 'Read' | 'Write' | 'Edit'> = new Map([
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
]);

/** Pi's search tools, as Claude names them: `path` is the dir they walk, `.` when unset. */
const PI_SEARCH_TOOLS: ReadonlyMap<string, 'Grep' | 'Glob' | 'LS'> = new Map([
  ['grep', 'Grep'],
  ['find', 'Glob'],
  ['ls', 'LS'],
]);

/** An `edit`'s replacements as Claude's `edits` (`old_string`/`new_string`), for the classifier's diff. */
function piEdits(
  input: Record<string, unknown>,
): Array<{ old_string: string; new_string: string }> {
  const listed = Array.isArray(input.edits) ? input.edits : [input.edits];
  // A pre-0.85 `edit` named one replacement at the top level.
  const all = [...listed, { oldText: input.oldText, newText: input.newText }];
  return all.flatMap((edit) =>
    isPlainObject(edit) && typeof edit.oldText === 'string' && typeof edit.newText === 'string'
      ? [{ old_string: edit.oldText, new_string: edit.newText }]
      : [],
  );
}

/**
 * Pi's `tool_call` as the payload `HookService.preToolUse` reads: see the
 * table above. A shell call is `Bash` with its command, or none (an exec with
 * no command is denied downstream); a file tool is `Read`/`Write`/`Edit`
 * with `file_path` resolved, or no path (an edit of unknown target is
 * denied; a read with no path is an unknown call); a search tool is
 * `Grep`/`Glob`/`LS` with `path` resolved. `pi_tool_name` keeps Pi's name.
 * `no_additional_context_channel` is set: Pi's `tool_call` result has no
 * `additionalContext` (the extension sets it too).
 */
export function piToClaudePayload(raw: Record<string, unknown>): ClaudePreToolUsePayload {
  // Only this mapping marks a call's kind; never one the caller sent.
  const { agile_tool_kind: _kind, ...payload } = raw;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const base: ClaudePreToolUsePayload = { ...payload, no_additional_context_channel: true };
  const mapped = (tool_name: string, tool_input: Record<string, unknown>) => ({
    ...base,
    tool_name,
    tool_input,
    pi_tool_name: toolName,
  });

  if (toolName === 'bash') {
    const command = input.command;
    return mapped('Bash', typeof command === 'string' && command.length > 0 ? { command } : {});
  }

  const file = toolName !== undefined ? PI_FILE_TOOLS.get(toolName) : undefined;
  if (file !== undefined) {
    const path = piPath(input.path ?? input.file_path, cwd);
    if (file === 'Read' && path !== undefined) return mapped('Read', { file_path: path });
    if (file === 'Write') {
      return mapped('Write', {
        ...(path !== undefined ? { file_path: path } : {}),
        ...(typeof input.content === 'string' ? { content: input.content } : {}),
      });
    }
    if (file === 'Edit') {
      const edits = piEdits(input);
      return mapped('Edit', {
        ...(path !== undefined ? { file_path: path } : {}),
        ...(edits.length > 0 ? { edits } : {}),
      });
    }
  }

  const search = toolName !== undefined ? PI_SEARCH_TOOLS.get(toolName) : undefined;
  if (search !== undefined) {
    const where = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const path = piPath(where, cwd);
    if (path !== undefined) {
      return mapped(search, {
        path,
        ...(typeof input.pattern === 'string' ? { pattern: input.pattern } : {}),
      });
    }
  }

  // Not a Pi built-in we can read (or a read/search whose path can't be placed).
  return {
    ...base,
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    tool_input: input,
    agile_tool_kind: 'other',
  };
}
