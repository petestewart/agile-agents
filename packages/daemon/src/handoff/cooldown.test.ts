import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { routeCandidates } from '../quota/routing';
import { CooldownError, setManualCooldown } from './cooldown';
import { type HandoffFixture, makeHandoffFixture } from './test-helpers';

describe('setManualCooldown', () => {
  let fx: HandoffFixture;

  beforeEach(() => {
    fx = makeHandoffFixture();
  });

  afterEach(() => fx.cleanup());

  test('rejects an invalid timestamp', async () => {
    await expect(
      setManualCooldown(fx.store, { vendor: 'claude', account: 'default', until: 'not-a-date' }),
    ).rejects.toBeInstanceOf(CooldownError);
  });

  test('synthesizes a record when none exists yet, and excludes the account from routing', async () => {
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();

    const quota = await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until,
    });
    expect(quota.cooldown_until).toBe(until);

    const result = routeCandidates('engineer', 'standard', {
      vendors: fx.store.getVendors(),
      quotas: [quota],
    });
    expect('none' in result).toBe(true);
  });

  test('extends an existing record, preserving its pre-cooldown remaining', async () => {
    await fx.store.putQuota({
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 800,
      unit: 'tokens',
      resets_at: null,
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: new Date().toISOString(),
      cooldown_until: null,
      limit: 1000,
    });
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();

    const quota = await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until,
    });

    expect(quota.remaining).toBe(0);
    expect(quota.pre_cooldown_remaining).toBe(800);
    expect(quota.limit).toBe(1000);
  });
});
