/**
 * `agile halt [--scope]` / `agile resume` — `state.halt_create` /
 * `state.halt_release` (T008 scope; `packages/daemon/src/halts/index.ts`).
 *
 * `--scope` defaults to `global` (§4 "Halts": `scope: global | [TKT-...]`,
 * §15's `team:<name>` variant). A comma-separated list of `TKT-####` ids
 * (e.g. `--scope TKT-0001,TKT-0002`) is parsed into the array form; anything
 * else (`global`, or a `team:<name>` string) is passed through as-is — both
 * are valid `HaltScope` shapes and `state.halt_create` re-validates via
 * `HaltScopeSchema` regardless.
 */

import type { Halt } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

const TICKET_ID_PATTERN = /^TKT-\d{4,}$/;

export function parseHaltScope(raw: string | undefined): unknown {
  if (!raw || raw === 'global') return 'global';
  if (raw.startsWith('team:')) return raw;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.every((id) => TICKET_ID_PATTERN.test(id))) return ids;
  return raw; // let the daemon's HaltScopeSchema reject it with a proper message
}

export async function runHalt(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const scope = parseHaltScope(optionalString(args.options, 'scope'));
  const reason = optionalString(args.options, 'reason') ?? 'raised via agile halt';
  const raisedBy = optionalString(args.options, 'by') ?? 'human';

  const halt = await callRpc<Halt>(socketPath, 'state.halt_create', {
    scope,
    reason,
    raised_by: raisedBy,
  });

  if (json) printJson(halt);
  else
    printFields([
      ['halted', halt.id],
      ['scope', JSON.stringify(halt.scope)],
      ['reason', halt.reason],
    ]);
  return 0;
}

export async function runResume(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = optionalString(args.options, 'id') ?? args.positionals[0];
  if (!id) throw new Error('usage: agile resume <halt-id> (or --id <halt-id>)');
  const result = await callRpc<{ released: boolean }>(socketPath, 'state.halt_release', { id });
  if (json) printJson(result);
  else console.log(`resumed: ${id}`);
  return 0;
}
