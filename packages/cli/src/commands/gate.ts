/**
 * `agile approve` / `agile delegate` / `agile resolve` / `agile breaker
 * clear` — thin wrappers over the `gate.*` RPC namespace
 * (`packages/daemon/src/gates/rpc.ts`, T018).
 */

import type { GateService } from '@agile-agents/daemon';
import type { BreakerState, HilRequest } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

// `GateService` and `BreakerState` are imported only for the type they name
// on `gate.list`'s/`gate.breaker_clear`'s result shape; no runtime use.
export type GateList = ReturnType<GateService['list']>;

export async function runApprove(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'hil-id');
  const by = args.options.by;
  const result = await callRpc<HilRequest>(socketPath, 'gate.approve', {
    id,
    by: typeof by === 'string' ? by : 'human',
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['decision', result.decision ?? '-'],
    ]);
  return 0;
}

export async function runDelegate(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'hil-id');
  const to = requireOption(args.options, 'to');
  const result = await callRpc<HilRequest>(socketPath, 'gate.delegate', { id, to });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['owner', result.owner],
    ]);
  return 0;
}

export async function runResolve(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'hil-id');
  const decision = requireOption(args.options, 'decision');
  const by = args.options.by;
  const result = await callRpc<HilRequest>(socketPath, 'gate.resolve', {
    id,
    decision,
    by: typeof by === 'string' ? by : 'human',
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['decision', result.decision ?? '-'],
    ]);
  return 0;
}

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
