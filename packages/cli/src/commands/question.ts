/**
 * `agile question list` / `agile question answer <id> --answer "..."
 * [--as decision|reply|ticket]` — thin wrappers over the `question.*` RPC
 * namespace (`packages/daemon/src/questions/rpc.ts`, T040; §17 "Control room
 * v2" → "Questions vs Decisions"). Sibling of `commands/gate.ts`'s
 * `agile note`.
 */

import type { Question } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

/** `question.answer`'s result: the question plus whatever the answer produced. */
export interface AnswerQuestionRpcResult {
  question: Question;
  decision?: { entry: { id: string } };
  ticket?: { id: string };
}

export async function runQuestionList(socketPath: string, json: boolean): Promise<number> {
  const result = await callRpc<Question[]>(socketPath, 'question.list', { open: true });
  if (json) printJson(result);
  else if (result.length === 0) console.log('questions: (none open)');
  else
    for (const q of result) {
      console.log(`${q.id}  ${q.raised_by}  ${q.ticket ?? '-'}  ${q.text}`);
    }
  return 0;
}

/**
 * `--as` names how the answer is applied: `reply` (default — just answer the
 * raiser), `decision` (record a `DEC-*` through the oracle write guard and
 * link it), or `ticket` (apply the answer as a ticket edit; the edit fields
 * come from `--edit '<json>'`, since a contract change is not a one-word
 * flag).
 */
export async function runQuestionAnswer(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'question-id');
  const answer = requireOption(args.options, 'answer');
  const resolvedAs = optionalString(args.options, 'as') ?? 'reply';
  const by = args.options.by;
  const editRaw = optionalString(args.options, 'edit');
  let edit: unknown;
  if (editRaw !== undefined) {
    try {
      edit = JSON.parse(editRaw);
    } catch {
      throw new Error('--edit must be a JSON object');
    }
  }
  const result = await callRpc<AnswerQuestionRpcResult>(socketPath, 'question.answer', {
    id,
    answer,
    resolved_as: resolvedAs,
    by: typeof by === 'string' ? by : 'human',
    ...(edit !== undefined ? { edit } : {}),
    ...(typeof args.options.ticket === 'string' ? { ticket: args.options.ticket } : {}),
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.question.id],
      ['status', result.question.status],
      ['resolved_as', result.question.resolved_as ?? '-'],
      ['answer', result.question.answer ?? '-'],
    ]);
  return 0;
}

export async function runQuestionRaise(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const text = requireOption(args.options, 'text');
  const raisedBy = optionalString(args.options, 'by') ?? 'human';
  const result = await callRpc<Question>(socketPath, 'question.raise', {
    raised_by: raisedBy,
    text,
    ...(typeof args.options.ticket === 'string' ? { ticket: args.options.ticket } : {}),
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['status', result.status],
      ['text', result.text],
    ]);
  return 0;
}
