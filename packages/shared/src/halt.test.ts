import { describe, expect, test } from 'bun:test';
import { validateHalt } from './halt';

describe('Halt schema', () => {
  test('accepts scope: global', () => {
    expect(() =>
      validateHalt({
        id: 'H-1',
        scope: 'global',
        reason: 'oracle changed',
        raised_by: 'architect',
        quorum: 'pending',
      }),
    ).not.toThrow();
  });

  test('accepts scope: team:<name>', () => {
    expect(() =>
      validateHalt({
        id: 'H-1',
        scope: 'team:team-alpha',
        reason: 'x',
        raised_by: 'architect',
        quorum: 'pending',
      }),
    ).not.toThrow();
  });

  test('accepts scope: [ticket ids]', () => {
    expect(() =>
      validateHalt({
        id: 'H-1',
        scope: ['TKT-0231', 'TKT-0230'],
        reason: 'x',
        raised_by: 'architect',
        quorum: 'reached',
      }),
    ).not.toThrow();
  });

  test('rejects an empty scope list and an unknown quorum value', () => {
    expect(() =>
      validateHalt({
        id: 'H-1',
        scope: [],
        reason: 'x',
        raised_by: 'architect',
        quorum: 'pending',
      }),
    ).toThrow();
    expect(() =>
      validateHalt({
        id: 'H-1',
        scope: 'global',
        reason: 'x',
        raised_by: 'architect',
        quorum: 'in_progress',
      }),
    ).toThrow();
  });
});
