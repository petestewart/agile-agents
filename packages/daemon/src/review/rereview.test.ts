import { describe, expect, test } from 'bun:test';
import type { Finding } from '@agile-agents/shared';
import type { DiffHunk } from './diff-summary';
import { validateReReview } from './rereview';

function hunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return { path: 'src/a.ts', newStart: 10, newEnd: 20, hash: 'hash-1', ...overrides };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'major',
    rule: 'RULE-001',
    location: { path: 'src/a.ts', line: 15 },
    message: 'bad',
    ...overrides,
  };
}

describe('validateReReview', () => {
  test('allows a finding never raised before, in code round 1 never touched', () => {
    const result = validateReReview([], [finding()], [], []);
    expect(result.rejected).toEqual([]);
    expect(result.allowed).toEqual([finding()]);
  });

  test('rejects a new finding whose location was visible in round 1 and unchanged since', () => {
    const diffThen = [hunk()];
    const diffNow = [hunk()]; // same hash — code at that location never changed
    const result = validateReReview([[]], [finding()], diffThen, diffNow);
    expect(result.allowed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/visible in round 1/);
  });

  test('allows a new finding at a location that changed since round 1', () => {
    const diffThen = [hunk({ hash: 'hash-1' })];
    const diffNow = [hunk({ hash: 'hash-2' })]; // engineer touched this range again
    const result = validateReReview([[]], [finding()], diffThen, diffNow);
    expect(result.allowed).toEqual([finding()]);
    expect(result.rejected).toEqual([]);
  });

  test('allows a finding that was already raised in a previous round (not "new")', () => {
    const diffThen = [hunk()];
    const previousRounds = [[finding({ message: 'first time' })]];
    const result = validateReReview(
      previousRounds,
      [finding({ message: 'restated' })],
      diffThen,
      diffThen,
    );
    expect(result.allowed).toEqual([finding({ message: 'restated' })]);
    expect(result.rejected).toEqual([]);
  });

  test('allows a file-scoped finding with no line number', () => {
    const f = finding({ location: { path: 'src/a.ts' } });
    const result = validateReReview([[]], [f], [hunk()], [hunk()]);
    expect(result.allowed).toEqual([f]);
  });

  test('allows a finding at a location outside any round-1 hunk', () => {
    const outside = finding({ location: { path: 'src/a.ts', line: 999 } });
    const result = validateReReview([[]], [outside], [hunk()], [hunk()]);
    expect(result.allowed).toEqual([outside]);
  });
});
