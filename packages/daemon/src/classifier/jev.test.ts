/**
 * The Jev adapter. There is no network here (§6.2): every test injects a
 * `fetch`, and the one test that pins the real wire shape compares against
 * the recorded fixtures under `__fixtures__/`, taken from the public HTTP
 * API reference at https://docs.typesafe.ai/api.
 */

import { describe, expect, test } from 'bun:test';
import { type ClassifierConfig, validateClassifierConfig } from '@agile-agents/shared';
import rawRecordedRequest from './__fixtures__/jev-request.json' with { type: 'json' };
import recordedResponse from './__fixtures__/jev-response.json' with { type: 'json' };
import { JevClassifier } from './jev';
import {
  JEV_CRITERIA_FIELD,
  JEV_MODEL,
  buildJevRequest,
  jevEndpoint,
  parseJevResponse,
} from './jev-wire';
import type { JevRequest } from './jev-wire';
import { ClassifierUnavailableError, type Noul } from './types';

/** The JSON import widens `type: "noul"` to `string`; the fixture *is* a request. */
const recordedRequest = rawRecordedRequest as JevRequest;

const QUESTIONS: Noul[] = [
  { id: 'RULE-NO-NEW-DEPS', question: 'Does this action add a new dependency?' },
  {
    id: 'RULE-NO-MIGRATIONS',
    question: "Does this action violate: don't touch the migration files?",
  },
];

