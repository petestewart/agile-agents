/**
 * The tool-call fingerprint the route band is keyed on (T138,
 * design/cockpit-design.md §8.1).
 *
 * An approved `classifier_review` gate unlocks **one call**, not a
 * capability: "the human said yes to editing `package.json`" must not also
 * let the next turn edit `bun.lock`, and "yes to `git push origin
 * T138-hook-route-band`" must not also allow `git push --force`. So the
 * gate stores a digest of what was asked, and the retry has to produce the
 * same digest.
 *
 * What goes into it:
 *  - **edit-kind calls**: the tool name plus the *normalised absolute*
 *    path. Claude sends `file_path` absolute in practice but not always
 *    (`notebook_path`, a relative path from a cd'd shell), and the same
 *    file addressed two ways has to be one fingerprint or an approval
 *    silently fails to match on retry.
 *  - **`Bash`**: the tool name plus the exact command, whitespace-collapsed
 *    only. Nothing else is normalised: two commands that differ by a flag
 *    are two different calls, which is the entire point of gating them.
 *
 * Whitespace-collapsing is deliberate and is the only normalisation a
 * command gets — a model retrying "the same call" reformats indentation in
 * a heredoc far more often than it changes its mind.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { type GateCall, MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { ClaudePreToolUsePayload } from './types';

/** 64 bits of sha-256, hex — short enough to read in a yaml file, wide enough that two distinct calls never collide in one stream's lifetime. */
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

/**
 * The call a routed verdict is about, or `undefined` when this payload
 * carries nothing identifying at all (no tool name) — which the caller
 * treats as unroutable and denies outright rather than raising a gate
 * nobody could match a retry against.
 */
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
  // A gated tool with no path and no command (a custom tool reporting
  // `kind: edit` on some other field): the tool name alone is the call.
  return { tool, fingerprint: digest([tool]) };
}
