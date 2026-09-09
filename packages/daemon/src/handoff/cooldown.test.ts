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

  test('B3 (round 2 review-fix): emits a quota_exhausted event, the same shape HandoffCoordinator.tick() reads', async () => {
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();

    await setManualCooldown(fx.store, { vendor: 'claude', account: 'default', until });

    const events = fx.store.listEvents().filter((e) => e.kind === 'quota_exhausted');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ vendor: 'claude', account: 'default' });
  });

  test('B3: also sends the urgent bus message when a bus is given', async () => {
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const sent: unknown[] = [];
    const fakeBus = {
      send: async (input: unknown) => {
        sent.push(input);
        return { ok: true as const };
      },
    };
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();

    await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until,
      bus: fakeBus,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'quota_exhausted', priority: 'urgent', to: ['em'] });
  });

  test('N-c (round 3 review-fix): extending an already-active cooldown does not emit a duplicate event or bus message', async () => {
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const sent: unknown[] = [];
    const fakeBus = {
      send: async (input: unknown) => {
        sent.push(input);
        return { ok: true as const };
      },
    };
    const firstUntil = new Date(Date.now() + 4 * 3600_000).toISOString();
    const extendedUntil = new Date(Date.now() + 8 * 3600_000).toISOString();

    await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until: firstUntil,
      bus: fakeBus,
    });
    const extended = await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until: extendedUntil,
      bus: fakeBus,
    });

    // The write itself still takes effect (the account really is now
    // cooling down until the later timestamp) — only the signal is deduped.
    expect(extended.cooldown_until).toBe(extendedUntil);
    const events = fx.store.listEvents().filter((e) => e.kind === 'quota_exhausted');
    expect(events).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test('N-d (round 3 review-fix): a fresh manual cooldown carries the ladder ceiling tier, not undefined', async () => {
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();

    const quota = await setManualCooldown(fx.store, {
      vendor: 'claude',
      account: 'default',
      until,
    });

    expect(quota.cooldown_backoff_seconds).toBe(900);
  });
});