function config(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return validateClassifierConfig({ api_key: 'test-key', ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('the recorded wire shape', () => {
  test('the request builder reproduces the recorded request', () => {
    const built = buildJevRequest(recordedRequest.state, QUESTIONS);
    expect(built).toEqual(recordedRequest);
    expect(built.model).toBe(JEV_MODEL);
  });

  test('the response parser reads the recorded response', () => {
    expect(parseJevResponse(recordedResponse, QUESTIONS)).toEqual([
      { id: 'RULE-NO-NEW-DEPS', probability: 0.95 },
      { id: 'RULE-NO-MIGRATIONS', probability: 0.12 },
    ]);
  });

  test('the endpoint is the documented path under the configured base', () => {
    expect(jevEndpoint('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpoint('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone');
  });

  test('an answer is the raw Noul value only; a stray confidence field is ignored (D14)', () => {
    const body = { answers: { a: { type: 'noul', noul: 0.9, confidence: 0.2 } } };
    expect(parseJevResponse(body, [{ id: 'a', question: 'q?' }])).toEqual([
      { id: 'a', probability: 0.9 },
    ]);
  });

  test("a rule's criteria ride on its Noul question (T156; field name unverified live)", () => {
    const criteria = { true: 'the rule is broken', false: 'the rule holds' };
    const request = buildJevRequest('state', [
      { id: 'a', question: 'Is it broken?', criteria },
      { id: 'b', question: 'Plain?' },
    ]);
    expect(request.questions.a).toEqual({
      type: 'noul',
      instructions: 'Is it broken?',
      [JEV_CRITERIA_FIELD]: criteria,
    });
    expect(request.questions.b).toEqual({ type: 'noul', instructions: 'Plain?' });
  });

  test('a duplicate question id is refused rather than silently collapsed', () => {
    expect(() => buildJevRequest('state', [QUESTIONS[0] as Noul, QUESTIONS[0] as Noul])).toThrow(
      ClassifierUnavailableError,
    );
  });

  test('a missing or non-numeric answer is a bad_response, never a defaulted probability', () => {
    expect(() => parseJevResponse({ answers: {} }, QUESTIONS)).toThrow(/no answer for/);
    expect(() => parseJevResponse({}, QUESTIONS)).toThrow(/no "answers" object/);
    expect(() =>
      parseJevResponse({ answers: { a: { type: 'noul', noul: 'high' } } }, [
        { id: 'a', question: 'q?' },
      ]),
    ).toThrow(/numeric "noul"/);
  });
});

describe('JevClassifier.ask', () => {
  test('posts the documented request and maps the answers back', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    const answers = await classifier.ask(recordedRequest.state, QUESTIONS);
    expect(answers.map((a) => a.id)).toEqual(['RULE-NO-NEW-DEPS', 'RULE-NO-MIGRATIONS']);
    expect(answers[0]?.probability).toBe(0.95);
    expect(seen?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen?.init.method).toBe('POST');
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(seen?.init.body))).toEqual(recordedRequest);
  });

  test('one call carries every question (§6.2, not one round trip per rule)', async () => {
    let calls = 0;
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async () => {
        calls += 1;
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    await classifier.ask('state', QUESTIONS);
    expect(calls).toBe(1);
  });

  test('scrubs the state before sending it', async () => {
    let sent = '';
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)).state;
        return jsonResponse({ answers: { a: { type: 'noul', noul: 0.1 } } });
      }) as unknown as typeof globalThis.fetch,
    });
    await classifier.ask('AWS_SECRET_KEY=AKIAIOSFODNN7EXAMPLE', [{ id: 'a', question: 'q?' }]);
    expect(sent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(sent).toContain('[REDACTED]');
  });

  test('a scrub that throws sends nothing at all (§6.5, fail-closed)', async () => {
    let called = false;
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      scrub: () => {
        throw new Error('pattern blew up');
      },
      fetch: (async () => {
        called = true;
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    const error = (await classifier.ask('state', QUESTIONS).catch((e) => e)) as unknown;
    expect(error).toBeInstanceOf(ClassifierUnavailableError);
    expect((error as ClassifierUnavailableError).reason).toBe('scrub_failed');
    expect(called).toBe(false);
  });

  test('times out at the configured timeout and never hangs the gate', async () => {
    const classifier = new JevClassifier({
      config: config({ timeout_ms: 10 }),
      env: {},
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch,
    });
    const error = (await classifier.ask('state', QUESTIONS).catch((e) => e)) as unknown;
    expect(error).toBeInstanceOf(ClassifierUnavailableError);
    expect((error as ClassifierUnavailableError).reason).toBe('timeout');
  });

  test('a missing key is "not configured" and never becomes a call', async () => {
    let called = false;
    const classifier = new JevClassifier({
      config: validateClassifierConfig({}),
      env: {},
      fetch: (async () => {
        called = true;
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(classifier.configured).toBe(false);
    const error = (await classifier.ask('state', QUESTIONS).catch((e) => e)) as unknown;
    expect((error as ClassifierUnavailableError).reason).toBe('not_configured');
    expect(called).toBe(false);
  });

  test('the key falls back to TYPESAFE_API_KEY when the config names none', async () => {
    let auth = '';
    const classifier = new JevClassifier({
      config: validateClassifierConfig({}),
      env: { TYPESAFE_API_KEY: 'env-key' },
      fetch: (async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).Authorization ?? '';
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(classifier.configured).toBe(true);
    await classifier.ask('state', QUESTIONS);
    expect(auth).toBe('Bearer env-key');
  });

  test('provider "off" is not configured and never calls', async () => {
    let called = false;
    const classifier = new JevClassifier({
      config: validateClassifierConfig({ provider: 'off', api_key: 'k' }),
      env: {},
      fetch: (async () => {
        called = true;
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(classifier.configured).toBe(false);
    await expect(classifier.ask('state', QUESTIONS)).rejects.toThrow(ClassifierUnavailableError);
    expect(called).toBe(false);
  });

  test('zero questions is zero calls', async () => {
    let called = false;
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async () => {
        called = true;
        return jsonResponse(recordedResponse);
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await classifier.ask('state', [])).toEqual([]);
    expect(called).toBe(false);
  });

  test('an HTTP error is unavailable, not an answer', async () => {
    const classifier = new JevClassifier({
      config: config(),
      env: {},
      fetch: (async () =>
        jsonResponse({ error: 'nope' }, 429)) as unknown as typeof globalThis.fetch,
    });
    const error = (await classifier.ask('state', QUESTIONS).catch((e) => e)) as unknown;
    expect((error as ClassifierUnavailableError).reason).toBe('http_error');
    expect((error as Error).message).toContain('429');
  });

  test('onCall reports latency for a success and for a failure (§6.2)', async () => {
    const seen: { latency_ms: number; ok: boolean; questions: number }[] = [];
    let clock = 1000;
    const ok = new JevClassifier({
      config: config(),
      env: {},
      now: () => {
        clock += 7;
        return clock;
      },
      onCall: (info) => seen.push(info),
      fetch: (async () => jsonResponse(recordedResponse)) as unknown as typeof globalThis.fetch,
    });
    await ok.ask('state', QUESTIONS);
    expect(seen[0]).toMatchObject({ ok: true, questions: 2 });
    expect(seen[0]?.latency_ms).toBeGreaterThan(0);

    const bad = new JevClassifier({
      config: validateClassifierConfig({}),
      env: {},
      onCall: (info) => seen.push(info),
    });
    await bad.ask('state', QUESTIONS).catch(() => undefined);
    expect(seen[1]?.ok).toBe(false);
  });
});
