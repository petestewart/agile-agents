import { describe, expect, test } from 'bun:test';
import { validateTicket } from '@agile-agents/shared';
import { parseCriteria } from './criteria';

describe('parseCriteria', () => {
  test('one entry per contract.acceptance string, in order, 0-based index', () => {
    const ticket = validateTicket({
      id: 'TKT-0001',
      title: 'Fixture',
      status: 'in_qa',
      contract: {
        acceptance: ['POST /login returns 200', 'npm test -w packages/api passes'],
      },
      history: [],
    });
    expect(parseCriteria(ticket)).toEqual([
      { index: 0, text: 'POST /login returns 200' },
      { index: 1, text: 'npm test -w packages/api passes' },
    ]);
  });

  test('empty acceptance -> empty criteria', () => {
    const ticket = validateTicket({
      id: 'TKT-0001',
      title: 'Fixture',
      status: 'in_qa',
      contract: {},
      history: [],
    });
    expect(parseCriteria(ticket)).toEqual([]);
  });
});
