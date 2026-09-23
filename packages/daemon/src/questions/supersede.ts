/**
 * A gate decision resolves every question the same session still has
 * open, as `superseded`. Wired around `GateService.respond`, which needn't
 * know what a question is.
 */

import type { GateService } from '../gates/service';

/** The slice of `QuestionService` this wiring needs. */
export interface QuestionSupersession {
  supersede(sessionId: string, byGateId: string): Promise<unknown>;
}

export function wireQuestionSupersession(
  gates: GateService,
  questions: QuestionSupersession,
): void {
  const respond = gates.respond.bind(gates);
  gates.respond = async (id, decision, by, note) => {
    const resolved = await respond(id, decision, by, note);
    if (resolved.session !== undefined) {
      await questions.supersede(resolved.session, resolved.id);
    }
    return resolved;
  };
}
