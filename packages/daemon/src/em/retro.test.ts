import { describe, expect, test } from 'bun:test';
import type { Event, LedgerLine, Ticket, TicketId } from '@agile-agents/shared';
import { SprintRetroSchema, validateTicket } from '@agile-agents/shared';
import { computeRetro, withRetro } from './retro';
import { makeSprint } from './test-helpers';

function ledgerLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    ts: '2026-01-01T00:00:00Z',
    sprint: 'S-1',
    ticket: '',
    agent: 'eng-1',
    model: 'claude',
    in_tokens: 0,
    out_tokens: 0,
    cost_usd: 0,
    kind: 'engineer',
    ...overrides,
  };
}

function event(overrides: Partial<Event> = {}): Event {
  return { ts: '2026-01-01T00:00:00Z', kind: 'message', data: {}, ...overrides };
}

function ticket(id: TicketId, ceiling: number): Ticket {
  return validateTicket({
    id,
    title: id,
    status: 'done',
    contract: {},
    history: [],
    budget: { ceiling_tokens: ceiling, spent_tokens: 0 },
  });
}

describe('computeRetro', () => {
  test('mispointed: a ticket whose ledger spend exceeds 3x its ceiling', () => {
    const tickets = [ticket('TKT-0001' as TicketId, 1000), ticket('TKT-0002' as TicketId, 1000)];
    const ledgerLines = [
      ledgerLine({ ticket: 'TKT-0001', in_tokens: 2000, out_tokens: 1001 }), // 3001 > 3000
      ledgerLine({ ticket: 'TKT-0002', in_tokens: 500, out_tokens: 500 }), // 1000, not mispointed
    ];
    const retro = computeRetro({ ledgerLines, events: [], tickets });
    expect(retro.mispointed).toEqual(['TKT-0001']);
  });

  test('no tickets passed -> mispointed is always empty, never guessed at', () => {
    const ledgerLines = [ledgerLine({ ticket: 'TKT-0001', in_tokens: 1_000_000, out_tokens: 0 })];
    const retro = computeRetro({ ledgerLines, events: [] });
    expect(retro.mispointed).toEqual([]);
  });

  test('a ticket with no budget ceiling is never mispointed regardless of spend', () => {
    const t = validateTicket({
      id: 'TKT-0001',
      title: 't',
      status: 'done',
      contract: {},
      history: [],
    });
    const ledgerLines = [ledgerLine({ ticket: 'TKT-0001', in_tokens: 999_999, out_tokens: 0 })];
    expect(computeRetro({ ledgerLines, events: [], tickets: [t] }).mispointed).toEqual([]);
  });

  test('global_halts counts only halt_created events scoped global', () => {
    const events = [
      event({ kind: 'halt_created', data: { id: 'H-1', scope: 'global' } }),
      event({ kind: 'halt_created', data: { id: 'H-2', scope: ['TKT-0001'] } }),
      event({ kind: 'halt_created', data: { id: 'H-3', scope: 'global' } }),
      event({ kind: 'halt_updated', data: { haltId: 'H-1', quorum: 'reached' } }),
    ];
    expect(computeRetro({ ledgerLines: [], events }).global_halts).toBe(2);
  });

  test('escalations counts message events of kind escalate', () => {
    const events = [
      event({ kind: 'message', data: { kind: 'escalate' } }),
      event({ kind: 'message', data: { kind: 'assign' } }),
      event({ kind: 'message', data: { kind: 'escalate' } }),
      event({ kind: 'state_transition', data: {} }),
    ];
    expect(computeRetro({ ledgerLines: [], events }).escalations).toBe(2);
  });

  test('empty ledger + events -> zeroed retro block, valid against the shared schema', () => {
    const retro = computeRetro({ ledgerLines: [], events: [] });
    expect(SprintRetroSchema.parse(retro)).toEqual({
      mispointed: [],
      global_halts: 0,
      escalations: 0,
    });
  });
});

describe('withRetro', () => {
  test('writes the computed retro block onto the sprint, validated', () => {
    const sprint = makeSprint('S-1');
    const events = [event({ kind: 'halt_created', data: { id: 'H-1', scope: 'global' } })];
    const updated = withRetro(sprint, { ledgerLines: [], events });
    expect(updated.retro).toEqual({ mispointed: [], global_halts: 1, escalations: 0 });
  });
});
