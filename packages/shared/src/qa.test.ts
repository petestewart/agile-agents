import { describe, expect, test } from 'bun:test';
import { QaReportSchema, qaReportRelPath, validateQaReport } from './qa';

function line(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    criterion: 'POST /login returns 200',
    command: 'bun test auth.test.ts',
    status: 'pass',
    evidence: 'exit 0',
    ...overrides,
  };
}

describe('QaReportSchema', () => {
  test('accepts a well-formed accept report', () => {
    const report = validateQaReport({
      ticket: 'TKT-0231',
      round: 1,
      lines: [line()],
      verdict: 'accept',
    });
    expect(report.verdict).toBe('accept');
    expect(report.lines).toHaveLength(1);
  });

  test('accepts flaky/skipped statuses', () => {
    const report = validateQaReport({
      ticket: 'TKT-0231',
      round: 2,
      lines: [
        line({ status: 'flaky', evidence: 'failed then passed on rerun' }),
        line({ status: 'skipped', command: undefined, evidence: 'no command supplied' }),
      ],
      verdict: 'reject',
    });
    expect(report.lines.map((l) => l.status)).toEqual(['flaky', 'skipped']);
  });

  test('rejects an unknown status', () => {
    const result = QaReportSchema.safeParse({
      ticket: 'TKT-0231',
      round: 1,
      lines: [line({ status: 'maybe' })],
      verdict: 'accept',
    });
    expect(result.success).toBe(false);
  });

  test('rejects an empty lines array', () => {
    const result = QaReportSchema.safeParse({
      ticket: 'TKT-0231',
      round: 1,
      lines: [],
      verdict: 'accept',
    });
    expect(result.success).toBe(false);
  });

  test('rejects evidence over the char cap', () => {
    const result = QaReportSchema.safeParse({
      ticket: 'TKT-0231',
      round: 1,
      lines: [line({ evidence: 'x'.repeat(201) })],
      verdict: 'accept',
    });
    expect(result.success).toBe(false);
  });

  test('rejects an unknown top-level field (strict)', () => {
    const result = QaReportSchema.safeParse({
      ticket: 'TKT-0231',
      round: 1,
      lines: [line()],
      verdict: 'accept',
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  test('qaReportRelPath matches the board/qa/<ticket>-r<round>.yaml convention', () => {
    expect(qaReportRelPath('TKT-0231', 3)).toBe('board/qa/TKT-0231-r3.yaml');
  });
});
