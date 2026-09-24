/**
 * One human line on a stream, the same from every edge (the composer and
 * `agile stream say`): written, prompted into a live worker, and the answer
 * to that session's open questions. With nobody live it closes nothing.
 */

import type { ThreadEntry } from '@agile-agents/shared';
import type { QuestionService } from './service';

export interface ThreadReplyDeps {
  /** `AttachService.say` — the line, and the session it was prompted into. */
  say(streamId: string, body: string): Promise<{ entry: ThreadEntry; prompted?: string }>;
  questions?: Pick<QuestionService, 'answerFromThread'>;
}

export async function sayAndAnswer(
  deps: ThreadReplyDeps,
  streamId: string,
  body: string,
): Promise<{ entry: ThreadEntry; prompted?: string }> {
  const said = await deps.say(streamId, body);
  if (said.prompted !== undefined && deps.questions !== undefined) {
    await deps.questions.answerFromThread(said.prompted, said.entry).catch(() => {
      // The line and the prompt already happened; a stuck card is still answerable from the inbox.
    });
  }
  return said;
}
