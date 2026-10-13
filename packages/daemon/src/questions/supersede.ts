/**
 * A gate decision resolves every question the same session still has
 * open, as `superseded`. Listens on `GateService.onResolved` (T527: however
 * the gate was decided), which needn't know what a question is.
 */

import type { GateService } from '../gates/service';

/** The slice of `QuestionService` this wiring needs. */
export interface QuestionSupersession {
  supersede(sessionId: string, byGateId: string): Promise<unknown>;
}

export function wireQuestionSupersession(
  gates: Pick<GateService, 'onResolved'>,
  questions: QuestionSupersession,
): void {
  gates.onResolved(async (resolved) => {
    if (resolved.session !== undefined) {
      await questions.supersede(resolved.session, resolved.id);
    }
  });
}
