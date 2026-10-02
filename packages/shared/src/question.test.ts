import { describe, expect, test } from 'bun:test';
import { EVENT_KINDS } from './event';
import { ulid } from './ids';
import {
  type Question,
  QuestionSchema,
  QuestionThreadSchema,
  questionIdOfThreadRef,
  validateQuestion,
} from './question';

function open(overrides: Partial<Question> = {}): unknown {
  return {
    id: `Q-${ulid()}`,
    stream: ulid(),
    raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
    text: 'this ticket contradicts SPEC-auth-003 — which wins?',
    status: 'open',
    raised_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('QuestionSchema', () => {
  test('accepts a minimal open question', () => {
    const q = validateQuestion(open());
    expect(q.status).toBe('open');
    expect(q.answer).toBeUndefined();
  });

  test('rejects a non-ulid id', () => {
    expect(() => validateQuestion(open({ id: 'Q-1' } as Partial<Question>))).toThrow(
      /must look like Q-<ulid>/,
    );
  });

  test('is strict — an unknown key is rejected', () => {
    expect(() => validateQuestion({ ...(open() as object), urgency: 'high' })).toThrow(
      /invalid Question/,
    );
  });

  test('an open question may not carry an answer or resolved_as', () => {
    expect(() => validateQuestion(open({ answer: 'the spec wins' } as Partial<Question>))).toThrow(
      /must not carry "answer"/,
    );
    expect(() => validateQuestion(open({ resolved_as: 'reply' } as Partial<Question>))).toThrow(
      /must not carry "resolved_as"/,
    );
  });

  test('an answered question must carry both answer and resolved_as', () => {
    expect(() => validateQuestion(open({ status: 'answered' } as Partial<Question>))).toThrow(
      /must carry "answer"/,
    );
    const answered = validateQuestion(
      open({
        status: 'answered',
        answer: 'the spec wins; refine the ticket',
        resolved_as: 'reply',
        answered_by: 'human',
        answered_at: new Date().toISOString(),
      } as Partial<Question>),
    );
    expect(answered.resolved_as).toBe('reply');
  });

  // T121: `resolved_as` shrank to the single literal `reply` — the decision
  // and ticket-edit resolutions went with the oracle and the ticket model.
  test('resolved_as takes only the literal "reply"', () => {
    expect(
      QuestionSchema.safeParse(
        open({ status: 'answered', answer: 'a', resolved_as: 'reply' } as Partial<Question>),
      ).success,
    ).toBe(true);
    for (const value of ['DEC-0042', 'TKT-0231', 'KB-0117']) {
      expect(
        QuestionSchema.safeParse({
          ...(open({ status: 'answered', answer: 'a' }) as object),
          resolved_as: value,
        }).success,
      ).toBe(false);
    }
  });

  test('T502: settled is a resolution; superseded_by only on an answered question', () => {
    const answered = (extra: Partial<Question>) =>
      QuestionSchema.safeParse(
        open({ status: 'answered', answer: 'cents', ...extra } as Partial<Question>),
      ).success;
    expect(answered({ resolved_as: 'settled', answered_by: `agent:${ulid()}` })).toBe(true);
    const newer = `Q-${ulid()}`;
    expect(answered({ resolved_as: 'superseded', superseded_by: newer })).toBe(true);
    expect(answered({ resolved_as: 'superseded', superseded_by: 'Q-1' })).toBe(false);
    expect(() => validateQuestion(open({ superseded_by: newer } as Partial<Question>))).toThrow(
      /must not carry "superseded_by"/,
    );
  });

  test('T502: a question thread is strict, and a line ref names its question', () => {
    const id = `Q-${ulid()}`;
    const thread = {
      question: id,
      earlier: [],
      stream: ulid(),
      text: 'Store amounts how?',
      options: ['Integer cents', 'Floats'],
      state: 'waiting_on_agent',
      vendor: 'codex',
      replies: 1,
      entries: [new Date().toISOString()],
      raised_at: new Date().toISOString(),
    };
    expect(QuestionThreadSchema.safeParse(thread).success).toBe(true);
    expect(QuestionThreadSchema.safeParse({ ...thread, state: 'pending' }).success).toBe(false);
    expect(QuestionThreadSchema.safeParse({ ...thread, extra: 1 }).success).toBe(false);
    expect(questionIdOfThreadRef(`questions/${id}.yaml`)).toBe(id);
    expect(questionIdOfThreadRef(`gates/${id}.yaml`)).toBeUndefined();
    expect(questionIdOfThreadRef(undefined)).toBeUndefined();
  });

  test('stream is required and must be a ULID', () => {
    const { stream: _stream, ...noStream } = open() as Record<string, unknown>;
    expect(QuestionSchema.safeParse(noStream).success).toBe(false);
    expect(QuestionSchema.safeParse(open({ stream: 'TKT-0231' })).success).toBe(false);
  });

  test('options, when present, must be a non-empty array of non-empty strings', () => {
    expect(validateQuestion(open({ options: ['a', 'b'] } as Partial<Question>)).options).toEqual([
      'a',
      'b',
    ]);
    expect(QuestionSchema.safeParse(open({ options: [] } as Partial<Question>)).success).toBe(
      false,
    );
  });

  test('text is capped at the shared 800-char message body cap', () => {
    expect(QuestionSchema.safeParse(open({ text: 'x'.repeat(801) })).success).toBe(false);
    expect(QuestionSchema.safeParse(open({ text: '' })).success).toBe(false);
  });
});

describe('event kinds', () => {
  test('question_raised / question_answered are registered kinds', () => {
    expect(EVENT_KINDS).toContain('question_raised');
    expect(EVENT_KINDS).toContain('question_answered');
  });
});
