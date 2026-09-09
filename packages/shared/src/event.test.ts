import { describe, expect, test } from 'bun:test';
import { EVENT_KINDS, validateEvent } from './event';

describe('Event — §3/§4 log/events.jsonl', () => {
  test('accepts the minimal shape (ts, kind, default data)', () => {
    const event = validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'message' });
    expect(event.data).toEqual({});
    expect(event.ticket).toBeUndefined();
    expect(event.agent).toBeUndefined();
  });

  test('rejects an unknown key', () => {
    expect(() =>
      validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'message', extra: true }),
    ).toThrow(/invalid Event/);
  });

  test('rejects an unknown kind', () => {
    expect(() => validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'not_a_kind' })).toThrow(
      /invalid Event/,
    );
  });

  // T005 review fix (manager decision B1): every StateStore mutation kind
  // gets its own EVENT_KINDS entry, named after the method that mints it.
  test.each([
    'ticket_put',
    'stanza_appended',
    'oracle_put',
    'kb_put',
    'ledger_appended',
    'halt_created',
    'halt_released',
    'sprint_put',
    'quota_put',
    'agent_put',
    'agent_deleted',
    'policy_put',
    'vendors_put',
    'entity_put',
    'entity_deleted',
  ])('%s is a valid EVENT_KINDS entry', (kind) => {
    expect(EVENT_KINDS).toContain(kind as (typeof EVENT_KINDS)[number]);
    expect(() => validateEvent({ ts: '2026-09-08T00:00:00Z', kind })).not.toThrow();
  });
});
