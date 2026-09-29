import { describe, expect, test } from 'bun:test';
import { HarnessUpdatesInputSchema, harnessModeOf } from './harness-updates';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_BASE_URL,
  DEFAULT_CLASSIFIER_DENY_AT,
  DEFAULT_CLASSIFIER_STATE_MAX_CHARS,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  validateClassifierConfig,
  validateHomeConfig,
} from './home-config';
import { FAVOURITE_MODELS_MAX, FavouriteModelInputSchema, favouriteKey } from './session-defaults';

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

describe('T481 harness_updates (D50)', () => {
  test('absent is Alert; a vendor overrides the home; pi-acp follows Pi', () => {
    expect(harnessModeOf(undefined, 'claude')).toBe('alert');
    const config = validateHomeConfig({
      harness_updates: { mode: 'auto', vendors: { pi: 'off' }, dismissed: { claude: '2.3.1' } },
    }).harness_updates;
    expect(harnessModeOf(config, 'claude')).toBe('auto');
    expect(harnessModeOf(config, 'pi')).toBe('off');
    expect(harnessModeOf(config, 'pi-acp')).toBe('off');
  });

  test('strict: an unknown mode, vendor, key or version is refused', () => {
    expect(() => validateHomeConfig({ harness_updates: { mode: 'sometimes' } })).toThrow();
    expect(() => validateHomeConfig({ harness_updates: { vendors: { vim: 'off' } } })).toThrow();
    expect(() => validateHomeConfig({ harness_updates: { every: 'day' } })).toThrow();
    expect(() =>
      validateHomeConfig({ harness_updates: { dismissed: { claude: 'latest' } } }),
    ).toThrow();
  });

  test('the Settings input: a mode, or a vendor with a mode or null', () => {
    expect(HarnessUpdatesInputSchema.safeParse({ mode: 'off' }).success).toBe(true);
    expect(HarnessUpdatesInputSchema.safeParse({ mode: null, vendor: 'codex' }).success).toBe(true);
    expect(HarnessUpdatesInputSchema.safeParse({ mode: null }).success).toBe(false);
    expect(HarnessUpdatesInputSchema.safeParse({ mode: 'auto', extra: 1 }).success).toBe(false);
  });
});

describe('T469 favourite_models', () => {
  test('a list of {vendor, model?}; absent is none', () => {
    expect(validateHomeConfig({}).favourite_models).toBeUndefined();
    const config = validateHomeConfig({
      favourite_models: [
        { vendor: 'claude', model: 'claude-opus-5-5' },
        { vendor: 'cursor', model: 'grok-4.7[context=256k,fast=true]' },
        { vendor: 'gemini' },
      ],
    });
    expect(config.favourite_models).toEqual([
      { vendor: 'claude', model: 'claude-opus-5-5' },
      { vendor: 'cursor', model: 'grok-4.7[context=256k,fast=true]' },
      { vendor: 'gemini' },
    ]);
  });

  test('strict: an unknown vendor, an extra key, an empty model or too many are refused', () => {
    expect(() => validateHomeConfig({ favourite_models: [{ vendor: 'vim' }] })).toThrow();
    expect(() =>
      validateHomeConfig({ favourite_models: [{ vendor: 'claude', model: 'x', star: true }] }),
    ).toThrow();
    expect(() =>
      validateHomeConfig({ favourite_models: [{ vendor: 'claude', model: '' }] }),
    ).toThrow();
    expect(() => validateHomeConfig({ favourite_models: { vendor: 'claude' } })).toThrow();
    const many = Array.from({ length: FAVOURITE_MODELS_MAX + 1 }, (_, i) => ({
      vendor: 'codex',
      model: `gpt-${i}`,
    }));
    expect(() => validateHomeConfig({ favourite_models: many })).toThrow();
  });

  test('the star input: a vendor, a model or none, and on', () => {
    expect(
      FavouriteModelInputSchema.safeParse({ vendor: 'codex', model: 'gpt-5.5', on: true }).success,
    ).toBe(true);
    expect(FavouriteModelInputSchema.safeParse({ vendor: 'gemini', on: false }).success).toBe(true);
    expect(FavouriteModelInputSchema.safeParse({ vendor: 'codex', model: 'gpt-5.5' }).success).toBe(
      false,
    );
    expect(FavouriteModelInputSchema.safeParse({ vendor: 'vim', on: true }).success).toBe(false);
    expect(
      FavouriteModelInputSchema.safeParse({ vendor: 'codex', on: true, extra: 1 }).success,
    ).toBe(false);
  });

  test("favouriteKey: `default` and no model are the vendor's own default", () => {
    expect(favouriteKey({ vendor: 'claude', model: 'default' })).toBe('claude/');
    expect(favouriteKey({ vendor: 'claude' })).toBe('claude/');
    expect(favouriteKey({ vendor: 'claude', model: 'opus' })).toBe('claude/opus');
  });
});
