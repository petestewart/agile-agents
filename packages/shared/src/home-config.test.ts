import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_BASE_URL,
  DEFAULT_CLASSIFIER_DENY_AT,
  DEFAULT_CLASSIFIER_STATE_MAX_CHARS,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  validateClassifierConfig,
  validateHomeConfig,
} from './home-config';

describe('classifier config (T150, cockpit design §6.2/§6.3)', () => {
  test('an absent block is the documented defaults', () => {
    expect(validateClassifierConfig(undefined)).toEqual({
      provider: 'jev',
      base_url: DEFAULT_CLASSIFIER_BASE_URL,
      timeout_ms: DEFAULT_CLASSIFIER_TIMEOUT_MS,
      state_max_chars: DEFAULT_CLASSIFIER_STATE_MAX_CHARS,
      bands: {
        deny_at: DEFAULT_CLASSIFIER_DENY_AT,
        allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
      },
    });
  });

  test('§6.3 starting values', () => {
    expect(DEFAULT_CLASSIFIER_DENY_AT).toBe(0.8);
    expect(DEFAULT_CLASSIFIER_ALLOW_BELOW).toBe(0.4);
    expect(DEFAULT_CLASSIFIER_TIMEOUT_MS).toBe(25_000);
  });

  test('a partial bands block keeps the other defaults', () => {
    expect(validateClassifierConfig({ bands: { deny_at: 0.9 } }).bands).toEqual({
      deny_at: 0.9,
      allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
    });
  });

  test('a typo is refused, not ignored (.strict())', () => {
    expect(() => validateClassifierConfig({ provdier: 'jev' })).toThrow();
    expect(() => validateClassifierConfig({ bands: { deny: 0.8 } })).toThrow();
    expect(() => validateHomeConfig({ classifier: { provider: 'gpt' } })).toThrow();
  });

  test('an old config carrying the removed floor fails loudly, naming D14 (T156)', () => {
    const old = { bands: { deny_at: 0.8, allow_below: 0.4, confidence_floor: 0 } };
    expect(() => validateClassifierConfig(old)).toThrow(/confidence_floor was removed by D14/);
    expect(() => validateHomeConfig({ classifier: old })).toThrow(/D14/);
  });

  test('a band outside [0, 1] is refused', () => {
    expect(() => validateClassifierConfig({ bands: { deny_at: 1.5 } })).toThrow();
  });

  test('the home config carries the block and leaves it out when absent', () => {
    expect(validateHomeConfig({}).classifier).toBeUndefined();
    expect(validateHomeConfig({ classifier: { provider: 'off' } }).classifier?.provider).toBe(
      'off',
    );
  });
});
