import { describe, expect, test } from 'bun:test';
import type { Finding } from '@agile-agents/shared';
import { findingKey, findingWasRaisedBefore, sameFinding } from './findings';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'major',
    rule: 'RULE-001',
    location: { path: 'src/a.ts', line: 10 },
    message: 'bad',
    ...overrides,
  };
}

describe('sameFinding', () => {
  test('same rule + location is the same finding, even with different message text', () => {
    const a = finding({ message: 'first wording' });
    const b = finding({ message: 'second wording' });
    expect(sameFinding(a, b)).toBe(true);
  });

  test('different location is a different finding', () => {
    const a = finding();
    const b = finding({ location: { path: 'src/a.ts', line: 11 } });
    expect(sameFinding(a, b)).toBe(false);
  });

  test('different rule/oracle_ref citation is a different finding', () => {
    const a = finding({ rule: 'RULE-001' });
    const b = finding({ rule: undefined, oracle_ref: 'DEC-0001' });
    expect(sameFinding(a, b)).toBe(false);
  });
});

describe('findingWasRaisedBefore', () => {
  test('true when a matching finding is in the list', () => {
    const a = finding();
    expect(findingWasRaisedBefore(a, [finding({ message: 'other words' })])).toBe(true);
  });

  test('false on an empty list', () => {
    expect(findingWasRaisedBefore(finding(), [])).toBe(false);
  });
});

describe('findingKey', () => {
  test('is stable across different message text', () => {
    expect(findingKey(finding({ message: 'a' }))).toBe(findingKey(finding({ message: 'b' })));
  });

  test('differs by location', () => {
    expect(findingKey(finding())).not.toBe(
      findingKey(finding({ location: { path: 'src/a.ts', line: 99 } })),
    );
  });
});
