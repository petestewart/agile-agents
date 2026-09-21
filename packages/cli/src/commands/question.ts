/**
 * `agile question list|raise|answer` — thin wrappers over the `question.*`
 * RPC namespace (`packages/daemon/src/questions/rpc.ts`; cockpit design
 * §1.4). T121 re-keyed them to streams: `--stream <id>` replaced
 * `--ticket`, and `reply` is the only resolution left, so `--as`/`--edit`
 * are gone. `agile answer <id> <text>` (`commands/answer.ts`) is the short
 * form an operator actually types.
 */

import type { Question } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

/** `question.answer`'s result. */
export interface AnswerQuestionRpcResult {
  question: Question;
}

export async function runQuestionList(socketPath: string, json: boolean): Promise<number> {
  const result = await callRpc<Question[]>(socketPath, 'question.list', { open: true });
  if (json) printJson(result);
  else if (result.length === 0) console.log('questions: (none open)');
  else
    for (const q of result) {
      console.log(`${q.id}  ${q.raised_by}  ${q.stream}  ${q.text}`);
    }
  return 0;
}

export async function runQuestionAnswer(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'question-id');
  const answer = requireOption(args.options, 'answer');
  const result = await callRpc<AnswerQuestionRpcResult>(socketPath, 'question.answer', {
    id,
    answer,
    resolved_as: 'reply',
    by: optionalString(args.options, 'by') ?? 'human',
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.question.id],
      ['stream', result.question.stream],
      ['status', result.question.status],
      ['answer', result.question.answer ?? '-'],
    ]);
  return 0;
}

export async function runQuestionRaise(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const stream = requireOption(args.options, 'stream');
  const text = requireOption(args.options, 'text');
  const result = await callRpc<Question>(socketPath, 'question.raise', {
    stream,
    raised_by: optionalString(args.options, 'by') ?? 'human',
    text,
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['stream', result.stream],
      ['status', result.status],
      ['text', result.text],
    ]);
  return 0;
}
