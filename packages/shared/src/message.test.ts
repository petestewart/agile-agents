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
});
