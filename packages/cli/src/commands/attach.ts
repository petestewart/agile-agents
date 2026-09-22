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
  if (role !== undefined && role !== 'worker' && role !== 'reviewer') {
    throw new Error(`--role must be worker or reviewer, got ${role}`);
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

/**
 * `agile detach <stream>` — T137: the line says what actually happened.
 * The old text ("has no live session or it has been stopped") was printed
 * even when a live session had just been killed, and always exited 0; the
 * RPC now reports whether anything was stopped, and which sessions, so
 * "nothing was running" is an exit-1 failure a script can act on.
 */
export async function runDetach(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requirePositional(args, 0, 'stream-id');
  const result = await callRpc<{ stopped: boolean; sessions?: string[] }>(
    socketPath,
    'attach.stop',
    { stream },
  );
  if (json) {
    printJson(result);
    return result.stopped ? 0 : 1;
  }
  if (!result.stopped) {
    console.error(`agile detach: ${stream} has no live session`);
    return 1;
  }
  for (const session of result.sessions ?? []) {
    console.log(`agile detach: stopped ${session} on ${stream}`);
  }
  return 0;
}
