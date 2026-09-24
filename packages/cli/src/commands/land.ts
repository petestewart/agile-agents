/**
 * `agile deliver <node>` (T223, §14.7; `agile land` is its alias; T132) — the CLI half of the landing path (design/
 * cockpit-design.md §8.2). The Land button in the UI calls the same
 * `land.stream` RPC; this is the terminal's version of pressing it.
 *
 * Thin, like `attach.ts`: one call, print the thread line the daemon wrote
 * (`landed <branch> into <target> (<sha>)`, `gate raised: <id>`, or the
 * conflict line) or `--json`. Every decision — target branch, gate, diff
 * rules, merge — is the daemon's.
 */

import type { ParsedArgs } from '../args';
import { requirePositional } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

/** Mirrors the daemon's `LandOutcome` (`delivery/service.ts`). */
interface LandOutcome {
  status: 'gated' | 'refused' | 'blocked' | 'landed';
  line: string;
  conflicts?: string[];
}

export async function runLand(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requirePositional(args, 0, 'stream-id');
  const outcome = await callRpc<LandOutcome>(socketPath, 'delivery.deliver', { stream });

  if (json) {
    printJson(outcome);
  } else {
    console.log(outcome.line);
  }
  // A blocked land (conflict) is a failure the shell should see; a raised
  // gate is not — it is the normal "now the human decides" outcome.
  return outcome.status === 'blocked' || outcome.status === 'refused' ? 1 : 0;
}
