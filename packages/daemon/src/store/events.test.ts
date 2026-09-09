import { describe, expect, test } from 'bun:test';
import { buildEvent, buildStateTransitionEvent } from './events';

describe('buildStateTransitionEvent', () => {
  test('builds a valid state_transition Event', () => {
    const event = buildStateTransitionEvent({
      ticket: 'TKT-0231',
      agent: 'eng-3',
      from: 'assigned',
      to: 'in_progress',
    });
    expect(event.kind).toBe('state_transition');
    expect(event.ticket).toBe('TKT-0231');
    expect(event.agent).toBe('eng-3');
    expect(event.data).toEqual({ from: 'assigned', to: 'in_progress' });
    expect(typeof event.ts).toBe('string');
    expect(() => new Date(event.ts).toISOString()).not.toThrow();
  });

  test('includes reason in data when given', () => {
    const event = buildStateTransitionEvent({
      ticket: 'TKT-0231',
      agent: 'eng-3',
      from: 'in_progress',
      to: 'blocked',
      reason: 'MSG-01J9',
    });
    expect(event.data).toEqual({ from: 'in_progress', to: 'blocked', reason: 'MSG-01J9' });
  });
});

describe('buildEvent', () => {
  test('builds a minimal event with no ticket/agent', () => {
    const event = buildEvent('ticket_put', { data: { relPath: 'tickets/TKT-0001.yaml' } });
    expect(event.kind).toBe('ticket_put');
    expect(event.ticket).toBeUndefined();
    expect(event.agent).toBeUndefined();
    expect(event.data).toEqual({ relPath: 'tickets/TKT-0001.yaml' });
  });

  test('includes ticket/agent when given', () => {
    const event = buildEvent('stanza_appended', { ticket: 'TKT-0001', agent: 'eng-1' });
    expect(event.ticket).toBe('TKT-0001');
    expect(event.agent).toBe('eng-1');
    expect(event.data).toEqual({});
  });
});
