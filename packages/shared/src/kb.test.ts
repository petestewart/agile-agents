import { describe, expect, test } from 'bun:test';
import { validateKbIndex } from './kb';

describe('KbIndex — §4 "Knowledge store" index.yaml', () => {
  test('accepts the init-time empty object', () => {
    expect(validateKbIndex({})).toEqual({});
  });

  test('accepts a map keyed by id with kind/scope/confidence/expires', () => {
    const index = validateKbIndex({
      'KB-0117': {
        kind: 'gotcha',
        scope: ['packages/api'],
        confidence: 'observed',
        expires: null,
      },
    });
    expect(index['KB-0117']).toEqual({
      kind: 'gotcha',
      scope: ['packages/api'],
      confidence: 'observed',
      expires: null,
    });
  });

  test('rejects an unknown key (strict entry schema, no title/source field)', () => {
    expect(() =>
      validateKbIndex({
        'KB-0117': {
          kind: 'env',
          scope: ['x'],
          confidence: 'observed',
          expires: null,
          title: 'not a KbFact field',
        },
      }),
    ).toThrow(/invalid KbIndex/);
  });

  test('rejects a malformed id key', () => {
    expect(() =>
      validateKbIndex({
        'not-an-id': { kind: 'env', scope: ['x'], confidence: 'observed', expires: null },
      }),
    ).toThrow(/invalid KbIndex/);
  });

  test('requires expires to be present (null or a date string, never absent)', () => {
    expect(() =>
      validateKbIndex({
        'KB-0117': { kind: 'env', scope: ['x'], confidence: 'observed' },
      }),
    ).toThrow(/invalid KbIndex/);
  });
});
