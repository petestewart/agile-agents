import { describe, expect, test } from 'bun:test';
import type { Quota, VendorsConfig } from '@agile-agents/shared';
import { validateQuota, validateVendorsConfig } from '@agile-agents/shared';
import { pickCandidate, routeCandidates } from './routing';

/**
 * `remaining` here is a `0..1` fraction for test-writing convenience —
 * translated into a concrete `unit: 'tokens'` record (`limit: 10_000`,
 * `remaining: fraction * 10_000`) since T023's review fix removed the
 * ambiguous bare "unit: fraction" convention `quotaFraction` used to
 * special-case (a record with no `limit` no longer reads its `remaining`
 * as an already-normalized fraction — see `records.ts`'s `quotaFraction`).
 */
function quota(
  overrides: Partial<Omit<Quota, 'remaining'>> &
    Pick<Quota, 'vendor' | 'account'> & { remaining: number },
): Quota {
  const { remaining: fraction, ...rest } = overrides;
  return validateQuota({
    kind: 'subscription_window',
    unit: 'tokens',
    limit: 10_000,
    confidence: 'estimated',
    source: 'ledger_countdown',
    updated: new Date().toISOString(),
    cooldown_until: null,
    ...rest,
    remaining: Math.round(fraction * 10_000),
  });
}

const twoVendorConfig: VendorsConfig = validateVendorsConfig({
  claude: { accounts: [{ id: 'max', auth: 'subscription' }] },
  openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
});

const singleClaudeConfig: VendorsConfig = validateVendorsConfig({
  claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
});

describe('routeCandidates — default fallback (no routing table)', () => {
  test('with only the single Claude entry configured, that is the only candidate', () => {
    const result = routeCandidates('engineer', 'standard', {
      vendors: singleClaudeConfig,
      quotas: [],
    });
    expect('none' in result).toBe(false);
    if ('none' in result) throw new Error('unreachable');
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });

  test('a never-observed account (no Quota record) is treated as fully available', () => {
    const result = routeCandidates('engineer', 'standard', {
      vendors: twoVendorConfig,
      quotas: [],
    });
    expect('none' in result).toBe(false);
  });
});

describe('routeCandidates — floor filtering', () => {
  test('excludes an account at/below the floor and orders the rest by remaining fraction', () => {
    const quotas = [
      quota({ vendor: 'claude', account: 'max', remaining: 0.1 }), // below default floor 0.15
      quota({ vendor: 'openai', account: 'chatgpt', remaining: 0.6 }),
    ];
    const result = routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas });
    expect(result).toEqual([{ vendor: 'openai', account: 'chatgpt' }]);
  });

  test('acceptance: a simulated exhausted Claude account routes to the next candidate', () => {
    const quotas = [
      quota({ vendor: 'claude', account: 'max', remaining: 0 }),
      quota({ vendor: 'openai', account: 'chatgpt', remaining: 0.9 }),
    ];
    const result = pickCandidate(
      routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas }),
    );
    expect(result).toEqual({ vendor: 'openai', account: 'chatgpt' });
  });

  test('orders multiple eligible candidates by remaining fraction, most headroom first', () => {
    const vendors = validateVendorsConfig({
      claude: { accounts: [{ id: 'max', auth: 'subscription' }] },
      openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
      cursor: { accounts: [{ id: 'main', auth: 'subscription' }] },
    });
    const quotas = [
      quota({ vendor: 'claude', account: 'max', remaining: 0.3 }),
      quota({ vendor: 'openai', account: 'chatgpt', remaining: 0.9 }),
      quota({ vendor: 'cursor', account: 'main', remaining: 0.5 }),
    ];
    const result = routeCandidates('engineer', 'standard', { vendors, quotas });
    expect(result).toEqual([
      { vendor: 'openai', account: 'chatgpt' },
      { vendor: 'cursor', account: 'main' },
      { vendor: 'claude', account: 'max' },
    ]);
  });

  test('a custom floor overrides the default 0.15', () => {
    const quotas = [quota({ vendor: 'claude', account: 'max', remaining: 0.2 })];
    const belowCustomFloor = routeCandidates('engineer', 'standard', {
      vendors: singleClaudeConfig,
      quotas: [quota({ vendor: 'claude', account: 'default', remaining: 0.2 })],
      floor: 0.25,
    });
    expect('none' in belowCustomFloor).toBe(true);
    void quotas;
  });
});

