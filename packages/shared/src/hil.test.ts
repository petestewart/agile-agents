import { describe, expect, test } from 'bun:test';
import { HilIdSchema, validateBreakerState, validateHilRequest } from './hil';

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV',
    gate: 'demo',
    hil_kind: 'demo',
    owner: 'human',
    status: 'pending',
    requested_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HilIdSchema', () => {
  test('accepts HIL-<ulid>', () => {
    expect(HilIdSchema.safeParse('HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
  });

  test('rejects a halt-style numeric id and a bare ulid with no prefix', () => {
    expect(HilIdSchema.safeParse('HIL-12').success).toBe(false);
    expect(HilIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(false);
  });
});

describe('validateHilRequest', () => {
  test('accepts a minimal pending human-owned request', () => {
    expect(() => validateHilRequest(baseRequest())).not.toThrow();
  });

  test('requires hil_kind', () => {
    const { hil_kind: _drop, ...rest } = baseRequest();
    expect(() => validateHilRequest(rest)).toThrow();
  });

  test('accepts a human_timeout owner with a deadline', () => {
    expect(() =>
      validateHilRequest(
        baseRequest({ owner: 'human_timeout:2h', deadline: '2026-01-01T02:00:00.000Z' }),
      ),
    ).not.toThrow();
  });

  test('rejects an unknown owner form', () => {
    expect(() => validateHilRequest(baseRequest({ owner: 'reviewer' }))).toThrow();
  });

  test('accepts a resolved, delegated request with a decision artifact and fyi', () => {
    expect(() =>
      validateHilRequest(
        baseRequest({
          owner: 'em',
          status: 'resolved',
          decision: 'approve',
          decided_by: 'em',
          resolved_at: '2026-01-01T00:00:01.000Z',
          delegated: true,
          fyi: {
            to: 'human',
            body: 'gate "demo" approved by em',
            sent_at: '2026-01-01T00:00:01.000Z',
          },
        }),
      ),
    ).not.toThrow();
  });

  test('rejects an fyi body over the 800-char message cap', () => {
    expect(() =>
      validateHilRequest(
        baseRequest({
          fyi: { to: 'human', body: 'x'.repeat(801), sent_at: '2026-01-01T00:00:01.000Z' },
        }),
      ),
    ).toThrow();
  });

  test('rejects extra fields (strict)', () => {
    expect(() => validateHilRequest(baseRequest({ unexpected: true }))).toThrow();
  });
});

describe('validateBreakerState', () => {
  test('accepts an empty tripped map', () => {
    expect(() => validateBreakerState({ tripped: {} })).not.toThrow();
  });

  test('accepts every known signal', () => {
    expect(() =>
      validateBreakerState({
        tripped: {
          global_halt: 'H-1 raised',
          budget_pct: 'over 90%',
          integration_red: 'nightly failing',
          ladder_exhausted: 'TKT-0231',
          deadlock: 'eng-3 vs reviewer-1',
          denials: 'N denials on TKT-0231',
        },
      }),
    ).not.toThrow();
  });

  test('rejects an unknown signal name', () => {
    expect(() => validateBreakerState({ tripped: { not_a_signal: 'x' } })).toThrow();
  });
});
