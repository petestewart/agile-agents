/**
 * `agile director say "<line>"` (T300, projects-design §12): a human line to
 * the Director over the daemon's `director.*` RPC. The reply lands on the
 * Director's thread; `agile tail --director` follows it.
 */

import type { ThreadEntry } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

export async function runDirectorSay(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const body = args.positionals.join(' ').trim();
  if (body === '') {
    console.error('agile director say needs a line: agile director say "…"');
    return 1;
  }
  const out = await callRpc<{ entry: ThreadEntry; event: { id: string } }>(
    socketPath,
    'director.say',
    { body },
  );
  if (json) printJson(out);
  else console.log(`agile director say: sent (${out.event.id}); follow with agile tail --director`);
  return 0;
}
