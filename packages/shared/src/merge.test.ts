import { describe, expect, test } from 'bun:test';
import { validateMergeRecord } from './merge';

describe('MergeRecord schema', () => {
  test('accepts a minimal merged record', () => {
    expect(() =>
      validateMergeRecord({
        ticket: 'TKT-0231',
        status: 'merged',
        at: '2026-09-09T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  test('accepts a merged record with mergeCommit and worktreeKept/keepReason', () => {
    const record = validateMergeRecord({
      ticket: 'TKT-0231',
      status: 'merged',
      at: '2026-09-09T00:00:00.000Z',
      mergeCommit: 'abc123',
      worktreeKept: true,
      keepReason: 'stale',
    });
    expect(record.keepReason).toBe('stale');
  });

  test('accepts a conflict record with summary and haltId', () => {
    expect(() =>
      validateMergeRecord({
        ticket: 'TKT-0231',
        status: 'conflict',
        at: '2026-09-09T00:00:00.000Z',
        summary: 'rebase conflict onto integration: shared.txt',
        haltId: 'H-1',
      }),
    ).not.toThrow();
  });

  test('rejects an unknown status', () => {
    expect(() =>
      validateMergeRecord({
        ticket: 'TKT-0231',
        status: 'nope',
        at: '2026-09-09T00:00:00.000Z',
      }),
    ).toThrow();
  });

  test('rejects an unknown keepReason', () => {
    expect(() =>
      validateMergeRecord({
        ticket: 'TKT-0231',
        status: 'merged',
        at: '2026-09-09T00:00:00.000Z',
        keepReason: 'orphaned',
      }),
    ).toThrow();
  });

  test('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      validateMergeRecord({
        ticket: 'TKT-0231',
        status: 'merged',
        at: '2026-09-09T00:00:00.000Z',
        extra: true,
      }),
    ).toThrow();
  });

  test('rejects a malformed ticket id or timestamp', () => {
    expect(() =>
      validateMergeRecord({ ticket: 'nope', status: 'merged', at: '2026-09-09T00:00:00.000Z' }),
    ).toThrow();
    expect(() =>
      validateMergeRecord({ ticket: 'TKT-0231', status: 'merged', at: 'not-a-date' }),
    ).toThrow();
  });
});
