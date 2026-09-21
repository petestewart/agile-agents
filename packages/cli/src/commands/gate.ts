/**
 * `agile gate list` / `agile breaker clear` — thin wrappers over the `gate.*`
 * RPC namespace (`packages/daemon/src/gates/rpc.ts`, T018). T122 deleted the
 * `approve`/`deny`/`note`/`delegate`/`resolve` verbs with the EM that
 * delegation targeted; a gate is decided from the cockpit (`POST
 * /api/hil/:id/...`) until T140's `agile land`.
 */

import type { GateService } from '@agile-agents/daemon';
import type { BreakerState } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

// `GateService` and `BreakerState` are imported only for the type they name
// on `gate.list`'s/`gate.breaker_clear`'s result shape; no runtime use.
export type GateList = ReturnType<GateService['list']>;

export async function runGateList(socketPath: string, json: boolean): Promise<number> {
  const result = await callRpc<GateList>(socketPath, 'gate.list');
  if (json) printJson(result);
  else if (result.length === 0) console.log('gates: (none open)');
  else for (const r of result) console.log(`${r.id}  ${r.status}  ${r.hil_kind}  owner=${r.owner}`);
  return 0;
}

export async function runBreakerClear(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const signal = requirePositional(args, 0, 'signal');
  const result = await callRpc<BreakerState>(socketPath, 'gate.breaker_clear', { signal });
  if (json) printJson(result);
  else
    printFields([
      ['signal', signal],
      ['cleared', 'true'],
    ]);
  return 0;
}
