import { describe, expect, test } from 'bun:test';
import { validateHomeConfig } from './home-config';
import {
  VendorCheckModeInputSchema,
  type VendorCheckResult,
  VendorCheckResultSchema,
  VendorCheckRunInputSchema,
  resumeMark,
  settingMark,
  usageWords,
} from './vendor-check';

const result: VendorCheckResult = {
  vendor: 'cursor',
  label: 'Cursor',
  session: '01K6AAAAAAAAAAAAAAAAAAAAAA',
  cli_version: '2026.09.25',
  started_at: '2026-09-30T10:00:00.000Z',
  finished_at: '2026-09-30T10:00:20.000Z',
  reason: 'new_version',
  by: 'daemon',
  logged_in: true,
  opened: true,
  model: { outcome: 'kept', from: 'default[]', to: 'grok-4.7', after: 'default[]' },
  effort: { outcome: 'not_applicable', detail: 'Cursor reported no effort option' },
  prompt: { outcome: 'finished', took_ms: 2400, reply: 'OK', stop_reason: 'end_turn' },
  usage: {
    update_fields: ['used', 'size'],
    reply_keys: ['stopReason'],
    reply_usage_fields: [],
    turn_tokens: false,
    context: true,
  },
  rate_limits: [],
  resume: { outcome: 'not_supported' },
  errors: [],
};

describe('T489 the vendor self-check schemas (D58)', () => {
  test('a result validates and is strict', () => {
    expect(VendorCheckResultSchema.parse(result)).toEqual(result);
    expect(VendorCheckResultSchema.safeParse({ ...result, token: 'x' }).success).toBe(false);
    expect(
      VendorCheckResultSchema.safeParse({ ...result, model: { outcome: 'maybe' } }).success,
    ).toBe(false);
    expect(
      VendorCheckResultSchema.safeParse({
        ...result,
        rate_limits: Array.from({ length: 21 }, () => ({
          where: 'turn_end',
          name: 'x',
          value: '1',
        })),
      }).success,
    ).toBe(false);
  });

  test('the run and switch inputs; the home config switch', () => {
    expect(VendorCheckRunInputSchema.parse({})).toEqual({});
    expect(VendorCheckRunInputSchema.safeParse({ vendor: 'openai' }).success).toBe(false);
    expect(VendorCheckModeInputSchema.safeParse({ mode: 'weekly' }).success).toBe(false);
    expect(validateHomeConfig({ vendor_checks: 'manual' }).vendor_checks).toBe('manual');
    expect(() => validateHomeConfig({ vendor_checks: 'sometimes' })).toThrow();
  });

  test('marks and words', () => {
    expect(settingMark('honoured')).toBe('✓');
    expect(settingMark('kept')).toBe('✗');
    expect(settingMark('refused')).toBe('✗');
    expect(settingMark('not_applicable')).toBe('—');
    expect(resumeMark('ok')).toBe('✓');
    expect(resumeMark('failed')).toBe('✗');
    expect(resumeMark('not_supported')).toBe('—');
    expect(usageWords(result.usage)).toBe('updates: used, size');
    expect(usageWords(undefined)).toBe('none');
  });
});
