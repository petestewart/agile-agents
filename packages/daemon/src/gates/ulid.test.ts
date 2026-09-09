import { describe, expect, test } from 'bun:test';
import { ULID_PATTERN } from '@agile-agents/shared';
import { generateUlid } from './ulid';

describe('generateUlid', () => {
  test('matches shared ULID_PATTERN', () => {
    expect(generateUlid()).toMatch(ULID_PATTERN);
  });

  test('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUlid()));
    expect(ids.size).toBe(1000);
  });

  test('is monotonic-ish: later timestamps sort no earlier lexicographically for the time prefix', () => {
    const a = generateUlid(1_700_000_000_000);
    const b = generateUlid(1_700_000_000_001);
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});
