import { describe, expect, test } from 'bun:test';
import { validateTicket } from '@agile-agents/shared';
import type { QaCriterionResult } from './rerun';
import { buildQaReport, renderQaVerdictBody } from './report';

function makeTicket(acceptance: string[]) {
  return validateTicket({
    id: 'TKT-0001',
    title: 'Fixture',
    status: 'in_qa',
    contract: { acceptance },
    history: [],
  });
}

describe('buildQaReport', () => {
  test('accept when every line passes (flaky counts as a pass-with-caveat)', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', command: 'bun test a', status: 'pass', evidence: 'ok' },
      { criterion: 'b', command: 'bun test b', status: 'flaky', evidence: 'flaked then passed' },
    ];
    const report = buildQaReport(makeTicket(['a', 'b']), 1, results);
    expect(report.verdict).toBe('accept');
    expect(report.lines).toHaveLength(2);
  });

  test('one line per criterion — count matches contract.acceptance', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', command: 'bun test a', status: 'pass', evidence: 'ok' },
      { criterion: 'b', status: 'skipped', evidence: 'no command' },
      { criterion: 'c', command: 'bun test c', status: 'fail', evidence: 'observed x expected y' },
    ];
    const report = buildQaReport(makeTicket(['a', 'b', 'c']), 1, results);
    expect(report.lines).toHaveLength(3);
    expect(report.lines.map((l) => l.criterion)).toEqual(['a', 'b', 'c']);
  });

  test('reject when any line fails', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', command: 'bun test a', status: 'pass', evidence: 'ok' },
      { criterion: 'b', command: 'bun test b', status: 'fail', evidence: 'observed x expected y' },
    ];
    const report = buildQaReport(makeTicket(['a', 'b']), 1, results);
    expect(report.verdict).toBe('reject');
  });

  test('skipped alone (no fails) does not force a reject', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', status: 'skipped', evidence: 'no command' },
    ];
    const report = buildQaReport(makeTicket(['a']), 1, results);
    expect(report.verdict).toBe('accept');
  });
});

describe('renderQaVerdictBody', () => {
  test('one line per criterion, under the 800-char cap, when it fits', () => {
    const report = buildQaReport(makeTicket(['a', 'b']), 1, [
      { criterion: 'a', command: 'bun test a', status: 'pass', evidence: 'ok' },
      { criterion: 'b', command: 'bun test b', status: 'fail', evidence: 'observed x expected y' },
    ]);
    const body = renderQaVerdictBody(report, 'board/qa/TKT-0001-r1.yaml');
    expect(body.length).toBeLessThanOrEqual(800);
    expect(body).toContain('PASS: a — ok');
    expect(body).toContain('FAIL: b — observed x expected y');
    expect(body).toContain('board/qa/TKT-0001-r1.yaml');
  });

  test('truncates with a pointer when many criteria would exceed the cap', () => {
    const criteria = Array.from({ length: 50 }, (_, i) => `criterion number ${i} is fairly verbose`);
    const results: QaCriterionResult[] = criteria.map((c, i) => ({
      criterion: c,
      command: `bun test ${i}`,
      status: 'pass' as const,
      evidence: 'a reasonably long evidence string describing the passing run in some detail',
    }));
    const report = buildQaReport(makeTicket(criteria), 1, results);
    const body = renderQaVerdictBody(report, 'board/qa/TKT-0001-r1.yaml');
    expect(body.length).toBeLessThanOrEqual(800);
    expect(body).toContain('truncated');
    expect(body).toContain('50 criteria total');
  });
});
