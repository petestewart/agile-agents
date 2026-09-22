/**
 * T145: a gate decision closes the questions the same session left open.
 *
 * Wired exactly as `wireGateDecisionDelivery` (`hook/route-band.ts`) and
 * `wireLandGateResolution` are, and for the same reason: `GateService` has
 * no business knowing what a question is. The rule, in one sentence:
 * **resolving a gate resolves every question from the same session that is
 * still open at that moment, as `superseded`.**
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
