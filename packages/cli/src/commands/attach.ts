/**
 * `agile attach <stream>` / `agile detach <stream>` (T130) — the CLI over
 * the daemon's `attach.*` RPC (cockpit design §4.1).
 *
 * Thin, like `stream.ts`: parse argv, call one method, print human or
 * `--json`. Every default (`--vendor`, `--model`, `--effort`) is resolved
 * daemon-side against the stream's repo entry and the home config, so the
 * flags here are pure pass-through — the CLI never picks a default of its
 * own, or the answer to "why did this session get that model?" would
 * depend on which client asked.
 */

import { EFFORT_LEVELS, type SessionRef, type Stream } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

interface AttachResult {
  session: SessionRef;
  stream: Stream;
}

/** `id vendor/model effort status` — the sessions strip, in one line per session. */
export function formatSession(session: SessionRef): string {
  return `${session.id}  ${session.vendor}/${session.model}  effort=${
    session.effort ?? '-'
  }  ${session.status}`;
}

export async function runAttach(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requirePositional(args, 0, 'stream-id');
  const vendor = optionalString(args.options, 'vendor');
  const model = optionalString(args.options, 'model');
  const effort = optionalString(args.options, 'effort');
  const role = optionalString(args.options, 'role');

  if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${effort}`);
  }
  // T131 lands the reviewer's read-only policy; until then attaching one
  // would run a reviewer under the worker's permissions, which is worse
  // than refusing.
  if (role !== undefined && role !== 'worker') {
    throw new Error(`--role ${role} is not supported yet (T131); only --role worker`);
  }

  const result = await callRpc<AttachResult>(socketPath, 'attach.start', {
    stream,
    ...(vendor !== undefined ? { vendor } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(role !== undefined ? { role } : {}),
  });

  if (json) {
    printJson(result.session);
    return 0;
  }
  const session = result.session;
  console.log(
    `agile attach: ${session.id} ${session.vendor}/${session.model} effort=${
      session.effort ?? 'ignored'
    } on ${result.stream.id}`,
  );
  if (session.worktree !== undefined) console.log(`worktree=${session.worktree}`);
  return 0;
}

export async function runDetach(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requirePositional(args, 0, 'stream-id');
  const result = await callRpc<{ stopped: boolean }>(socketPath, 'attach.stop', { stream });
  if (json) printJson(result);
  else console.log(`agile detach: ${stream} has no live session or it has been stopped`);
  return 0;
}
