/**
 * T483 (model-routing §5): Jev's choice primitive on the wire. No network.
 * `jev-choice-request.json`/`jev-choice-response.json` are the shape the
 * manager checked against the live API on 2026-09-30 (the rename's `model`
 * and `clarity` answers as seen; the `stakes` probabilities are filled in
 * around its seen choice and confidence). `jev-choice-live-response.json`
 * is one whole reply recorded from T483's live run. The adapter tests
 * inject `fetch`.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ChoiceQuestion,
  type ClassifierConfig,
  builtinModelPolicy,
  chooserQuestions,
  readChooserAnswers,
  validateClassifierConfig,
} from '@agile-agents/shared';
import liveResponse from './__fixtures__/jev-choice-live-response.json' with { type: 'json' };
import rawRequest from './__fixtures__/jev-choice-request.json' with { type: 'json' };
import recordedResponse from './__fixtures__/jev-choice-response.json' with { type: 'json' };
import { JevClassifier } from './jev';
import {
  JEV_MODEL,
  type JevChoiceRequest,
  buildJevChoiceRequest,
  parseJevChoiceResponse,
} from './jev-wire';
import { ClassifierUnavailableError } from './types';

const recordedRequest = rawRequest as JevChoiceRequest;

/** The recorded request's questions, as the classifier tier takes them. */
const QUESTIONS: ChoiceQuestion[] = Object.entries(recordedRequest.questions).map(([id, q]) => ({
  id,
  instructions: q.instructions,
  options: q.criteria,
}));

const STAKES: ChoiceQuestion = {
  id: 'stakes',
  instructions: 'What does a mistake cost?',
  options: { '1': 'undone', '3': 'moderate', '5': 'critical' },
};

function config(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return validateClassifierConfig({ api_key: 'test-key', ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifierUnavailableError);
    return (error as ClassifierUnavailableError).reason;
  }
  throw new Error('expected a ClassifierUnavailableError');
}

