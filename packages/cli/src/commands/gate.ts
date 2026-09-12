/**
 * `agile approve` / `agile deny` / `agile note` / `agile delegate` /
 * `agile resolve` / `agile breaker clear` — thin wrappers over the `gate.*`
 * RPC namespace (`packages/daemon/src/gates/rpc.ts`, T018; `deny`/`note` and
 * the `--note` free text on every decision are T039).
 */

import type { GateService } from '@agile-agents/daemon';
import type { BreakerState, HilRequest } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

// `GateService` and `BreakerState` are imported only for the type they name
// on `gate.list`'s/`gate.breaker_clear`'s result shape; no runtime use.
export type GateList = ReturnType<GateService['list']>;

/**
 * `agile approve <id> [--note "..."]` / `agile deny <id> [--note "..."]`
 * (T039, §17 "Control room v2"): the free text is stored on the request,
 * carried on the `hil_resolved` event, and delivered to the waiting agent
 * and the EM.
 */
async function runDecision(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  method: 'gate.approve' | 'gate.deny',
): Promise<number> {
  const id = requirePositional(args, 0, 'hil-id');
  const by = args.options.by;
  const note = optionalString(args.options, 'note');
  const result = await callRpc<HilRequest>(socketPath, method, {
    id,
    by: typeof by === 'string' ? by : 'human',
    ...(note !== undefined ? { note } : {}),
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['decision', result.decision ?? '-'],
      ...(result.note !== undefined ? ([['note', result.note]] as Array<[string, string]>) : []),
    ]);
  return 0;
}

export async function runApprove(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return runDecision(socketPath, args, json, 'gate.approve');
}

export async function runDeny(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return runDecision(socketPath, args, json, 'gate.deny');
}

/**
 * `agile note <hil-id> --note "..."` — a typed answer with no button press
 * (T039). Records the note on the pending request and hands it to the EM
 * delegate; it never resolves the gate itself.
 */
export async function runGateNote(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'hil-id');
  const by = args.options.by;
  const note = requireOption(args.options, 'note');
  const result = await callRpc<HilRequest>(socketPath, 'gate.note', {
    id,
    note,
    by: typeof by === 'string' ? by : 'human',
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['note', result.note ?? '-'],
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
  const note = optionalString(args.options, 'note');
  const result = await callRpc<HilRequest>(socketPath, 'gate.resolve', {
    id,
    decision,
    by: typeof by === 'string' ? by : 'human',
    ...(note !== undefined ? { note } : {}),
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['decision', result.decision ?? '-'],
      ...(result.note !== undefined ? ([['note', result.note]] as Array<[string, string]>) : []),
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
