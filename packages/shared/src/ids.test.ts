import { describe, expect, test } from 'bun:test';
import {
  DecisionIdSchema,
  HaltIdSchema,
  KbIdSchema,
  SpecIdSchema,
  SprintIdSchema,
  TicketIdSchema,
  UlidSchema,
  ulid,
} from './ids';

describe('ID formats', () => {
  test('DEC-0042 is a valid decision id', () => {
    expect(DecisionIdSchema.safeParse('DEC-0042').success).toBe(true);
    expect(DecisionIdSchema.safeParse('DEC-42').success).toBe(false);
  });

  test('SPEC-auth-003 is a valid spec id', () => {
    expect(SpecIdSchema.safeParse('SPEC-auth-003').success).toBe(true);
    expect(SpecIdSchema.safeParse('SPEC-003').success).toBe(false);
  });

  test('TKT-0231 is a valid ticket id', () => {
    expect(TicketIdSchema.safeParse('TKT-0231').success).toBe(true);
    expect(TicketIdSchema.safeParse('TKT-231').success).toBe(false);
  });

  test('KB-0117 is a valid KB id', () => {
    expect(KbIdSchema.safeParse('KB-0117').success).toBe(true);
  });

  test('H-12 is a valid halt id', () => {
    expect(HaltIdSchema.safeParse('H-12').success).toBe(true);
  });

  test('S-07 is a valid sprint id', () => {
    expect(SprintIdSchema.safeParse('S-07').success).toBe(true);
  });

  test('ULIDs must be 26 crockford-base32 chars, excluding I/L/O/U', () => {
    expect(UlidSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
    expect(UlidSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false); // 25 chars
    expect(UlidSchema.safeParse('0IARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(false); // has 'I'
  });
});

describe('ulid()', () => {
  test('produces a value UlidSchema accepts', () => {
    expect(() => UlidSchema.parse(ulid())).not.toThrow();
  });

  test('is 26 chars, Crockford base32', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('is strictly increasing across calls at the same instant (monotonic within a ms)', () => {
    const now = Date.now();
    const ids = Array.from({ length: 50 }, () => ulid(now));
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1] ?? '';
      const curr = ids[i] ?? '';
      expect(curr > prev).toBe(true);
    }
  });

  test('is strictly increasing across different milliseconds', () => {
    const a = ulid(1_000);
    const b = ulid(1_001);
    expect(b > a).toBe(true);
  });

  test('two calls at the same ms share the same 10-char time prefix', () => {
    const now = Date.now();
    const a = ulid(now);
    const b = ulid(now);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  test('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });
});
