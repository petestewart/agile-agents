/**
 * The TypeSafe Jev wire mapping, and nothing else.
 *
 * Everything this adapter knows about the shape of the HTTP call lives in
 * this one module on purpose: it is the only part of the classifier tier
 * that cannot be verified offline, so when the first live check corrects it
 * (`agile rules test <rule-id>` against the real API), it is corrected in
 * one file and the fixtures under `__fixtures__/` move with it.
 *
 * Source: the public HTTP API reference at https://docs.typesafe.ai/api.
 * Taken from the docs verbatim:
 *
 *  - `POST <base>/v1/systemone`, `Authorization: Bearer <key>`,
 *    `Content-Type: application/json`.
 *  - Request `{ state, model, questions }` where `questions` is a **map**
 *    of caller-chosen id to a typed question, and a Noul question is
 *    `{ type: 'noul', instructions: <the question> }`.
 *  - Response `{ model, answers, usage }` where `answers` is a map under
 *    the same ids, and a Noul answer is `{ type: 'noul', noul: <number> }`.
 *  - Errors are plain HTTP status codes (401, 422, 429, 529).
 *
 * A Noul answer has no `confidence` (the docs: "There is no separate
 * `confidence` value for a Noul"); per **D14** the single value is the
 * answer and its certainty in one, and the bands read it raw. A
 * `confidence` field in a response is ignored.
 *
 * **Unverified (T156):** the wire spelling of a rule's `criteria`. The docs
 * describe Noul criteria as true/false descriptions; this adapter sends them
 * as `criteria: { true, false }` on the Noul question. That field name has
 * not been checked against the live API — if the first live check shows a
 * different spelling, `JEV_CRITERIA_FIELD` below is the one place to fix.
 */

import { ClassifierUnavailableError } from './types';
import type { Answer, Noul } from './types';

/** The evaluation endpoint's path, appended to the configured base URL. */
export const JEV_ENDPOINT_PATH = '/v1/systemone';

/** The model alias the docs tell callers to use — TypeSafe's flagship. */
export const JEV_MODEL = 'jev-latest';

/**
 * The Noul question field that carries a rule's criteria. Unverified against
 * the live API — see this module's header. The one place its name lives.
 */
export const JEV_CRITERIA_FIELD = 'criteria';

/** One entry of the request's `questions` map. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  [JEV_CRITERIA_FIELD]?: { true: string; false: string };
}

export interface JevRequest {
  state: string;
  model: string;
  questions: Record<string, JevNoulQuestion>;
}

/** The full URL for a configured base. A trailing slash on the base is fine. */
export function jevEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${JEV_ENDPOINT_PATH}`;
}

/**
 * One call, N questions (§6.2). The map keys are the caller's `Noul.id` —
 * in practice a rule id — and the docs guarantee the answers come back
 * under the same keys. The keys are not sent to the model and play no part
 * in inference, so a rule id is a safe key.
 *
 * Duplicate ids are rejected rather than silently collapsed: a map cannot
 * hold two questions under one key, and returning one answer for two rules
 * would gate the wrong rule.
 */
export function buildJevRequest(state: string, questions: Noul[], model = JEV_MODEL): JevRequest {
  const map: Record<string, JevNoulQuestion> = {};
  for (const question of questions) {
    if (map[question.id] !== undefined) {
      throw new ClassifierUnavailableError(
        'bad_response',
        `duplicate classifier question id "${question.id}"`,
      );
    }
    map[question.id] = {
      type: 'noul',
      instructions: question.question,
      ...(question.criteria !== undefined
        ? { [JEV_CRITERIA_FIELD]: { true: question.criteria.true, false: question.criteria.false } }
        : {}),
    };
  }
  return { state, model, questions: map };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps the response back to one `Answer` per question asked, in the order
 * asked. A missing or malformed answer is a `bad_response`, never a
 * defaulted probability: §6.4's fail policy is a deliberate decision per
 * rule, and inventing a 0 here would quietly allow everything instead.
 */
export function parseJevResponse(body: unknown, questions: Noul[]): Answer[] {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new ClassifierUnavailableError(
      'bad_response',
      'classifier response has no "answers" object',
    );
  }
  const answers = body.answers;
  return questions.map((question) => {
    const raw = answers[question.id];
    if (!isRecord(raw)) {
      throw new ClassifierUnavailableError(
        'bad_response',
        `classifier response has no answer for "${question.id}"`,
      );
    }
    const probability = raw.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      throw new ClassifierUnavailableError(
        'bad_response',
        `classifier answer for "${question.id}" has no numeric "noul"`,
      );
    }
    return { id: question.id, probability };
  });
}
