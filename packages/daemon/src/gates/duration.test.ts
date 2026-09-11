import { describe, expect, test } from 'bun:test';
import { InvalidDurationError, parseDurationMs } from './duration';

describe('parseDurationMs', () => {
  test.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
    ['500ms', 500],
    ['10s', 10_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  test('rejects a malformed duration', () => {
    expect(() => parseDurationMs('two hours')).toThrow(InvalidDurationError);
  });

  test('rejects an unknown unit', () => {
    expect(() => parseDurationMs('2y')).toThrow(InvalidDurationError);
  });
});
