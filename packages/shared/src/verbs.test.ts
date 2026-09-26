import { describe, expect, test } from 'bun:test';
import { EFFORT_LEVELS, EffortSchema, validateEffort } from './effort';
import { ulid } from './ids';
import { SessionRefSchema } from './stream';
import {
  AGENT_VERBS,
  AGENT_VERB_DESCRIPTIONS,
  AGENT_VERB_SCHEMAS,
  isAgentVerb,
  validateVerbInput,
} from './verbs';

const session = ulid();

describe('effort', () => {
  test('is the closed D12 enum', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'max']);
    expect(EffortSchema.safeParse('extreme').success).toBe(false);
    expect(validateEffort('max')).toBe('max');
  });

  test('SessionRef carries it, optionally, and stays strict', () => {
    const base = {
      id: session,
      vendor: 'claude',
      model: 'default',
      role: 'worker',
      status: 'running',
    };
    expect(SessionRefSchema.safeParse(base).success).toBe(true);
    expect(SessionRefSchema.safeParse({ ...base, effort: 'high' }).success).toBe(true);
    expect(SessionRefSchema.safeParse({ ...base, effort: 'huge' }).success).toBe(false);
    expect(SessionRefSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('agent verbs', () => {
  test('are the eight of cockpit design §4.1 plus read_event (projects-design §15) and deliver (§4.1)', () => {
    expect([...AGENT_VERBS]).toEqual([
      'ask',
      'progress',
      'finding',
      'propose_rule',
      'propose_next',
      'read_stream',
      'search_docs',
      'test_run',
      'read_event',
      'deliver',
    ]);
    for (const verb of AGENT_VERBS) {
      expect(AGENT_VERB_SCHEMAS[verb]).toBeDefined();
      expect(AGENT_VERB_DESCRIPTIONS[verb].length).toBeGreaterThan(0);
    }
    expect(isAgentVerb('board_post')).toBe(false);
  });

  test('every verb requires a session ulid', () => {
    for (const verb of AGENT_VERBS) {
      expect(AGENT_VERB_SCHEMAS[verb].safeParse({}).success).toBe(false);
      expect(() => validateVerbInput(verb, { session: 'nope' })).toThrow(verb);
    }
  });

  test('validate real inputs and refuse unknown keys', () => {
    expect(validateVerbInput('ask', { session, text: 'which target branch?' }).text).toBe(
      'which target branch?',
    );
    expect(
      validateVerbInput('finding', { session, severity: 'major', file: 'a.ts', line: 3, text: 'x' })
        .severity,
    ).toBe('major');
    expect(validateVerbInput('read_stream', { session }).limit).toBeUndefined();
    expect(validateVerbInput('test_run', { session, command: 'bun test' }).command).toBe(
      'bun test',
    );
    expect(() => validateVerbInput('progress', { session, text: 'x', ticket: 'TKT-1' })).toThrow();
    expect(() =>
      validateVerbInput('finding', { session, severity: 'huge', file: 'a', text: 'x' }),
    ).toThrow();
  });

  test('bodies are capped at the thread body cap', () => {
    expect(() => validateVerbInput('progress', { session, text: 'x'.repeat(801) })).toThrow();
  });
});
