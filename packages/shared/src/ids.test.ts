import { describe, expect, test } from 'bun:test';
import {
  DecisionIdSchema,
  HaltIdSchema,
  KbIdSchema,
  SpecIdSchema,
  SprintIdSchema,
  TicketIdSchema,
  UlidSchema,
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
