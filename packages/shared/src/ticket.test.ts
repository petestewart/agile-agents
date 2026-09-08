import { describe, expect, test } from 'bun:test';
import { TICKET_TRANSITIONS, isLegalTransition, validateTicket } from './ticket';

const baseTicket = {
  id: 'TKT-0231',
  title: 'Issue JWT on login',
  status: 'ready',
  contract: {
    inputs: ['packages/api/auth/**'],
    outputs: ['packages/api/auth/jwt.ts'],
    acceptance: ['returns 200'],
    done: ['tests_pass'],
    env: 'clone',
  },
};

describe('Ticket schema', () => {
  test('validates a minimal legal ticket', () => {
    const ticket = validateTicket(baseTicket);
    expect(ticket.status).toBe('ready');
    expect(ticket.security).toBe(false); // default
  });

  test('rejects an unknown status', () => {
    expect(() => validateTicket({ ...baseTicket, status: 'in_flight' })).toThrow();
  });

  test('rejects a malformed ticket id', () => {
    expect(() => validateTicket({ ...baseTicket, id: 'TKT-abc' })).toThrow();
  });

  test('rejects contract.env values outside clone/compose:<path>', () => {
    expect(() =>
      validateTicket({ ...baseTicket, contract: { ...baseTicket.contract, env: 'container' } }),
    ).toThrow();
  });

  test('accepts contract.env compose form', () => {
    expect(() =>
      validateTicket({
        ...baseTicket,
        contract: { ...baseTicket.contract, env: 'compose: docker/compose.test.yml' },
      }),
    ).not.toThrow();
  });
});

describe('TICKET_TRANSITIONS / isLegalTransition', () => {
  test('every status has a transitions entry', () => {
    for (const status of Object.keys(TICKET_TRANSITIONS)) {
      expect(Array.isArray(TICKET_TRANSITIONS[status as keyof typeof TICKET_TRANSITIONS])).toBe(
        true,
      );
    }
  });

  test('legal edges named in the design are accepted', () => {
    expect(isLegalTransition('draft', 'ready')).toBe(true);
    expect(isLegalTransition('ready', 'assigned')).toBe(true);
    expect(isLegalTransition('assigned', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_progress', 'in_review')).toBe(true);
    expect(isLegalTransition('in_review', 'in_qa')).toBe(true);
    expect(isLegalTransition('in_qa', 'done')).toBe(true);
    expect(isLegalTransition('in_qa', 'in_progress')).toBe(true); // QA reject
    expect(isLegalTransition('in_review', 'in_progress')).toBe(true); // request_changes
    expect(isLegalTransition('in_progress', 'blocked')).toBe(true);
    expect(isLegalTransition('blocked', 'in_progress')).toBe(true);
    expect(isLegalTransition('stale', 'ready')).toBe(true);
    expect(isLegalTransition('paused', 'ready')).toBe(true);
    expect(isLegalTransition('in_progress', 'stale')).toBe(true); // ripple walk
  });

  test('invalid transitions are rejected', () => {
    expect(isLegalTransition('done', 'in_progress')).toBe(false); // terminal
    expect(isLegalTransition('draft', 'done')).toBe(false); // skips the whole flow
    expect(isLegalTransition('ready', 'in_progress')).toBe(false); // skips assigned
    expect(isLegalTransition('blocked', 'done')).toBe(false);
  });
});
