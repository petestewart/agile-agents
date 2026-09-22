import { describe, expect, test } from 'bun:test';
import { FakeClassifier } from './fake';
import type { Answer } from './types';

const ANSWERS: Answer[] = [{ id: 'RULE-1', probability: 0.9, confidence: 0.8 }];

describe('FakeClassifier', () => {
  test('returns the scripted answers and records the call', async () => {
    const fake = new FakeClassifier(ANSWERS);
    expect(await fake.ask('state', [{ id: 'RULE-1', question: 'q?' }])).toEqual(ANSWERS);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.state).toBe('state');
    expect(fake.calls[0]?.questions).toEqual([{ id: 'RULE-1', question: 'q?' }]);
  });

  test('scripts per question with a function', async () => {
    const fake = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({
        id: q.id,
        probability: q.id === 'deny' ? 0.95 : 0.1,
        confidence: 0.9,
      })),
    );
    const answers = await fake.ask('s', [
      { id: 'deny', question: 'a?' },
      { id: 'allow', question: 'b?' },
    ]);
    expect(answers.map((a) => a.probability)).toEqual([0.95, 0.1]);
  });

  test('throws when scripted to, and still records the call', async () => {
    const fake = new FakeClassifier([], { throws: new Error('boom') });
    await expect(fake.ask('s', [])).rejects.toThrow('boom');
    expect(fake.calls).toHaveLength(1);
  });

  test('delays when scripted to, and reports latency through onCall', async () => {
    const seen: number[] = [];
    const fake = new FakeClassifier(ANSWERS, {
      delayMs: 12,
      onCall: (info) => seen.push(info.latency_ms),
    });
    await fake.ask('s', [{ id: 'RULE-1', question: 'q?' }]);
    expect(seen[0]).toBeGreaterThanOrEqual(10);
  });

  test('re-scripts between rounds', async () => {
    const fake = new FakeClassifier(ANSWERS);
    fake.setScript([{ id: 'RULE-1', probability: 0.1, confidence: 0.9 }]);
    const answers = await fake.ask('s', [{ id: 'RULE-1', question: 'q?' }]);
    expect(answers[0]?.probability).toBe(0.1);
    expect(fake.calls).toHaveLength(1);
  });
});
