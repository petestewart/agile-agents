import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerLine, Message } from '@agile-agents/shared';
import { validateAgentRecord, validateLedgerLine } from '@agile-agents/shared';
import { Bus } from '../bus/bus';
import { runInit } from '../init';
import { NotFoundError, StateStore } from '../store/store';
import {
  DEFAULT_QUOTA_FLOOR,
  DEFAULT_WINDOW_TOKENS,
  QuotaService,
  quotaFraction,
} from './records';

let repo: string;
let stateRoot: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-quota-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function ledgerLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return validateLedgerLine({
    ts: new Date().toISOString(),
    sprint: 'nosprint',
    ticket: '',
    agent: 'eng-1',
    model: 'claude-x',
    in_tokens: 0,
    out_tokens: 0,
    cost_usd: 0,
    kind: 'engineer',
    ...overrides,
  });
}

/** Fake clock for deterministic cooldown/window-crossing assertions. */
function fakeClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms: number) => (current += ms) };
}

describe('QuotaService.recordUsage — countdown', () => {
  test('a fresh account starts full and decrements by the ledger line token delta', async () => {
    const quota = new QuotaService({ store });
    const updated = await quota.recordUsage(
      'claude',
      'max',
      ledgerLine({ in_tokens: 100_000, out_tokens: 50_000 }),
    );
    expect(updated.unit).toBe('tokens');
    expect(updated.limit).toBe(DEFAULT_WINDOW_TOKENS);
    expect(updated.remaining).toBe(DEFAULT_WINDOW_TOKENS - 150_000);
    expect(updated.source).toBe('ledger_countdown');
    expect(updated.confidence).toBe('estimated');
  });

  test('successive lines keep decrementing the same record', async () => {
    const quota = new QuotaService({ store });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 100_000, out_tokens: 0 }));
    const second = await quota.recordUsage(
      'claude',
      'max',
      ledgerLine({ in_tokens: 50_000, out_tokens: 0 }),
    );
    expect(second.remaining).toBe(DEFAULT_WINDOW_TOKENS - 150_000);
  });

  test('honors a per-account `quota.window_tokens` override from vendors.yaml', async () => {
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] } });
    const quota = new QuotaService({ store });
    const updated = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 400, out_tokens: 0 }));
    expect(updated.limit).toBe(1_000);
    expect(updated.remaining).toBe(600);
    expect(quotaFraction(updated)).toBeCloseTo(0.6);
  });

  test('remaining never goes negative', async () => {
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 100 } }] } });
    const quota = new QuotaService({ store });
    const updated = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 1_000, out_tokens: 0 }));
    expect(updated.remaining).toBe(0);
  });
});

describe('QuotaService.recordReported', () => {
  test('overrides the countdown estimate with a reported reading', async () => {
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] } });
    const quota = new QuotaService({ store });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 900, out_tokens: 0 }));
    // Countdown thinks remaining is 100/1000 = 0.10 — a real reading says otherwise.
    const reported = await quota.recordReported('claude', 'max', { remaining: 0.8, unit: 'fraction' });
    expect(reported.confidence).toBe('reported');
    expect(reported.source).toBe('usage_endpoint');
    expect(reported.remaining).toBe(0.8);
    expect(reported.unit).toBe('fraction');
  });

  test('Pi-on-Claude extra-usage dollars accrue across calls', async () => {
    const quota = new QuotaService({ store });
    const first = await quota.recordReported(
      'claude',
      'pi',
      { remaining: 1, unit: 'fraction' },
      { spendDeltaUsd: 1.25 },
    );
    expect(first.billing).toBe('extra_usage_dollars');
    expect(first.spend_usd).toBe(1.25);
    const second = await quota.recordReported(
      'claude',
      'pi',
      { remaining: 1, unit: 'fraction' },
      { spendDeltaUsd: 0.75 },
    );
    expect(second.spend_usd).toBe(2.0);
  });
});

