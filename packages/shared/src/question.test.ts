import { describe, expect, test } from 'bun:test';
import { EVENT_KINDS } from './event';
import { ulid } from './ids';
import { type Question, QuestionSchema, validateQuestion } from './question';

function open(overrides: Partial<Question> = {}): unknown {
  return {
    id: `Q-${ulid()}`,
    raised_by: 'eng-1',
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
        resolved_as: 'DEC-0042',
        answered_by: 'human',
        answered_at: new Date().toISOString(),
      } as Partial<Question>),
    );
    expect(answered.resolved_as).toBe('DEC-0042');
  });

  test('resolved_as takes a decision id, a ticket id, or the literal "reply"', () => {
    for (const value of ['reply', 'DEC-0042', 'TKT-0231']) {
      expect(
        QuestionSchema.safeParse(
          open({
            status: 'answered',
            answer: 'answered',
            resolved_as: value,
          } as Partial<Question>),
        ).success,
      ).toBe(true);
    }
    expect(
      QuestionSchema.safeParse(
        open({ status: 'answered', answer: 'a', resolved_as: 'KB-0117' } as Partial<Question>),
      ).success,
    ).toBe(false);
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
