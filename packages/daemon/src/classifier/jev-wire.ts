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
 * **Inferred, not from the docs:** `confidence` for a Noul. The docs are
 * explicit that "Noul answers don't carry one" — only Choice and Score
 * return a `confidence` field — but §6.3's bands need one, and the
 * confidence floor is the band that catches a shrug. A Noul is a
 * two-outcome distribution `{ yes: p, no: 1 - p }`, so we apply the docs'
 * own definition of confidence for a distribution of `n` outcomes,
 * `(n * peak - 1) / (n - 1)`, at `n = 2`: `|2p - 1|`. That is 1.0 at a
 * certain yes or no and 0.0 at a coin flip, on the same 0–1 scale as the
 * Choice and Score confidences the bands were written against. If a later
 * Jev version returns a Noul `confidence`, `parseJevResponse` prefers it.
 */

import { ClassifierUnavailableError } from './types';
import type { Answer, Noul } from './types';

/** The evaluation endpoint's path, appended to the configured base URL. */
export const JEV_ENDPOINT_PATH = '/v1/systemone';

/** The model alias the docs tell callers to use — TypeSafe's flagship. */
export const JEV_MODEL = 'jev-latest';

/** One entry of the request's `questions` map. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
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
    map[question.id] = { type: 'noul', instructions: question.question };
  }
  return { state, model, questions: map };
}

/** The docs' confidence definition at two outcomes. See this module's header. */
export function noulConfidence(probability: number): number {
  return Math.min(1, Math.max(0, Math.abs(2 * probability - 1)));
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
    const reported = raw.confidence;
    const confidence =
      typeof reported === 'number' && Number.isFinite(reported)
        ? reported
        : noulConfidence(probability);
    return { id: question.id, probability, confidence };
  });
}