describe('routeCandidates — cooldown', () => {
  test('a 429 event sets cooldown and reroutes away from that account', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const quotas = [
      quota({
        vendor: 'claude',
        account: 'max',
        remaining: 0,
        cooldown_until: new Date(now.getTime() + 60_000).toISOString(),
      }),
      quota({ vendor: 'openai', account: 'chatgpt', remaining: 0.7 }),
    ];
    const result = routeCandidates('engineer', 'standard', {
      vendors: twoVendorConfig,
      quotas,
      now,
    });
    expect(result).toEqual([{ vendor: 'openai', account: 'chatgpt' }]);
  });

  test('QA-fix: a cooldown that has already elapsed no longer excludes the account, even though remaining is still the stale 0 a 429 left behind', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    // This is exactly what `record429` persists — `remaining: 0` alongside
    // `cooldown_until` (§4: "remaining 0 until reset") — not a
    // hand-picked healthy fraction. The bug QA found: once `cooldown_until`
    // elapses, `remaining` is still 0 on disk (nothing has refreshed it
    // yet), so the floor check alone kept excluding the account forever.
    const quotas = [
      quota({
        vendor: 'claude',
        account: 'default',
        remaining: 0, // stale post-429 value; still on disk
        cooldown_until: new Date(now.getTime() - 1_000).toISOString(), // elapsed 1s ago
      }),
    ];
    const result = routeCandidates('engineer', 'standard', {
      vendors: singleClaudeConfig,
      quotas,
      now,
    });
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });
});

describe('routeCandidates — stale resets_at (opus round 3 blocker 1)', () => {
  test('a countdown exhausted with no 429 involved (no cooldown_until ever set) is rescued once resets_at has elapsed, same as the cooldown case', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const quotas = [
      quota({
        vendor: 'claude',
        account: 'default',
        remaining: 0, // countdown-exhausted; no 429/cooldown ever involved
        resets_at: new Date(now.getTime() - 1_000).toISOString(), // elapsed 1s ago
      }),
    ];
    const result = routeCandidates('engineer', 'standard', {
      vendors: singleClaudeConfig,
      quotas,
      now,
    });
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });

  test('a resets_at still in the future does not rescue an exhausted account', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const quotas = [
      quota({
        vendor: 'claude',
        account: 'default',
        remaining: 0,
        resets_at: new Date(now.getTime() + 60_000).toISOString(), // not due yet
      }),
    ];
    const result = routeCandidates('engineer', 'standard', {
      vendors: singleClaudeConfig,
      quotas,
      now,
    });
    expect('none' in result).toBe(true);
  });
});

describe('routeCandidates — no candidate', () => {
  test('every configured candidate below floor or cooling down -> {none: true, reason}', () => {
    const quotas = [
      quota({ vendor: 'claude', account: 'max', remaining: 0.05 }),
      quota({ vendor: 'openai', account: 'chatgpt', remaining: 0 }),
    ];
    const result = routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas });
    expect('none' in result).toBe(true);
    if ('none' in result) expect(result.reason).toContain('standard');
  });

  test('no vendors configured at all -> none', () => {
    const result = routeCandidates('engineer', 'standard', { vendors: {}, quotas: [] });
    expect('none' in result).toBe(true);
  });

  test('pickCandidate passes a RouteNone through unchanged', () => {
    const picked = pickCandidate({ none: true, reason: 'x' });
    expect(picked).toEqual({ none: true, reason: 'x' });
  });
});

describe('routeCandidates — explicit routing table (§11)', () => {
  test('an explicit (role, tier) entry is used instead of enumerating every configured account', () => {
    const vendors = validateVendorsConfig({
      claude: { accounts: [{ id: 'max', auth: 'subscription' }] },
      openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
    });
    const result = routeCandidates('reviewer', 'novel', {
      vendors,
      quotas: [],
      routing: {
        'reviewer:novel': [
          { vendor: 'openai', account: 'chatgpt', model: 'o1', reasoning: 'high' },
        ],
      },
    });
    expect(result).toEqual([
      { vendor: 'openai', account: 'chatgpt', model: 'o1', reasoning: 'high' },
    ]);
  });

  test('falls back to the default enumeration for a (role, tier) not in the routing table', () => {
    const result = routeCandidates('qa', 'trivial', {
      vendors: singleClaudeConfig,
      quotas: [],
      routing: { 'reviewer:novel': [{ vendor: 'openai', account: 'chatgpt' }] },
    });
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });
});