describe('the choice wire shape (T483)', () => {
  test('the request builder reproduces the recorded request', () => {
    const built = buildJevChoiceRequest(recordedRequest.state, QUESTIONS);
    expect(built).toEqual(recordedRequest);
    expect(built.model).toBe(JEV_MODEL);
  });

  test('the parser reads the recorded reply: a confident model, a clear score, an unsure stakes', () => {
    const answers = parseJevChoiceResponse(recordedResponse, [...QUESTIONS, STAKES]);
    expect(answers).toEqual([
      {
        id: 'clarity',
        choice: '5',
        confidence: 0.85,
        probabilities: { '1': 0, '3': 0.1, '5': 0.9 },
      },
      {
        id: 'model',
        choice: 'claude/claude-sonnet-5-5',
        confidence: 0.82,
        probabilities: {
          'claude/claude-sonnet-5-5': 0.88,
          'claude/claude-haiku-4-5': 0.12,
          'claude/claude-opus-5-5': 0,
        },
      },
      {
        id: 'stakes',
        choice: '3',
        confidence: 0.33,
        probabilities: { '1': 0.3, '3': 0.4, '5': 0.3 },
      },
    ]);
    // The unsure stakes still reads as a score: the weighted mean, 3.0.
    const reading = readChooserAnswers(
      [
        { id: 'topic', instructions: 't', options: { none: 'n', security: 's' } },
        {
          id: 'model',
          instructions: 'm',
          options: recordedRequest.questions.model?.criteria ?? {},
        },
      ],
      [
        { id: 'topic', choice: 'none', confidence: 1, probabilities: { none: 1 } },
        ...answers.filter((a) => a.id === 'model'),
      ],
    );
    expect(reading.model).toEqual({ key: 'claude/claude-sonnet-5-5', confidence: 0.82 });
  });

  test('a live reply (2026-09-30, the float-to-cents migration, three Claude presets) reads whole', () => {
    // Recorded from a real call (T483's live run): answers only, no request, no key.
    const questions = chooserQuestions({
      policy: builtinModelPolicy(),
      candidates: [
        { vendor: 'claude', model: 'claude-haiku-4-5' },
        { vendor: 'claude', model: 'claude-sonnet-5-5' },
        { vendor: 'claude', model: 'claude-opus-5-5' },
      ],
      profiles: {},
      need: 'full',
    });
    const reading = readChooserAnswers(questions, parseJevChoiceResponse(liveResponse, questions));
    expect(reading.topic).toBe('migration');
    expect(reading.model).toEqual({ key: 'claude/claude-opus-5-5', confidence: 0.77 });
    expect(reading.effort?.level).toBe('high');
    expect(reading.scores?.stakes).toBe(5);
    expect(reading.scores?.horizon).toBeGreaterThan(4);
  });

  test('a missing answer is a bad response, never defaulted', () => {
    const body = { answers: { clarity: recordedResponse.answers.clarity } };
    expect(() => parseJevChoiceResponse(body, QUESTIONS)).toThrow(/no answer for "model"/);
    try {
      parseJevChoiceResponse({ nothing: true }, QUESTIONS);
    } catch (error) {
      expect((error as ClassifierUnavailableError).reason).toBe('bad_response');
    }
  });

  test('a malformed answer is a bad response: no choice, a confidence past 1, a probability that is not a number', () => {
    const bad = [
      { type: 'choice', confidence: 0.5, probabilities: {} },
      { type: 'choice', choice: '5', confidence: 1.4, probabilities: {} },
      { type: 'choice', choice: '5', confidence: 0.5, probabilities: { '5': 'high' } },
      { type: 'noul', noul: 0.9 },
    ];
    for (const answer of bad) {
      expect(() => parseJevChoiceResponse({ answers: { stakes: answer } }, [STAKES])).toThrow(
        ClassifierUnavailableError,
      );
    }
  });

  test('a question with one option, or more than 255, is refused before anything is sent', () => {
    expect(() =>
      buildJevChoiceRequest('s', [{ id: 'x', instructions: 'q', options: { a: 'only' } }]),
    ).toThrow(/two options/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 256; i++) many[`o${i}`] = 'an option';
    expect(() =>
      buildJevChoiceRequest('s', [{ id: 'x', instructions: 'q', options: many }]),
    ).toThrow(/255/);
    expect(() => buildJevChoiceRequest('s', [STAKES, STAKES])).toThrow(/duplicate/);
  });
});

describe('JevClassifier.choose (T483)', () => {
  test('one POST with the key, the scrubbed state and every question; the reply read', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const calls: unknown[] = [];
    const jev = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return jsonResponse(recordedResponse);
      }) as unknown as typeof fetch,
      onCall: (info) => calls.push(info),
    });
    const answers = await jev.choose('token=sk-live-abcdefghijklmnop1234 rename it', QUESTIONS);
    expect(answers.map((a) => a.choice)).toEqual(['5', 'claude/claude-sonnet-5-5']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(sent[0]?.init.body)) as JevChoiceRequest;
    expect(Object.keys(body.questions)).toEqual(['clarity', 'model']);
    // The same scrubber as a rule check: the credential-shaped text never leaves.
    expect(body.state).not.toContain('sk-live-abcdefghijklmnop1234');
    expect(body.state).toContain('rename it');
    expect(body.questions.model?.type).toBe('choice');
    expect(calls).toEqual([expect.objectContaining({ ok: true, questions: 2 })]);
  });

  test('no key, a 429 and a timeout each throw the tier’s own reasons', async () => {
    const keyless = new JevClassifier({ config: validateClassifierConfig({}), env: {} });
    expect(await reason(keyless.choose('s', QUESTIONS))).toBe('not_configured');

    const limited = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async () => jsonResponse({ error: 'slow down' }, 429)) as unknown as typeof fetch,
    });
    expect(await reason(limited.choose('s', QUESTIONS))).toBe('http_error');

    const slow = new JevClassifier({
      config: config({ timeout_ms: 20 }),
      env: {},
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    expect(await reason(slow.choose('s', QUESTIONS))).toBe('timeout');
  });
});
