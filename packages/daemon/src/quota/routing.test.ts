import { describe, expect, test } from 'bun:test';
import type { Quota, VendorsConfig } from '@agile-agents/shared';
import { validateQuota, validateVendorsConfig } from '@agile-agents/shared';
import { pickCandidate, routeCandidates } from './routing';

function quota(overrides: Partial<Quota> & Pick<Quota, 'vendor' | 'account' | 'remaining'>): Quota {
  return validateQuota({
    kind: 'subscription_window',
    unit: 'fraction',
    confidence: 'estimated',
    source: 'ledger_countdown',
    updated: new Date().toISOString(),
    cooldown_until: null,
    ...overrides,
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
    const result = routeCandidates('engineer', 'standard', { vendors: singleClaudeConfig, quotas: [] });
    expect('none' in result).toBe(false);
    if ('none' in result) throw new Error('unreachable');
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });

  test('a never-observed account (no Quota record) is treated as fully available', () => {
    const result = routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas: [] });
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
    const result = pickCandidate(routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas }));
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
    const result = routeCandidates('engineer', 'standard', { vendors: twoVendorConfig, quotas, now });
    expect(result).toEqual([{ vendor: 'openai', account: 'chatgpt' }]);
  });

  test('a cooldown that has already elapsed no longer excludes the account', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const quotas = [
      quota({
        vendor: 'claude',
        account: 'default',
        remaining: 0.9,
        cooldown_until: new Date(now.getTime() - 1_000).toISOString(),
      }),
    ];
    const result = routeCandidates('engineer', 'standard', { vendors: singleClaudeConfig, quotas, now });
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
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
        'reviewer:novel': [{ vendor: 'openai', account: 'chatgpt', model: 'o1', reasoning: 'high' }],
      },
    });
    expect(result).toEqual([{ vendor: 'openai', account: 'chatgpt', model: 'o1', reasoning: 'high' }]);
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
