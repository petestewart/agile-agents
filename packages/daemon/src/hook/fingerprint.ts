/**
 * The tool-call fingerprint the route band is keyed on (§8.1). An approval
 * unlocks one call, not a capability: yes to editing `package.json` isn't
 * yes to `bun.lock`, and yes to a push isn't yes to `--force`. So the gate
 * stores a digest, and the retry must match it.
 *
 *  - Edit calls: tool + normalised absolute path (the same file addressed
 *    two ways must be one fingerprint).
 *  - `Bash`: tool + the exact command, whitespace-collapsed only (a retry
 *    reflows a heredoc far more often than it changes its mind; a flag
 *    difference is a different call).
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { type GateCall, MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { ClaudePreToolUsePayload } from './types';

/** 64 bits of sha-256, hex: readable in YAML, wide enough for one stream's lifetime. */
function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

const EDIT_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

function editPath(payload: ClaudePreToolUsePayload, worktreePath: string): string | undefined {
  const input = payload.tool_input ?? {};
  for (const key of EDIT_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return isAbsolute(value) ? resolve(value) : resolve(worktreePath, value);
    }
  }
  return undefined;
}

function commandOf(payload: ClaudePreToolUsePayload): string | undefined {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') return undefined;
  const collapsed = command.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? undefined : collapsed.slice(0, MESSAGE_BODY_MAX_CHARS);
}

/** The call a routed verdict is about; `undefined` with no tool name (the caller denies outright). */
export function fingerprintCall(
  payload: ClaudePreToolUsePayload,
  worktreePath: string,
): GateCall | undefined {
  const tool = payload.tool_name;
  if (tool === undefined || tool.length === 0) return undefined;

  const command = commandOf(payload);
  if (command !== undefined) {
    return { tool, command, fingerprint: digest([tool, 'command', command]) };
  }
  const path = editPath(payload, worktreePath);
  if (path !== undefined) {
    return { tool, path, fingerprint: digest([tool, 'path', path]) };
  }
  // A gated tool with no path or command: the tool name alone is the call.
  return { tool, fingerprint: digest([tool]) };
}
