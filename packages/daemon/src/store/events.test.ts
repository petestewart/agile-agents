import { describe, expect, test } from 'bun:test';
import { buildStateTransitionEvent } from './events';

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
