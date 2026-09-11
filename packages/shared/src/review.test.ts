import { describe, expect, test } from 'bun:test';
import { FindingSchema, VerdictSchema, validateFinding, validateVerdict } from './review';

describe('FindingSchema', () => {
  test('accepts a rule-cited finding', () => {
    const finding = validateFinding({
      severity: 'blocker',
      rule: 'RULE-012',
      location: { path: 'src/x.ts', line: 10 },
      message: 'violates naming rule',
    });
    expect(finding.rule).toBe('RULE-012');
  });

  test('accepts an oracle_ref-cited finding', () => {
    const finding = validateFinding({
      severity: 'major',
      oracle_ref: 'DEC-0042',
      location: { path: 'src/x.ts' },
      message: 'violates DEC-0042',
    });
    expect(finding.oracle_ref).toBe('DEC-0042');
  });

  test('rejects a finding citing neither rule nor oracle_ref', () => {
    expect(() =>
      validateFinding({
        severity: 'minor',
        location: { path: 'src/x.ts' },
        message: 'no citation',
      }),
    ).toThrow(/exactly one/);
  });

  test('rejects a finding citing both rule and oracle_ref', () => {
    expect(() =>
      validateFinding({
        severity: 'minor',
        rule: 'RULE-012',
        oracle_ref: 'DEC-0042',
        location: { path: 'src/x.ts' },
        message: 'double citation',
      }),
    ).toThrow(/exactly one/);
  });

  test('rejects an unknown severity', () => {
    const result = FindingSchema.safeParse({
      severity: 'catastrophic',
      rule: 'RULE-012',
      location: { path: 'a.ts' },
      message: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('VerdictSchema', () => {
  test('approve with no findings is valid', () => {
    const v = validateVerdict({ ticket: 'TKT-0001', round: 1, verdict: 'approve' });
    expect(v.findings).toEqual([]);
    expect(v.pass).toBe('primary');
  });

  test('request_changes requires at least one finding', () => {
    expect(() =>
      validateVerdict({ ticket: 'TKT-0001', round: 1, verdict: 'request_changes', findings: [] }),
    ).toThrow(/at least one finding/);
  });

  test('request_changes with a finding is valid', () => {
    const v = validateVerdict({
      ticket: 'TKT-0001',
      round: 1,
      verdict: 'request_changes',
      findings: [
        {
          severity: 'blocker',
          rule: 'RULE-001',
          location: { path: 'src/a.ts', line: 3 },
          message: 'bad',
        },
      ],
    });
    expect(v.findings.length).toBe(1);
  });

  test('escalate is valid with no findings', () => {
    const v = validateVerdict({ ticket: 'TKT-0001', round: 2, verdict: 'escalate' });
    expect(v.verdict).toBe('escalate');
  });

  test('security pass is threaded through', () => {
    const v = validateVerdict({
      ticket: 'TKT-0001',
      round: 1,
      pass: 'security',
      verdict: 'approve',
    });
    expect(v.pass).toBe('security');
  });
});