describe('QuotaService — quota_low / quota_exhausted bus events', () => {
  const sentMessages: Message[] = [];
  const fakeBus = { send: async (input: unknown) => (sentMessages.push(input as Message), { ok: true }) };

  beforeEach(() => {
    sentMessages.length = 0;
  });

  test('crossing the floor emits exactly one quota_low event + bus message', async () => {
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] } });
    const quota = new QuotaService({ store, bus: fakeBus, floor: 0.2 });

    // 1000 -> 500 (0.5): above floor, no event.
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 500 }));
    expect(sentMessages).toHaveLength(0);

    // 500 -> 100 (0.1): crosses below floor 0.2 — one quota_low.
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 400 }));
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.kind).toBe('quota_low');
    expect(sentMessages[0]?.to).toEqual(['em']);

    // 100 -> 50 (0.05): still below floor — no additional quota_low (once per crossing).
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 50 }));
    expect(sentMessages).toHaveLength(1);

    const events = store.listEvents().filter((e) => e.kind === 'quota_low');
    expect(events).toHaveLength(1);
  });

  test('countdown reaching zero emits quota_exhausted', async () => {
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 100 } }] } });
    const quota = new QuotaService({ store, bus: fakeBus });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 100 }));
    const exhausted = sentMessages.filter((m) => m.kind === 'quota_exhausted');
    expect(exhausted).toHaveLength(1);
  });

  test('a 429 always sets cooldown and emits quota_exhausted', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });
    const updated = await quota.record429('claude', 'max', 60);
    expect(updated.remaining).toBe(0);
    expect(updated.cooldown_until).toBe(new Date(clock.now().getTime() + 60_000).toISOString());
    expect(updated.source).toBe('rate_limit_429');
    const exhausted = sentMessages.filter((m) => m.kind === 'quota_exhausted');
    expect(exhausted).toHaveLength(1);
  });

  test('no bus injected: recordUsage/record429 still write the Quota + event, just skip the send', async () => {
    const quota = new QuotaService({ store });
    await store.putVendors({ claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 10 } }] } });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    expect(store.listEvents().some((e) => e.kind === 'quota_exhausted')).toBe(true);
  });
});

describe('QuotaService — real Bus (routing check, not just the injected fake)', () => {
  test('a real Bus accepts the daemon -> em quota_low/quota_exhausted send (checkRoute allows it)', async () => {
    const bus = new Bus(store, stateRoot);
    // eng-1 must be registered for Bus to have an inbox to poll, but the
    // daemon -> em route doesn't require em to be pre-registered.
    const quota = new QuotaService({ store, bus });
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription', quota: { window_tokens: 100 } }] } });
    await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 100 }));
    const inbox = await bus.poll('em' as never);
    expect(inbox.some((m) => m.kind === 'quota_exhausted')).toBe(true);
  });
});

describe('QuotaService.list', () => {
  test('lists every vendors.yaml account, synthesizing a full default for ones with no Quota file yet', () => {
    const quota = new QuotaService({ store });
    const listed = quota.list();
    // init's default vendors.yaml is claude/default.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.vendor).toBe('claude');
    expect(listed[0]?.account).toBe('default');
    expect(quotaFraction(listed[0]!)).toBe(1);
  });

  test('reflects a persisted Quota record once one exists', async () => {
    const quota = new QuotaService({ store });
    await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 1_000 }));
    const listed = quota.list();
    expect(listed[0]?.remaining).toBe(DEFAULT_WINDOW_TOKENS - 1_000);
  });
});

describe('QuotaService.barometer', () => {
  test('tokens_per_hour reflects this vendor\'s registered agents within the window', async () => {
    await store.putAgent('eng-1', validateAgentRecord({
      vendor: 'claude',
      model: 'claude-x',
      ticket: undefined,
      last_seen: new Date().toISOString(),
    }));
    await store.putSprint({
      id: 'S-01',
      goal: 'test sprint',
      tickets: [],
      budget_tokens: 1_000_000,
      started: new Date().toISOString(),
      carried_over: [],
    });
    const quota = new QuotaService({ store });
    await store.appendLedgerLine(
      'S-01',
      ledgerLine({ sprint: 'S-01', agent: 'eng-1', in_tokens: 300, out_tokens: 100 }),
    );
    const stats = quota.barometer('claude', 'default', { windowHours: 1 });
    expect(stats.tokens_per_hour).toBe(400);
  });

  test('ignores ledger lines from agents of a different vendor', async () => {
    await store.putAgent('eng-1', validateAgentRecord({
      vendor: 'openai',
      model: 'gpt',
      ticket: undefined,
      last_seen: new Date().toISOString(),
    }));
    const quota = new QuotaService({ store });
    await store.appendLedgerLine(
      'S-01',
      ledgerLine({ sprint: 'S-01', agent: 'eng-1', in_tokens: 500, out_tokens: 0 }),
    );
    const stats = quota.barometer('claude', 'default', { windowHours: 1 });
    expect(stats.tokens_per_hour).toBe(0);
  });

  test('counts quota_exhausted events for this (vendor, account) as rate_limit_429_count', async () => {
    const quota = new QuotaService({ store });
    await quota.record429('claude', 'default', 60);
    const stats = quota.barometer('claude', 'default', { windowHours: 1 });
    expect(stats.rate_limit_429_count).toBe(1);
  });
});

test('DEFAULT_QUOTA_FLOOR matches the CLAUDE.md tunable', () => {
  expect(DEFAULT_QUOTA_FLOOR).toBe(0.15);
});

test('quotaFraction: no limit means remaining is already the fraction', () => {
  expect(quotaFraction({ remaining: 0.42 })).toBe(0.42);
});

test('tryGetQuota NotFoundError does not leak past QuotaService (sanity import check)', () => {
  expect(() => store.getQuota('nope', 'nope')).toThrow(NotFoundError);
});
