/**
 * `agile answer <question-id> <text>` (T121) — the operator answering an
 * agent's question from the terminal (cockpit design §1.4). A thin wrapper
 * over the `question.answer` RPC with the only resolution there is,
 * `reply`: the answer lands on the stream thread and reaches the waiting
 * session.
 */

import type { Question } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

export interface AnswerQuestionRpcResult {
  question: Question;
}

export async function runAnswer(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'question-id');
  // The answer is the rest of the line, so `agile answer Q-… use the second
  // option` works without quoting.
  const text = args.positionals.slice(1).join(' ').trim();
  if (text.length === 0) {
    throw new Error('usage: agile answer <question-id> <text>');
  }
  const result = await callRpc<AnswerQuestionRpcResult>(socketPath, 'question.answer', {
    id,
    answer: text,
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
