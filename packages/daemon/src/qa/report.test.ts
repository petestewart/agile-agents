import { describe, expect, test } from 'bun:test';
import { validateTicket } from '@agile-agents/shared';
import { buildQaReport, qaAllSkipped, renderQaVerdictBody } from './report';
import type { QaCriterionResult } from './rerun';

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

  test('a partial skip alongside an actually-executed pass does not force a reject', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', command: 'bun test a', status: 'pass', evidence: 'ok' },
      { criterion: 'b', status: 'skipped', evidence: 'no command' },
    ];
    const report = buildQaReport(makeTicket(['a', 'b']), 1, results);
    expect(report.verdict).toBe('accept');
    expect(qaAllSkipped(report)).toBe(false);
  });

  test('round-2 review fix (B1): every line skipped — nothing executed — forces a reject, not an accept', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', status: 'skipped', evidence: 'no command' },
      { criterion: 'b', status: 'skipped', evidence: 'command denied: not allow-listed' },
    ];
    const report = buildQaReport(makeTicket(['a', 'b']), 1, results);
    expect(report.verdict).toBe('reject');
    expect(qaAllSkipped(report)).toBe(true);
  });

  test('a single-criterion all-skipped report also rejects (the smallest reproduction of B1)', () => {
    const results: QaCriterionResult[] = [
      { criterion: 'a', status: 'skipped', evidence: 'no command' },
    ];
    const report = buildQaReport(makeTicket(['a']), 1, results);
    expect(report.verdict).toBe('reject');
    expect(qaAllSkipped(report)).toBe(true);
  });
});

describe('qaAllSkipped', () => {
  test('false when at least one line executed (pass/flaky/fail)', () => {
    expect(
      qaAllSkipped(
        buildQaReport(makeTicket(['a', 'b']), 1, [
          { criterion: 'a', status: 'fail', command: 'x', evidence: 'e' },
          { criterion: 'b', status: 'skipped', evidence: 'e' },
        ]),
      ),
    ).toBe(false);
  });

  test('true only when every line is skipped', () => {
    expect(
      qaAllSkipped(
        buildQaReport(makeTicket(['a']), 1, [{ criterion: 'a', status: 'skipped', evidence: 'e' }]),
      ),
    ).toBe(true);
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
    const criteria = Array.from(
      { length: 50 },
      (_, i) => `criterion number ${i} is fairly verbose`,
    );
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
