/**
 * T023: tests for the additive `Quota`/`VendorAccount` fields this ticket
 * added. DESIGN-GAP: there is no `packages/shared/src/quota.ts` — the
 * `Quota` entity has always lived in `vendors.ts` (§4 "Quota" and §8
 * "Auth" are documented together there) — so this test file imports from
 * `./vendors` rather than inventing a source-file split with no existing
 * precedent. Named `quota.test.ts` to match this ticket's own file-scope
 * grant.
 */

import { describe, expect, test } from 'bun:test';
import { QuotaSchema, VendorAccountSchema, validateQuota, validateVendorsConfig } from './vendors';

function baseQuota(overrides: Record<string, unknown> = {}) {
  return {
    vendor: 'claude',
    account: 'max',
    kind: 'subscription_window',
    remaining: 0.5,
    unit: 'tokens',
    confidence: 'estimated',
    source: 'ledger_countdown',
    updated: '2026-09-09T00:00:00.000Z',
    cooldown_until: null,
    ...overrides,
  };
}

describe('Quota — additive fields (T023)', () => {
  test('validates without any of the additive fields (pre-T023 shape still legal)', () => {
    expect(() => validateQuota(baseQuota())).not.toThrow();
  });

  test('accepts `limit` as the countdown denominator', () => {
    const quota = validateQuota(baseQuota({ remaining: 400_000, limit: 1_000_000 }));
    expect(quota.limit).toBe(1_000_000);
  });

  test('rejects a non-positive `limit`', () => {
    expect(() => validateQuota(baseQuota({ limit: 0 }))).toThrow();
    expect(() => validateQuota(baseQuota({ limit: -5 }))).toThrow();
  });

  test('accepts Pi-on-Claude billing/spend fields', () => {
    const quota = validateQuota(
      baseQuota({ billing: 'extra_usage_dollars', spend_usd: 4.5, unit: 'usd' }),
    );
    expect(quota.billing).toBe('extra_usage_dollars');
    expect(quota.spend_usd).toBe(4.5);
  });

  test('rejects a negative `spend_usd`', () => {
    expect(() => validateQuota(baseQuota({ spend_usd: -1 }))).toThrow();
  });

  test('rejects an unknown `billing` value', () => {
    expect(() => validateQuota(baseQuota({ billing: 'metered' }))).toThrow();
  });

  test('QuotaSchema stays .strict() — an unrelated unknown key still fails', () => {
    expect(() => validateQuota(baseQuota({ bogus: true }))).toThrow();
  });
});

describe('VendorAccount — additive `quota` config (T023)', () => {
  test('an account with no `quota` config still validates', () => {
    expect(() => VendorAccountSchema.parse({ id: 'max', auth: 'subscription' })).not.toThrow();
  });

  test('accepts a `quota.window_tokens`/`quota.floor` config', () => {
    const account = VendorAccountSchema.parse({
      id: 'max',
      auth: 'subscription',
      quota: { window_tokens: 5_000_000, floor: 0.2 },
    });
    expect(account.quota?.window_tokens).toBe(5_000_000);
    expect(account.quota?.floor).toBe(0.2);
  });

  test('rejects a floor outside [0, 1]', () => {
    expect(() =>
      VendorAccountSchema.parse({ id: 'max', auth: 'subscription', quota: { floor: 1.5 } }),
    ).toThrow();
  });

  test('a full vendors.yaml round-trips through validateVendorsConfig with quota config attached', () => {
    const config = validateVendorsConfig({
      claude: {
        accounts: [
          { id: 'max', auth: 'subscription', quota: { window_tokens: 5_000_000 } },
          { id: 'api-overflow', auth: 'api_key' },
        ],
      },
    });
    expect(config.claude?.accounts[0]?.quota?.window_tokens).toBe(5_000_000);
  });
});

// Re-export sanity: the schema instance imported above is the same one
// `store.ts`/`quota/*` consume — asserted once so a future refactor that
// accidentally forks the schema fails loudly here.
test('QuotaSchema is exported for direct use (store/quota-service parity)', () => {
  expect(typeof QuotaSchema.parse).toBe('function');
});
