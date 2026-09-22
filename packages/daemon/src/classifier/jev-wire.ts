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
 * **Inferred — invented here, not sourced:** `confidence` for a Noul. The
 * docs are explicit that "Noul answers don't carry one" — only Choice and
 * Score return a `confidence` field — but §6.3's bands need one. The docs
 * give no general formula either: the `/confidence` page shows
 * `(3 * peak - 1) / 2` inside a three-option interactive demo and never
 * addresses two outcomes. `noulConfidence` generalises that demo's
 * approximation to `n` outcomes as `(n * peak - 1) / (n - 1)` and
 * evaluates it at `n = 2` for a Noul's `{ yes: p, no: 1 - p }`, giving
 * `|2p - 1|`: 1.0 at a certain yes or no, 0.0 at a coin flip, on the same
 * 0–1 scale as the Choice and Score confidences the bands were written
 * against. That generalisation is this adapter's guess, algebraically
 * consistent with the one case the docs show and nothing more. If a later
 * Jev version returns a Noul `confidence`, `parseJevResponse` prefers it.
 *
 * Known consequence for T151/T153, who own the thresholds: with this
 * derivation `|2p - 1| >= 0.6` for every `p >= 0.80`, so a Noul-derived
 * DENY is never below the 0.50 confidence floor — the floor cannot do the
 * job §6.3's rationale names for it ("a probability of 0.9 with confidence
 * 0.2 is a shrug"). It does still fire on its own for `0.25 < p < 0.40`,
 * pulling some would-be ALLOWs into the inbox. Both effects are artefacts
 * of the derivation, not of the bands.
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

/** The inferred two-outcome confidence. See this module's header — not a documented formula. */
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
