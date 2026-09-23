/**
 * The TypeSafe Jev wire mapping, alone in this module because it is the one
 * part of the tier that can't be verified offline (the fixtures in
 * `__fixtures__/` move with it). From https://docs.typesafe.ai/api:
 *
 *  - `POST <base>/v1/systemone`, `Authorization: Bearer <key>`, JSON;
 *  - request `{ state, model, questions }`, `questions` a map of id to
 *    `{ type: 'noul', instructions }`;
 *  - response `{ model, answers, usage }`, answers under the same ids as
 *    `{ type: 'noul', noul: <number> }`;
 *  - errors are plain HTTP statuses (401, 422, 429, 529).
 *
 * A Noul has no `confidence`; per D14 the value is read raw.
 * Unverified: the spelling of a rule's `criteria` field
 * (`JEV_CRITERIA_FIELD`, the one place to fix it).
 */

import { ClassifierUnavailableError } from './types';
import type { Answer, Noul } from './types';

/** The evaluation endpoint's path, appended to the configured base URL. */
export const JEV_ENDPOINT_PATH = '/v1/systemone';

/** The model alias the docs recommend. */
export const JEV_MODEL = 'jev-latest';

/** The Noul field carrying a rule's criteria (unverified; see header). */
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

/** The full URL for a configured base (a trailing slash is fine). */
export function jevEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${JEV_ENDPOINT_PATH}`;
}

/**
 * One call, N questions (§6.2), keyed by `Noul.id` (a rule id; keys never
 * reach the model). A duplicate id is rejected: one answer for two rules
 * would gate the wrong one.
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
 * One `Answer` per question, in order. A missing or malformed answer is a
 * `bad_response`, never a defaulted probability (a 0 would quietly allow).
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
