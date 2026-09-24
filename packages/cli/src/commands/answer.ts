/**
 * `agile answer <id> …` — the operator answering whatever the inbox put in
 * front of them, from the terminal (cockpit design §1.4, §3).
 *
 * One verb for one list (T138). The inbox is a single queue of two kinds of
 * item, and it prints one id column; making the operator remember which
 * verb goes with which prefix would be the list's own shape leaking into
 * the CLI:
 *
 *  - `agile answer Q-… <text>` — the answer text lands on the stream thread
 *    and reaches the waiting session (`question.answer`).
 *  - `agile answer HIL-… yes|no [note]` — approves or denies the gate
 *    (`gate.approve`/`gate.deny`), and the note reaches the session with
 *    the decision. The `gate.*` RPC namespace is unchanged.
 */

import type { HilRequest, Question } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

export interface AnswerQuestionRpcResult {
  question: Question;
}

/** `yes`/`no` and the obvious synonyms an operator types instead. Anything else is a usage error, never a guess. */
const YES = new Set(['yes', 'y', 'approve', 'approved', 'allow', 'ok']);
const NO = new Set(['no', 'n', 'deny', 'denied', 'reject', 'block']);

export async function runAnswer(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'id');
  // The answer is the rest of the line, so `agile answer Q-… use the second
  // option` works without quoting.
  const rest = args.positionals.slice(1);
  const by = optionalString(args.options, 'by') ?? 'human';

  if (id.startsWith('HIL-')) return await answerGate(socketPath, id, rest, by, json);

  const text = rest.join(' ').trim();
  if (text.length === 0) {
    throw new Error('usage: agile answer <question-id> <text>');
  }
  const result = await callRpc<AnswerQuestionRpcResult>(socketPath, 'question.answer', {
    id,
    answer: text,
    resolved_as: 'reply',
    by,
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

async function answerGate(
  socketPath: string,
  id: string,
  rest: string[],
  by: string,
  json: boolean,
): Promise<number> {
  // T145: `agile answer HIL-… "yes go ahead"` — decision and note in one
  // quoted argument — is what an operator types, and it was a usage error.
  // A first positional that carries whitespace is split on its first space.
  const first = (rest[0] ?? '').trim();
  const space = first.search(/\s/);
  const parts =
    space === -1 ? rest : [first.slice(0, space), first.slice(space + 1), ...rest.slice(1)];
  const verdict = (parts[0] ?? '').toLowerCase();
  const approve = YES.has(verdict);
  if (!approve && !NO.has(verdict)) {
    throw new Error(`usage: agile answer ${id} yes|no [note]`);
  }
  const note = parts.slice(1).join(' ').trim();
  const result = await callRpc<HilRequest>(socketPath, approve ? 'gate.approve' : 'gate.deny', {
    id,
    by,
    ...(note.length > 0 ? { note } : {}),
  });
  if (json) printJson(result);
  else
    printFields([
      ['id', result.id],
      ['stream', result.stream],
      ['status', result.status],
      ['decision', result.decision ?? '-'],
      ['note', result.note ?? '-'],
    ]);
  return 0;
}
