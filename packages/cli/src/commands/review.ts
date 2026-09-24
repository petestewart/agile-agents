/**
 * `agile review <stream>` (T131 — cockpit design §4.2) — spawns a reviewer
 * session on the stream's worktree under the read-only permission policy.
 *
 * It is `agile attach --role reviewer` with a name of its own, because that
 * is how the design names it and how the cockpit's Review button calls it.
 * Like `attach.ts` it is pure pass-through: every default (`--vendor`,
 * `--model`, `--effort`) is resolved daemon-side, so two clients never
 * disagree about which model a review ran on.
 *
 * The reviewer writes nothing. Its output is `finding` entries on the
 * thread plus structured items under `agent.findings`, and its exit writes
 * a `review finished: N findings` line. `agent.status` is the worker's
 * field and a review never moves it.
 */

import { EFFORT_LEVELS, type SessionRef, type Stream } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

interface ReviewResult {
  session: SessionRef;
  stream: Stream;
}

export async function runReview(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requirePositional(args, 0, 'stream-id');
  const vendor = optionalString(args.options, 'vendor');
  const model = optionalString(args.options, 'model');
  const effort = optionalString(args.options, 'effort');

  if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${effort}`);
  }

  const result = await callRpc<ReviewResult>(socketPath, 'attach.start', {
    stream,
    role: 'reviewer',
    ...(vendor !== undefined ? { vendor } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });

  if (json) {
    printJson(result.session);
    return 0;
  }
  const session = result.session;
  console.log(
    `agile review: ${session.id} ${session.vendor}/${session.model} effort=${
      session.effort ?? 'ignored'
    } on ${result.stream.id}`,
  );
  if (session.worktree !== undefined) console.log(`worktree=${session.worktree}`);
  return 0;
}
