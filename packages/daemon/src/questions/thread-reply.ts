/**
 * T169: one human line on a stream, the same way from every edge — the
 * cockpit's composer (`POST /api/streams/:id/say`) and the CLI's `agile
 * stream say` (`stream.thread_append`). The line is written and, when a
 * worker is live, prompted into it (`AttachService.say`); when that
 * prompted session has open questions, the line is their answer
 * (`QuestionService.answerFromThread`). A line with nobody live to
 * deliver it to closes nothing.
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
