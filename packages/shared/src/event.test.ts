import { describe, expect, test } from 'bun:test';
import { EVENT_KINDS, validateEvent } from './event';

describe('Event — cockpit design §7.4 log/events.jsonl', () => {
  test('accepts the minimal shape (ts, kind, default data)', () => {
    const event = validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'message' });
    expect(event.data).toEqual({});
    expect(event.stream).toBeUndefined();
    expect(event.session).toBeUndefined();
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

  // T122/T123: the ticket layer is gone, and with it the top-level `ticket`
  // scope and every ticket/sprint/halt/quota/merge event kind.
  test.each([
    'ticket_put',
    'stanza_appended',
    'state_transition',
    'halt_created',
    'sprint_put',
    'hil_requested',
    'hil_resolved',
    'merge_completed',
  ])('%s is no longer an EVENT_KINDS entry', (kind) => {
    expect(EVENT_KINDS).not.toContain(kind as (typeof EVENT_KINDS)[number]);
    expect(() => validateEvent({ ts: '2026-09-08T00:00:00Z', kind })).toThrow(/invalid Event/);
  });

  test('rejects the removed top-level ticket scope', () => {
    expect(() =>
      validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'message', ticket: 'TKT-0001' }),
    ).toThrow(/invalid Event/);
  });

  // §7.4's eight families. Every kind below has at least one emitter in the
  // daemon today (`store/events.test.ts` asserts the other direction: every
  // event the services actually write is one of these).
  test.each([
    'project_created',
    'project_updated',
    'stream_created',
    'stream_updated',
    'stream_closed',
    'stream_archived',
    'thread_appended',
    'tool_call',
    'agent_put',
    'agent_deleted',
    'question_raised',
    'question_answered',
    'gate_raised',
    'gate_resolved',
    'breaker_tripped',
    'breaker_cleared',
    'rule_put',
    'rule_decided',
    'hook_decision',
    'classifier_call',
    'repos_put',
    'vendors_put',
    'policy_put',
    'home_config_put',
    'entity_put',
    'entity_deleted',
    'home_migrated',
    'message',
  ])('%s is a valid EVENT_KINDS entry', (kind) => {
    expect(EVENT_KINDS).toContain(kind as (typeof EVENT_KINDS)[number]);
    expect(() => validateEvent({ ts: '2026-09-08T00:00:00Z', kind })).not.toThrow();
  });

  test('the enum holds exactly the kinds listed above — nothing orphaned', () => {
    expect(EVENT_KINDS).toHaveLength(28);
  });

  test('a stream event carries {stream} plus the status pair in data', () => {
    const event = validateEvent({
      ts: '2026-09-08T00:00:00Z',
      kind: 'stream_updated',
      stream: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
      data: { agent_status: 'working', human_status: 'open', archived: false },
    });
    expect(event.stream).toBe('01J9ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(event.data.agent_status).toBe('working');
  });

  test('a tool_call event carries {agent, session, toolCallId, …}', () => {
    const event = validateEvent({
      ts: '2026-09-08T00:00:00Z',
      kind: 'tool_call',
      session: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
      agent: '01ARZ3NDEKTSV4RRFFQ69GE231',
      data: { toolCallId: 't1', kind: 'edit', title: 'Edit foo.ts', status: 'completed' },
    });
    expect(event.agent).toBe('01ARZ3NDEKTSV4RRFFQ69GE231');
    expect(event.session).toBe('01J9ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(event.data).toEqual({
      toolCallId: 't1',
      kind: 'edit',
      title: 'Edit foo.ts',
      status: 'completed',
    });
  });

  test('rejects a stream scope that is not a ULID', () => {
    expect(() =>
      validateEvent({ ts: '2026-09-08T00:00:00Z', kind: 'stream_created', stream: 'nope' }),
    ).toThrow(/invalid Event/);
  });
});
