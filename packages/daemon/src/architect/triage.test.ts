import { describe, expect, test } from 'bun:test';
import type { Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { triageDiscovery } from './triage';

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'in_progress',
    contract: {},
    history: [],
    oracle_refs: [],
    ...overrides,
  });
}

describe('triageDiscovery', () => {
  test('no oracle refs named -> local, nothing to halt', () => {
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: [], proposed: 'noticed a typo' },
      },
      [makeTicket('TKT-0001')],
      {},
    );
    expect(result).toEqual({ tier: 'local', affected: [] });
  });

  test('named oracle ref nobody else lives on -> local', () => {
    const tickets = [
      makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0002', { oracle_refs: ['DEC-0002'] }),
    ];
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: ['DEC-0001'], proposed: 'x' },
      },
      tickets,
      {},
    );
    expect(result).toEqual({ tier: 'local', affected: [] });
  });

  test('one other live ticket shares the affected ref -> scoped', () => {
    const tickets = [
      makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0002', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0003', { oracle_refs: ['DEC-0002'] }),
      makeTicket('TKT-0004', { oracle_refs: ['DEC-0003'] }),
    ];
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: ['DEC-0001'], proposed: 'x' },
      },
      tickets,
      {},
    );
    expect(result.tier).toBe('scoped');
    expect(result.affected).toEqual(['TKT-0002']);
  });

  test('majority of the live board shares the affected ref -> global (seeded contradiction, T014 acceptance)', () => {
    const tickets = [
      makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0002', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0003', { oracle_refs: ['DEC-0001'] }),
    ];
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: ['DEC-0001'], proposed: 'contradiction' },
      },
      tickets,
      {},
    );
    expect(result.tier).toBe('global');
    expect(new Set(result.affected)).toEqual(new Set(['TKT-0002', 'TKT-0003']));
  });

  test('done tickets are never counted as affected', () => {
    const tickets = [
      makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0002', { oracle_refs: ['DEC-0001'], status: 'done' }),
    ];
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: ['DEC-0001'], proposed: 'x' },
      },
      tickets,
      {},
    );
    expect(result).toEqual({ tier: 'local', affected: [] });
  });

  test('engineer-proposed global tier is respected as a floor even under the threshold', () => {
    const tickets = [
      makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0002', { oracle_refs: ['DEC-0001'] }),
      makeTicket('TKT-0003', { oracle_refs: ['DEC-0002'] }),
      makeTicket('TKT-0004', { oracle_refs: ['DEC-0002'] }),
      makeTicket('TKT-0005', { oracle_refs: ['DEC-0002'] }),
    ];
    const result = triageDiscovery(
      {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'global', affects: ['DEC-0001'], proposed: 'x' },
      },
      tickets,
      {},
    );
    expect(result.tier).toBe('global');
  });
});
