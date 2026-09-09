import { describe, expect, test } from 'bun:test';
import { inputSpecFromToolIo, zodShapeFromInputSpec } from './schema';

describe('inputSpecFromToolIo', () => {
  test('maps the seeded read_summary/test_run shapes', () => {
    expect(inputSpecFromToolIo({ path: 'string', question: 'string?' })).toEqual({
      path: { type: 'string', optional: false },
      question: { type: 'string', optional: true },
    });
    expect(inputSpecFromToolIo({ command: 'string', cwd: 'string?' })).toEqual({
      command: { type: 'string', optional: false },
      cwd: { type: 'string', optional: true },
    });
  });

  test('accepts optionality on the key (§7 literal example: `question?: string`)', () => {
    expect(inputSpecFromToolIo({ 'question?': 'string' })).toEqual({
      question: { type: 'string', optional: true },
    });
  });

  test('maps number/boolean/array/object/unknown tokens', () => {
    expect(
      inputSpecFromToolIo({
        n: 'number',
        b: 'boolean',
        arr: '[{path, lines}]',
        obj: '{foo: bar}',
        other: 42,
      }),
    ).toEqual({
      n: { type: 'number', optional: false },
      b: { type: 'boolean', optional: false },
      arr: { type: 'array', optional: false },
      obj: { type: 'object', optional: false },
      other: { type: 'unknown', optional: false },
    });
  });
});

describe('zodShapeFromInputSpec', () => {
  test('required fields reject a missing value; optional fields accept undefined', () => {
    const shape = zodShapeFromInputSpec({
      path: { type: 'string', optional: false },
      question: { type: 'string', optional: true },
    });
    expect(shape.path?.safeParse(undefined).success).toBe(false);
    expect(shape.path?.safeParse('a.ts').success).toBe(true);
    expect(shape.question?.safeParse(undefined).success).toBe(true);
    expect(shape.question?.safeParse('why?').success).toBe(true);
  });
});
