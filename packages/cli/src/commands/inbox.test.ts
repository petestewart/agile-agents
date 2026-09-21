/** T128: the inbox `age (ts)` cell — relative age plus the exact ISO time. */
import { describe, expect, test } from 'bun:test';
import { ageOf, ageWithTs } from './inbox';

const now = Date.parse('2026-01-01T12:00:00.000Z');

describe('ageWithTs (T128)', () => {
  test('pairs the coarse age with the ISO timestamp', () => {
    const ts = '2026-01-01T09:00:00.000Z';
    expect(ageOf(ts, now)).toBe('3h');
    expect(ageWithTs(ts, now)).toBe('3h (2026-01-01T09:00:00.000Z)');
  });

  test('keeps the placeholder age for an unparseable timestamp', () => {
    expect(ageWithTs('not-a-date', now)).toBe('- (not-a-date)');
  });
});
