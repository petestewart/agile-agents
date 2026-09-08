import { describe, expect, test } from 'bun:test';
import { MESSAGE_BODY_MAX_CHARS, validateMessage } from './message';

const baseMessage = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  ts: '2026-09-07T18:00:00Z',
  from: 'eng-3',
  to: ['em'],
  kind: 'assign',
  priority: 'normal',
  body: 'short body',
};

describe('Message schema', () => {
  test('validates a minimal legal message', () => {
    expect(() => validateMessage(baseMessage)).not.toThrow();
  });

  test('rejects an oversized body (> 800 chars)', () => {
    const oversized = { ...baseMessage, body: 'x'.repeat(MESSAGE_BODY_MAX_CHARS + 1) };
    expect(() => validateMessage(oversized)).toThrow(/800/);
  });

  test('accepts a body exactly at the cap', () => {
    const atCap = { ...baseMessage, body: 'x'.repeat(MESSAGE_BODY_MAX_CHARS) };
    expect(() => validateMessage(atCap)).not.toThrow();
  });

  test('rejects a malformed id (not a ULID)', () => {
    expect(() => validateMessage({ ...baseMessage, id: 'not-a-ulid' })).toThrow();
  });

  test('accepts broadcast and ticket: fan-out recipients', () => {
    expect(() => validateMessage({ ...baseMessage, to: ['broadcast'] })).not.toThrow();
    expect(() => validateMessage({ ...baseMessage, to: ['ticket:TKT-0231'] })).not.toThrow();
  });

  test('rejects an unknown message kind', () => {
    expect(() => validateMessage({ ...baseMessage, kind: 'gossip' })).toThrow();
  });

  test('accepts the design-mandated fyi, quota_low, quota_exhausted kinds', () => {
    expect(() => validateMessage({ ...baseMessage, kind: 'fyi' })).not.toThrow();
    expect(() => validateMessage({ ...baseMessage, kind: 'quota_low' })).not.toThrow();
    expect(() => validateMessage({ ...baseMessage, kind: 'quota_exhausted' })).not.toThrow();
  });

  test('rejects an unknown top-level key', () => {
    expect(() => validateMessage({ ...baseMessage, extra_field: 'nope' })).toThrow();
  });

  test('hil_request round-trips kind, hil_kind, and deadline (§5 "HIL")', () => {
    const hilRequest = validateMessage({
      ...baseMessage,
      kind: 'hil_request',
      hil_kind: 'approve_decision',
      deadline: '2026-09-08T12:00:00Z',
    });
    expect(hilRequest.kind).toBe('hil_request');
    expect(hilRequest.hil_kind).toBe('approve_decision');
    expect(hilRequest.deadline).toBe('2026-09-08T12:00:00Z');
  });

  test('hil_request without hil_kind or deadline is rejected', () => {
    expect(() => validateMessage({ ...baseMessage, kind: 'hil_request' })).toThrow();
    expect(() =>
      validateMessage({ ...baseMessage, kind: 'hil_request', hil_kind: 'demo' }),
    ).toThrow();
  });

  test('answer round-trips promote_to (§5 "Questions")', () => {
    const answer = validateMessage({ ...baseMessage, kind: 'answer', promote_to: 'kb' });
    expect(answer.kind).toBe('answer');
    expect(answer.promote_to).toBe('kb');
  });

  test('answer without promote_to is rejected', () => {
    expect(() => validateMessage({ ...baseMessage, kind: 'answer' })).toThrow();
  });
});
