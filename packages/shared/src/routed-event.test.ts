import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  ROUTED_EVENT_PAYLOAD_MAX,
  ROUTED_EVENT_STRING_MAX,
  validateDelivery,
  validateRoutedEvent,
} from './routed-event';

const node = ulid();
const base = (over: Record<string, unknown> = {}) => ({
  id: `E-${ulid()}`,
  type: 'human_line',
  subject: node,
  payload: { body: 'hello' },
  by: 'human',
  at: '2026-09-24T00:00:00.000Z',
  routing: [{ node, because: 'self' }],
  ...over,
});

describe('RoutedEvent schema (projects-design §14.9, §15)', () => {
  test('accepts a typed event', () => {
    expect(validateRoutedEvent(base()).type).toBe('human_line');
    const merged = validateRoutedEvent(
      base({
        type: 'main_changed',
        repo: 'api',
        payload: { repo: 'api', sha: 'abc', outcome: 'synced' },
        by: 'daemon',
      }),
    );
    expect(merged.repo).toBe('api');
  });

  test('checks the payload against its type', () => {
    expect(() => validateRoutedEvent(base({ payload: { answer: 'x' } }))).toThrow();
    expect(() => validateRoutedEvent(base({ payload: { body: 'x', extra: 1 } }))).toThrow();
    expect(() => validateRoutedEvent(base({ type: 'nope' }))).toThrow();
  });

  test('refuses a string over the cap and a payload over the byte cap', () => {
    const long = 'x'.repeat(ROUTED_EVENT_STRING_MAX + 1);
    expect(() => validateRoutedEvent(base({ payload: { body: long } }))).toThrow();
    const files = Array.from({ length: 10 }, () => 'y'.repeat(ROUTED_EVENT_STRING_MAX));
    expect(files.join('').length).toBeGreaterThan(ROUTED_EVENT_PAYLOAD_MAX);
    expect(() =>
      validateRoutedEvent(base({ type: 'sync_conflict', payload: { repo: 'api', files } })),
    ).toThrow(/byte cap/);
  });

  test('refuses bad ids, principals and duplicate routing', () => {
    expect(() => validateRoutedEvent(base({ id: ulid() }))).toThrow();
    expect(() => validateRoutedEvent(base({ by: 'agent:nope' }))).toThrow();
    expect(validateRoutedEvent(base({ by: `agent:${ulid()}` })).by).toMatch(/^agent:/);
    expect(() =>
      validateRoutedEvent(
        base({
          routing: [
            { node, because: 'self' },
            { node, because: 'ancestor' },
          ],
        }),
      ),
    ).toThrow(/routed twice/);
  });

  test('Delivery is strict', () => {
    const d = { event: `E-${ulid()}`, node, status: 'pending' };
    expect(validateDelivery(d).status).toBe('pending');
    expect(() => validateDelivery({ ...d, status: 'sent' })).toThrow();
    expect(() => validateDelivery({ ...d, extra: 1 })).toThrow();
  });
});
