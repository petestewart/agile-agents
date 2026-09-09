import { describe, expect, test } from 'bun:test';
import { validateOracleIndex } from './oracle';

describe('OracleIndex — §4 "Oracle" index.yaml', () => {
  test('accepts the init-time empty object', () => {
    expect(validateOracleIndex({})).toEqual({});
  });

  test('accepts a map keyed by id with title/status/supersedes/depends', () => {
    const index = validateOracleIndex({
      'DEC-0042': {
        title: 'Sessions are JWT, not server-side',
        status: 'active',
        supersedes: ['DEC-0019'],
        depends: ['SPEC-auth-003'],
      },
      'SPEC-auth-003': {
        title: 'Auth spec',
        status: 'active',
        supersedes: [],
        depends: [],
      },
    });
    expect(Object.keys(index)).toEqual(['DEC-0042', 'SPEC-auth-003']);
    expect(index['DEC-0042']?.supersedes).toEqual(['DEC-0019']);
  });

  test('defaults supersedes/depends to []', () => {
    const index = validateOracleIndex({
      'DEC-0042': { title: 'x', status: 'active' },
    });
    expect(index['DEC-0042']).toEqual({
      title: 'x',
      status: 'active',
      supersedes: [],
      depends: [],
    });
  });

  test('rejects an unknown key (strict entry schema)', () => {
    expect(() =>
      validateOracleIndex({
        'DEC-0042': { title: 'x', status: 'active', extra: true },
      }),
    ).toThrow(/invalid OracleIndex/);
  });

  test('rejects a malformed id key', () => {
    expect(() =>
      validateOracleIndex({
        'not-an-id': { title: 'x', status: 'active' },
      }),
    ).toThrow(/invalid OracleIndex/);
  });

  test('a superseded entry is still structurally valid (the writer drops it, not the schema)', () => {
    expect(() =>
      validateOracleIndex({
        'DEC-0019': { title: 'x', status: 'superseded' },
      }),
    ).not.toThrow();
  });
});
