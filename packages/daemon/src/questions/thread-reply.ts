/**
 * One human line on a stream, the same from every edge (the composer and
 * `agile stream say`): written, prompted into a live worker, and the answer
 * to that session's open questions. With nobody live it closes nothing.
 */

import type { ThreadEntry } from '@agile-agents/shared';
import type { QuestionService } from './service';

/** What `AttachService.say` returns: the line, the session it was prompted into, and (T361) whether that session was started for it. */
export interface SaidLine {
  entry: ThreadEntry;
  prompted?: string;
  started?: true;
}

export interface ThreadReplyDeps {
  /** `AttachService.say`; `start` (T361) starts an agent on a node with none live. */
  say(streamId: string, body: string, options?: { start?: boolean }): Promise<SaidLine>;
  questions?: Pick<QuestionService, 'answerFromThread'>;
}

export async function sayAndAnswer(
  deps: ThreadReplyDeps,
  streamId: string,
  body: string,
  options: { start?: boolean } = {},
): Promise<SaidLine> {
  const said = await deps.say(streamId, body, options);
  if (said.prompted !== undefined && deps.questions !== undefined) {
    await deps.questions.answerFromThread(said.prompted, said.entry).catch(() => {
      // The line and the prompt already happened; a stuck card is still answerable from the inbox.
    });
  }
  return said;
}
