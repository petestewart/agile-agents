import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerLine, Message } from '@agile-agents/shared';
import { validateAgentRecord, validateLedgerLine, validateQuota } from '@agile-agents/shared';
import { Bus } from '../bus/bus';
import { runInit } from '../init';
import { NotFoundError, StateStore } from '../store/store';
import {
  DEFAULT_QUOTA_FLOOR,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_WINDOW_TOKENS,
  QuotaService,
  quotaFraction,
} from './records';
import { pickCandidate, routeCandidates } from './routing';

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
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** A `QuotaBusSender` that records every sent message into `sink` for assertions. */
function makeFakeBus(sink: Message[]): { send: (input: unknown) => Promise<{ ok: true }> } {
  return {
    send: async (input: unknown) => {
      sink.push(input as Message);
      return { ok: true };
    },
  };
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
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] },
    });
    const quota = new QuotaService({ store });
    const updated = await quota.recordUsage(
      'claude',
      'max',
      ledgerLine({ in_tokens: 400, out_tokens: 0 }),
    );
    expect(updated.limit).toBe(1_000);
    expect(updated.remaining).toBe(600);
    expect(quotaFraction(updated)).toBeCloseTo(0.6);
  });

  test('remaining never goes negative', async () => {
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 100 } }] },
    });
    const quota = new QuotaService({ store });
    const updated = await quota.recordUsage(
      'claude',
      'max',
      ledgerLine({ in_tokens: 1_000, out_tokens: 0 }),
    );
    expect(updated.remaining).toBe(0);
  });
});

describe('QuotaService.recordReported', () => {
  test('a bare fraction reading (no unit) resolves against the account window_tokens and overrides the countdown', async () => {
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] },
    });
    const quota = new QuotaService({ store });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 900, out_tokens: 0 }));
    // Countdown thinks remaining is 100/1000 = 0.10 — a real reading says otherwise.
    const reported = await quota.recordReported('claude', 'max', { remaining: 0.8 });
    expect(reported.confidence).toBe('reported');
    expect(reported.source).toBe('usage_endpoint');
    expect(reported.unit).toBe('tokens');
    expect(reported.limit).toBe(1_000);
    expect(reported.remaining).toBe(800);
    expect(quotaFraction(reported)).toBeCloseTo(0.8);
  });

  test('an absolute reading in a concrete unit is stored as given', async () => {
    const quota = new QuotaService({ store });
    const reported = await quota.recordReported('claude', 'max', {
      remaining: 5_000,
      unit: 'requests',
      limit: 10_000,
    });
    expect(reported.unit).toBe('requests');
    expect(reported.remaining).toBe(5_000);
    expect(reported.limit).toBe(10_000);
  });

  test('a bare fraction with no resolvable limit anywhere is marked low-confidence and never trips exhausted', async () => {
    const quota = new QuotaService({ store, bus: { send: async () => ({ ok: true }) } });
    // No vendors.yaml entry for this account at all — nothing to resolve against.
    const reported = await quota.recordReported('claude', 'ghost', { remaining: 0.02 });
    expect(reported.confidence).toBe('low');
    expect(reported.limit).toBeUndefined();
    expect(quotaFraction(reported)).toBe(1);
  });

  test('Pi-on-Claude extra-usage dollars accrue across calls', async () => {
    const quota = new QuotaService({ store });
    const first = await quota.recordReported(
      'claude',
      'pi',
      { remaining: 1, unit: 'usd' },
      { spendDeltaUsd: 1.25 },
    );
    expect(first.billing).toBe('extra_usage_dollars');
    expect(first.spend_usd).toBe(1.25);
    const second = await quota.recordReported(
      'claude',
      'pi',
      { remaining: 1, unit: 'usd' },
      { spendDeltaUsd: 0.75 },
    );
    expect(second.spend_usd).toBe(2.0);
  });

  test('reproduces and fixes the reviewed unit-inheritance bug: a reported 80%-full reading no longer trips a spurious quota_exhausted on the next countdown decrement', async () => {
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] },
    });
    const sent: Message[] = [];
    const bus = makeFakeBus(sent);
    const quota = new QuotaService({ store, bus });

    // Countdown drives the account down near the floor.
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 950 }));

    // A real reading says the account is actually 80% full (e.g. the window
    // rolled over on the vendor's side) — a bare fraction, no `unit` given.
    await quota.recordReported('claude', 'max', { remaining: 0.8 });
    sent.length = 0; // only the *next* countdown call's behaviour is under test.

    // A small further usage decrement should come off the reported 800/1000
    // baseline, not misread the 0.8 as "0.8 tokens remaining".
    const updated = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 50 }));
    expect(updated.remaining).toBe(750);
    expect(quotaFraction(updated)).toBeCloseTo(0.75);
    expect(sent.some((m) => m.kind === 'quota_exhausted')).toBe(false);
    expect(sent.some((m) => m.kind === 'quota_low')).toBe(false);
  });
});

describe('QuotaService — quota_low / quota_exhausted bus events', () => {
  const sentMessages: Message[] = [];
  const fakeBus = makeFakeBus(sentMessages);

  beforeEach(() => {
    sentMessages.length = 0;
  });

  test('crossing the floor emits exactly one quota_low event + bus message', async () => {
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] },
    });
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
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 100 } }] },
    });
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
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 10 } }] },
    });
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    expect(store.listEvents().some((e) => e.kind === 'quota_exhausted')).toBe(true);
  });
});

describe('QuotaService.record429 — one quota_exhausted per episode, escalating backoff (review fix #5)', () => {
  const sentMessages: Message[] = [];
  const fakeBus = makeFakeBus(sentMessages);

  beforeEach(() => {
    sentMessages.length = 0;
  });

  test('repeated 429s within the same still-active cooldown escalate 30s -> 1m -> 5m -> 15m cap without re-emitting quota_exhausted', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });

    const first = await quota.record429('claude', 'max');
    expect(first.cooldown_backoff_seconds).toBe(30);
    expect(first.cooldown_until).toBe(new Date(clock.now().getTime() + 30_000).toISOString());

    const second = await quota.record429('claude', 'max');
    expect(second.cooldown_backoff_seconds).toBe(60);

    const third = await quota.record429('claude', 'max');
    expect(third.cooldown_backoff_seconds).toBe(300);

    const fourth = await quota.record429('claude', 'max');
    expect(fourth.cooldown_backoff_seconds).toBe(900);

    // Cap: a fifth 429 within the same episode stays at 900, not beyond.
    const fifth = await quota.record429('claude', 'max');
    expect(fifth.cooldown_backoff_seconds).toBe(900);

    const exhausted = sentMessages.filter((m) => m.kind === 'quota_exhausted');
    expect(exhausted).toHaveLength(1); // once per episode, not per call
  });

  test('an explicit retryAfterSeconds always wins over the ladder', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });
    await quota.record429('claude', 'max'); // 30s (ladder default)
    const updated = await quota.record429('claude', 'max', 120); // vendor-provided hint, same episode
    expect(updated.cooldown_backoff_seconds).toBe(120);
  });

  test('round-6 fix: a recordUsage call arriving mid-cooldown does NOT clear it — reset-after-success only applies once the cooldown has actually elapsed', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 1_000 } }] },
    });

    await quota.record429('claude', 'max'); // 30s
    await quota.record429('claude', 'max'); // escalates to 60s

    // A usage call arriving WHILE still cooling down must not clear the
    // cooldown or the escalation tier — the round-5 opus nit this round fixes.
    const midCooldown = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    expect(midCooldown.cooldown_until).not.toBeNull();
    expect(midCooldown.cooldown_backoff_seconds).toBe(60);
    expect(midCooldown.remaining).toBe(0); // still the visible "cooling down" reading

    // Once the cooldown genuinely elapses, a real successful call DOES
    // reset the escalation tier for the next episode.
    clock.advance(61_000);
    const afterCooldown = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    expect(afterCooldown.cooldown_until).toBeNull();
    expect(afterCooldown.cooldown_backoff_seconds).toBeUndefined();

    sentMessages.length = 0;
    const freshEpisode = await quota.record429('claude', 'max');
    expect(freshEpisode.cooldown_backoff_seconds).toBe(30); // back to the first tier, not 300
    expect(sentMessages.filter((m) => m.kind === 'quota_exhausted')).toHaveLength(1); // a fresh episode emits again
  });

  test('a 429 after the previous cooldown has elapsed starts a fresh episode (emits again, restarts the ladder)', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });

    await quota.record429('claude', 'max'); // 30s cooldown, episode #1
    clock.advance(31_000); // cooldown elapses
    sentMessages.length = 0;

    const secondEpisode = await quota.record429('claude', 'max');
    expect(secondEpisode.cooldown_backoff_seconds).toBe(30); // fresh episode, not escalated from the first
    expect(sentMessages.filter((m) => m.kind === 'quota_exhausted')).toHaveLength(1);
  });
});

describe('QuotaService + routeCandidates — end-to-end reroute after a 429 (QA fix)', () => {
  test('a fake clock advancing past cooldown_until re-admits the account to routing without any further write', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });
    await store.putVendors({
      claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
    });

    await quota.record429('claude', 'default', 60);
    const vendors = store.getVendors();

    // Still cooling down: no candidate.
    const stillCoolingDown = routeCandidates('engineer', 'standard', {
      vendors,
      quotas: quota.list(),
      now: clock.now(),
    });
    expect('none' in stillCoolingDown).toBe(true);

    // Advance past the 60s cooldown — no further QuotaService call at all,
    // purely the passage of time — and it should route again.
    clock.advance(61_000);
    const afterCooldown = routeCandidates('engineer', 'standard', {
      vendors,
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(afterCooldown)).toEqual({ vendor: 'claude', account: 'default' });
  });

  test('acceptance scenario end-to-end: exhausted Claude reroutes to a second vendor, then re-admits Claude once its cooldown elapses', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });
    await store.putVendors({
      claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
      openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
    });

    await quota.record429('claude', 'default', 60);
    const routed = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(routed)).toEqual({ vendor: 'openai', account: 'chatgpt' });

    clock.advance(61_000);
    const routedAfter = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    // Both are eligible again; Claude (never actually spent, just cooled down) leads on remaining fraction.
    expect('none' in routedAfter).toBe(false);
    if ('none' in routedAfter) throw new Error('unreachable');
    expect(routedAfter.map((c) => c.account)).toContain('default');
  });

  test('opus round-2 fix: 429 -> cooldown elapses -> one recordUsage call -> the account is still routable afterward', async () => {
    // This is the exact regression: routing's own lazy "cooldown elapsed"
    // rescue (`routing.ts`) only helps until something actually WRITES a
    // fresh record — the first `recordUsage` after re-admission used to
    // carry the stale post-429 `remaining: 0` forward and re-persist it
    // with `cooldown_until: null`, at which point there is no longer a
    // cooldown for routing's lazy rescue to treat as stale, permanently
    // shedding a perfectly healthy account.
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });
    await store.putVendors({
      claude: {
        accounts: [{ id: 'default', auth: 'subscription', quota: { window_tokens: 1_000 } }],
      },
    });

    await quota.record429('claude', 'default', 60);
    clock.advance(61_000); // cooldown elapses

    // The one usage record QA/opus asked for — this is what used to break it.
    const afterUsage = await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 10 }));
    expect(afterUsage.cooldown_until).toBeNull();
    // Restored from the pre-429 full 1000, minus this call's own 10-token
    // decrement — not stuck at 0.
    expect(afterUsage.remaining).toBe(990);

    const routed = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(routed)).toEqual({ vendor: 'claude', account: 'default' });
  });
});

describe('QuotaService — window reset across two windows (review fix #4)', () => {
  const sentMessages: Message[] = [];
  const fakeBus = makeFakeBus(sentMessages);

  beforeEach(() => {
    sentMessages.length = 0;
  });

  test('a window rollover re-arms remaining to full and re-arms the quota_low crossing for the next window', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'max', auth: 'subscription', quota: { window_tokens: 1_000, window_hours: 1 } },
        ],
      },
    });
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now, floor: 0.15 });

    // Window 1: drive it below the floor — one quota_low.
    const first = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 950 }));
    expect(first.remaining).toBe(50);
    expect(first.resets_at).toBe(new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString());
    expect(sentMessages.filter((m) => m.kind === 'quota_low')).toHaveLength(1);

    // Advance past resets_at (61 minutes) — the next call rearms first.
    clock.advance(61 * 60 * 1000);
    const rearmedResetsAt = first.resets_at as string;
    const second = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    // Rearmed to 1000 before this call's own 10-token decrement.
    expect(second.remaining).toBe(990);
    expect(second.resets_at).toBe(
      new Date(Date.parse(rearmedResetsAt) + 60 * 60 * 1000).toISOString(),
    );
    // No new quota_low: rearmed fraction (1.0) then 0.99, never crossed the floor this time.
    expect(sentMessages.filter((m) => m.kind === 'quota_low')).toHaveLength(1);

    // Window 2: drive it below the floor again — the crossing must be able to fire a *second* time.
    const third = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 850 }));
    expect(third.remaining).toBe(140); // 0.14, below the 0.15 floor
    expect(sentMessages.filter((m) => m.kind === 'quota_low')).toHaveLength(2);
  });

  test('round-3 review-fix: with no window_hours configured, resets_at still gets a default cadence (DEFAULT_WINDOW_HOURS) rather than staying null forever', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });
    // No `window_hours` configured — used to leave `resets_at` permanently
    // `null` (a one-shot rearm at best); now it always gets a concrete
    // default cadence so a window-reset backstop always exists.
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription', quota: { window_tokens: 100 } }] },
    });
    const updated = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 10 }));
    expect(updated.resets_at).toBe(
      new Date(clock.now().getTime() + DEFAULT_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
    );
  });

  test('advances resets_at to the first boundary after now, not just one window, after an idle gap longer than one window (opus round 3 blocker 3)', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'max', auth: 'subscription', quota: { window_tokens: 1_000, window_hours: 1 } },
        ],
      },
    });
    const quota = new QuotaService({ store, bus: fakeBus, now: clock.now });

    const first = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 100 }));
    const firstResetsAtMs = Date.parse(first.resets_at as string);
    expect(firstResetsAtMs).toBe(clock.now().getTime() + 60 * 60 * 1000); // T0 + 1h

    // Idle for 5 windows (5h) — old (buggy) behaviour advanced by exactly
    // one window, landing resets_at 4 windows *in the past*, so this write
    // (and every one after it, one window at a time) would spuriously
    // re-arm to full before decrementing, discarding the usage it itself
    // just recorded.
    clock.advance(5 * 60 * 60 * 1000); // now = T0 + 5h
    const second = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 100 }));

    // Rearmed once (1000 - 100 = 900), not left stuck re-arming.
    expect(second.remaining).toBe(900);
    // resets_at lands on the first boundary strictly after `now` (T0+5h),
    // i.e. T0+6h — not T0+2h (one window past the original, still in the past).
    const nowMs = clock.now().getTime();
    const secondResetsAtMs = Date.parse(second.resets_at as string);
    expect(secondResetsAtMs).toBeGreaterThan(nowMs);
    expect(secondResetsAtMs).toBe(firstResetsAtMs + 5 * 60 * 60 * 1000); // T0+1h + 5h = T0+6h

    // The very next call must NOT re-arm again (resets_at is now in the future).
    const third = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 50 }));
    expect(third.remaining).toBe(850); // 900 - 50, not rearmed to 1000 - 50
  });
});

describe('QuotaService — recovery applies on read, not only on write (opus round 3 blocker 1)', () => {
  test('a countdown-exhausted account (no 429 involved) is a routable candidate again once its window elapses, with no intervening write', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'default', auth: 'subscription', quota: { window_tokens: 1_000, window_hours: 1 } },
        ],
      },
    });
    const quota = new QuotaService({ store, now: clock.now });

    // Spend the whole window — the countdown alone exhausts it, no 429 involved.
    await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 1_000 }));
    const exhausted = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect('none' in exhausted).toBe(true);

    // Advance past the window's resets_at — deliberately no further
    // recordUsage/recordReported/record429 call in between, since the
    // whole point is that an excluded account never gets routed a ticket
    // to generate one.
    clock.advance(2 * 60 * 60 * 1000); // 2h > the 1h window

    const stillListedStale = quota.list().find((q) => q.account === 'default');
    // list() itself already reflects the recovery (round-4 fix) — this is
    // the "display no longer disagrees with routing" half of the fix.
    expect(stillListedStale?.remaining).toBe(1_000);

    const recovered = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(recovered)).toEqual({ vendor: 'claude', account: 'default' });
  });

  test('routeCandidates rescues a hand-built Quota with a stale resets_at directly, even bypassing list()', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const vendors = store.getVendors(); // default seed: claude/default
    const staleQuota = validateQuota({
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 0,
      unit: 'tokens',
      limit: 1_000,
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      cooldown_until: null,
      resets_at: new Date(now.getTime() - 1_000).toISOString(), // elapsed 1s ago
    });
    const result = routeCandidates('engineer', 'standard', {
      vendors,
      quotas: [staleQuota],
      now,
    });
    expect(result).toEqual([{ vendor: 'claude', account: 'default' }]);
  });
});

describe('QuotaService — a low-confidence unresolved reading never becomes a countdown baseline (opus round 3 blocker 2)', () => {
  test('an 80%-full account with no vendors.yaml quota config is not declared exhausted by a single token', async () => {
    // Deliberately no `quota` stanza on either account — the state of
    // every account in today's default vendors.yaml.
    await store.putVendors({
      claude: { accounts: [{ id: 'max', auth: 'subscription' }] },
      openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
    });
    const sent: Message[] = [];
    const bus = makeFakeBus(sent);
    const quota = new QuotaService({ store, bus });

    const reported = await quota.recordReported('claude', 'max', { remaining: 0.8 });
    expect(reported.confidence).toBe('low');
    expect(reported.limit).toBeUndefined();

    // A single token must not exhaust an 80%-full account.
    const afterOneToken = await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 1 }));
    expect(afterOneToken.remaining).toBeGreaterThan(0);
    expect(sent.some((m) => m.kind === 'quota_exhausted')).toBe(false);

    const routed = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
    });
    // Still eligible (not excluded as exhausted) — a never-observed second
    // account naturally still leads on remaining fraction (1.0 vs. just
    // under 1.0), which is correct ordering, not the bug under test.
    expect('none' in routed).toBe(false);
    if ('none' in routed) throw new Error('unreachable');
    expect(routed.map((c) => c.account)).toContain('max');
  });
});

describe('QuotaService.record429 — the low-confidence baseline guard also applies to the 429 path (opus round 4 blocker)', () => {
  test('a 429 on an 80%-full low-confidence account, with the shipped default vendors.yaml (no window_tokens), re-admits it fully once the cooldown elapses — not pinned at remaining 0.8 / limit 1e6', async () => {
    // No `store.putVendors` call at all here — this is exactly what
    // `agile init` ships (`init.ts`'s `defaultVendorsConfig`): `claude`
    // with a single `default` account and no `quota` stanza whatsoever.
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const sent: Message[] = [];
    const bus = makeFakeBus(sent);
    const quota = new QuotaService({ store, bus, now: clock.now });

    // An 80%-full reading with nothing to resolve the bare fraction
    // against — the exact low-confidence shape from the previous describe
    // block's test.
    const reported = await quota.recordReported('claude', 'default', { remaining: 0.8 });
    expect(reported.confidence).toBe('low');
    expect(reported.limit).toBeUndefined();

    // A 429 hits the account while it's in this unresolved state.
    const afterFirst429 = await quota.record429('claude', 'default', 30);
    // Round-5 fix: the bare 0.8 must never become `pre_cooldown_remaining`
    // attached to a real `limit` — it must be treated as a fresh full
    // baseline, exactly like `recordUsage` already treats it.
    expect(afterFirst429.pre_cooldown_remaining).toBe(afterFirst429.limit);
    expect(sent.filter((m) => m.kind === 'quota_exhausted')).toHaveLength(1);

    // Still cooling down: excluded from routing.
    const stillCoolingDown = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect('none' in stillCoolingDown).toBe(true);

    // Cooldown elapses — no further write yet (mirrors the read-side
    // recovery this ticket's round 4 fixed).
    clock.advance(31_000);
    const recovered = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    // Must be fully re-admitted — not pinned near-zero by a bogus
    // `remaining: 0.8 / limit: 1_000_000` artifact.
    expect(pickCandidate(recovered)).toEqual({ vendor: 'claude', account: 'default' });

    // And the next real usage call must not emit a second quota_exhausted
    // (the bug: a bogus near-zero record would immediately re-exhaust and
    // pin the account at zero for the rest of the 24h window).
    const afterUsage = await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 10 }));
    expect(afterUsage.remaining).toBeGreaterThan(0);
    expect(sent.filter((m) => m.kind === 'quota_exhausted')).toHaveLength(1); // still just the one, from the 429 itself
  });
});

describe('QuotaService — a window reset must not shorten an in-flight 429 cooldown, but must still rearm the budget underneath (opus round 4 nit + round 6 blocker B1)', () => {
  test('a window boundary landing mid-cooldown leaves cooldown_until/backoff untouched but rearms pre_cooldown_remaining to the fresh window budget', async () => {
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'max', auth: 'subscription', quota: { window_tokens: 1_000, window_hours: 1 } },
        ],
      },
    });
    const quota = new QuotaService({ store, now: clock.now });

    // Establish a resets_at (T0 + 1h) via a normal usage call.
    await quota.recordUsage('claude', 'max', ledgerLine({ in_tokens: 100 }));

    // Advance to 13 minutes before the window boundary, then hit a 429
    // with a 900s (15 min) cooldown — so the cooldown is still active when
    // the window boundary passes underneath it (matching the reviewer's
    // measured repro: re-admission 13 minutes into a 900s cooldown).
    clock.advance(47 * 60 * 1000); // T0 + 47min (13 min before the T0+1h boundary)
    const after429 = await quota.record429('claude', 'max', 900);
    const cooldownUntilMs = Date.parse(after429.cooldown_until as string);

    // Advance past the window boundary (T0+1h) but still inside the 900s
    // cooldown (cooldownUntilMs is T0+47min+900s = T0+62min).
    clock.advance(14 * 60 * 1000); // now = T0 + 61min — past the T0+1h window boundary, before T0+62min
    expect(clock.now().getTime()).toBeGreaterThan(Date.parse('2026-09-09T01:00:00.000Z'));
    expect(clock.now().getTime()).toBeLessThan(cooldownUntilMs);

    // A read (list(), which now runs recovery) must not cancel the
    // still-active cooldown just because the window also rolled over —
    // the cooldown fields are untouched...
    const listed = quota.list().find((q) => q.account === 'max');
    expect(listed?.cooldown_until).toBe(after429.cooldown_until);
    expect(listed?.cooldown_backoff_seconds).toBe(900);
    // ...but round-6 blocker B1: the *budget* underneath must still roll
    // over with the window — the fresh window's full 1000 tokens, not the
    // stale pre-429 balance frozen at the moment of the 429.
    expect(listed?.pre_cooldown_remaining).toBe(1_000);
    expect(listed?.pre_cooldown_remaining).not.toBe(after429.pre_cooldown_remaining);

    // Routing must still exclude it — the cooldown itself was not shortened.
    const stillCoolingDown = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect('none' in stillCoolingDown).toBe(true);
  });
});

describe('QuotaService.recordUsage — arriving mid-cooldown must not clear it or baseline from the synthetic zero (opus round 5 nit 1)', () => {
  test('with the shipped default vendors.yaml (single account, no window_tokens), a recordUsage call during a 429 cooldown keeps the account excluded for the full cooldown, not the whole 24h window', async () => {
    // No `store.putVendors` call at all — this is exactly what `agile
    // init` ships (`init.ts`'s `defaultVendorsConfig`): `claude` with a
    // single `default` account and no `quota` stanza whatsoever, so
    // there is no second candidate for routing to fall back to either.
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    const sent: Message[] = [];
    const bus = makeFakeBus(sent);
    const quota = new QuotaService({ store, bus, now: clock.now });

    // Establish a real countdown baseline first.
    const beforeCooldown = await quota.recordUsage(
      'claude',
      'default',
      ledgerLine({ in_tokens: 10 }),
    );
    const windowTokens = beforeCooldown.limit as number;
    expect(beforeCooldown.remaining).toBe(windowTokens - 10);

    const after429 = await quota.record429('claude', 'default', 60);
    expect(after429.cooldown_until).not.toBeNull();
    expect(after429.pre_cooldown_remaining).toBe(windowTokens - 10);

    // A usage call arrives 5s into the 60s cooldown — this is the bug:
    // the old code baselined from the visible synthetic `remaining: 0`
    // and cleared `cooldown_until` ("reset after a successful call"),
    // pinning the account at 0 for the rest of the 24h default window.
    clock.advance(5_000);
    const midCooldown = await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 10 }));
    expect(midCooldown.cooldown_until).not.toBeNull(); // NOT cleared
    expect(midCooldown.remaining).toBe(0); // still the visible "cooling down" reading
    // The real balance underneath kept decrementing, from the pre-cooldown
    // value — not from 0.
    expect(midCooldown.pre_cooldown_remaining).toBe(windowTokens - 20);

    // Still excluded from routing — the cooldown itself, not a day.
    const stillCoolingDown = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect('none' in stillCoolingDown).toBe(true);

    // Only one quota_exhausted for the whole episode, from the 429 itself
    // — the mid-cooldown recordUsage call must not signal anything new.
    expect(sent.filter((m) => m.kind === 'quota_exhausted')).toHaveLength(1);

    // Once the cooldown *actually* ends (55s later — the original 60s from
    // the 429, not extended by the mid-cooldown call), the account is
    // re-admitted with the correctly-decremented balance — not stuck for
    // the rest of the day.
    clock.advance(56_000); // now = 61s after the 429 — cooldown has elapsed
    const recovered = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(recovered)).toEqual({ vendor: 'claude', account: 'default' });
    const listedAfterRecovery = quota.list().find((q) => q.account === 'default');
    expect(listedAfterRecovery?.remaining).toBe(windowTokens - 20);
  });
});

describe('QuotaService — a window boundary inside an active cooldown must still rearm the budget (opus round 6 blocker B1)', () => {
  test('usage recorded on both sides of a mid-cooldown window rollover lands on the fresh budget minus post-boundary usage, and is routable once the cooldown ends', async () => {
    // Reviewer's exact repro sequence (single-account topology, matching
    // the shipped default's shape, with an explicit short window so the
    // boundary-inside-cooldown scenario is reachable in a fast test):
    // recordUsage(900) at T0 (100 left, resets_at = T0+1h) -> record429
    // (retryAfter 900s) at T0+55m (cooldown ends T0+70m, spanning the
    // T0+1h boundary) -> recordUsage(10) at T0+61m (after the boundary,
    // still mid-cooldown) -> at T0+71m the account must be routable at
    // 1000 - 10 = 990, not stuck at 90 (the round-6 regression: 100 - 10
    // from the stale pre-429 balance, silently discarding the rollover).
    const clock = fakeClock(Date.parse('2026-09-09T00:00:00.000Z'));
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'default', auth: 'subscription', quota: { window_tokens: 1_000, window_hours: 1 } },
        ],
      },
    });
    const quota = new QuotaService({ store, now: clock.now });

    const beforeCooldown = await quota.recordUsage(
      'claude',
      'default',
      ledgerLine({ in_tokens: 900 }),
    );
    expect(beforeCooldown.remaining).toBe(100);
    expect(beforeCooldown.resets_at).toBe(
      new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(),
    );

    clock.advance(55 * 60 * 1000); // T0 + 55min
    const after429 = await quota.record429('claude', 'default', 900); // cooldown ends T0+70min, spans the T0+1h boundary
    expect(after429.pre_cooldown_remaining).toBe(100); // captured pre-429 balance, before any rollover

    clock.advance(6 * 60 * 1000); // T0 + 61min — past the T0+1h boundary, still mid-cooldown (ends T0+70min)
    const midCooldownAfterBoundary = await quota.recordUsage(
      'claude',
      'default',
      ledgerLine({ in_tokens: 10 }),
    );
    // Cooldown untouched by the window rollover (the round-5 property).
    expect(midCooldownAfterBoundary.cooldown_until).toBe(after429.cooldown_until);
    expect(midCooldownAfterBoundary.remaining).toBe(0); // still the visible cooling-down reading
    // The budget rolled over WITH the window: fresh 1000, minus this
    // call's own 10 tokens — not 100 (stale pre-429 balance) minus 10.
    expect(midCooldownAfterBoundary.pre_cooldown_remaining).toBe(990);

    clock.advance(10 * 60 * 1000); // T0 + 71min — cooldown has elapsed (ended T0+70min)
    const listed = quota.list().find((q) => q.account === 'default');
    expect(listed?.remaining).toBe(990);
    expect(listed?.cooldown_until).toBeNull();

    const routed = routeCandidates('engineer', 'standard', {
      vendors: store.getVendors(),
      quotas: quota.list(),
      now: clock.now(),
    });
    expect(pickCandidate(routed)).toEqual({ vendor: 'claude', account: 'default' });
  });
});

describe('QuotaService — real Bus (routing check, not just the injected fake)', () => {
  test('a real Bus accepts the daemon -> em quota_low/quota_exhausted send (checkRoute allows it)', async () => {
    const bus = new Bus(store, stateRoot);
    // eng-1 must be registered for Bus to have an inbox to poll, but the
    // daemon -> em route doesn't require em to be pre-registered.
    const quota = new QuotaService({ store, bus });
    await store.putVendors({
      claude: {
        accounts: [{ id: 'default', auth: 'subscription', quota: { window_tokens: 100 } }],
      },
    });
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
    const entry = listed[0];
    expect(entry).toBeDefined();
    expect(entry?.vendor).toBe('claude');
    expect(entry?.account).toBe('default');
    if (entry) expect(quotaFraction(entry)).toBe(1);
  });

  test('reflects a persisted Quota record once one exists', async () => {
    const quota = new QuotaService({ store });
    await quota.recordUsage('claude', 'default', ledgerLine({ in_tokens: 1_000 }));
    const listed = quota.list();
    expect(listed[0]?.remaining).toBe(DEFAULT_WINDOW_TOKENS - 1_000);
  });
});

describe('QuotaService.barometer', () => {
  test("tokens_per_hour reflects this vendor's registered agents within the window", async () => {
    await store.putAgent(
      'eng-1',
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-x',
        ticket: undefined,
        last_seen: new Date().toISOString(),
      }),
    );
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
    await store.putAgent(
      'eng-1',
      validateAgentRecord({
        vendor: 'openai',
        model: 'gpt',
        ticket: undefined,
        last_seen: new Date().toISOString(),
      }),
    );
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

describe('quotaFraction — fallback chain (review fix #3)', () => {
  test('uses the record limit when present', () => {
    expect(quotaFraction({ remaining: 250, limit: 1_000, unit: 'tokens' })).toBe(0.25);
  });

  test('falls back to a given window-tokens fallback when the record has no limit', () => {
    expect(quotaFraction({ remaining: 250, unit: 'tokens' }, 1_000)).toBe(0.25);
  });

  test('with neither a limit nor a fallback, returns 1 (never reads as exhausted)', () => {
    expect(quotaFraction({ remaining: 0, unit: 'tokens' })).toBe(1);
  });

  test('a non-tokens unit with no limit ignores a tokens-only fallback and returns 1', () => {
    expect(quotaFraction({ remaining: 0, unit: 'usd' }, 1_000)).toBe(1);
  });
});

test('tryGetQuota NotFoundError does not leak past QuotaService (sanity import check)', () => {
  expect(() => store.getQuota('nope', 'nope')).toThrow(NotFoundError);
});

describe('QuotaService — a long-running cooldown (e.g. a manual one) must never be shortened or cleared (T024 round 2 review-fix, opus B4)', () => {
  test('record429 does not shorten a cooldown_until further in the future than its own ladder tier would compute', async () => {
    const clock = fakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });

    // A long cooldown already on record (stands in for a manual
    // `setManualCooldown('claude', 'default', +4h)` — this test only needs
    // the field, not `handoff/cooldown.ts` itself, to stay a pure
    // `quota/**` unit test).
    const fourHoursOut = new Date(clock.now().getTime() + 4 * 3600_000).toISOString();
    await store.putQuota(
      validateQuota({
        vendor: 'claude',
        account: 'default',
        kind: 'subscription_window',
        remaining: 0,
        unit: 'tokens',
        resets_at: null,
        confidence: 'estimated',
        source: 'ledger_countdown',
        updated: clock.now().toISOString(),
        cooldown_until: fourHoursOut,
        limit: 1000,
      }),
    );

    const updated = await quota.record429('claude', 'default');

    expect(updated.cooldown_until).toBe(fourHoursOut); // not the ladder's 30s
  });

  test('record429 still escalates normally when its own ladder tier is later than the existing cooldown', async () => {
    const clock = fakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });

    const first = await quota.record429('claude', 'default'); // +30s
    expect(Date.parse(first.cooldown_until as string) - clock.now().getTime()).toBe(30_000);

    clock.advance(1_000); // still within the 30s cooldown -> same episode
    const second = await quota.record429('claude', 'default'); // ladder -> +60s from *now*

    expect(Date.parse(second.cooldown_until as string)).toBeGreaterThan(
      Date.parse(first.cooldown_until as string),
    );
  });

  test('recordReported does not clear or shorten an active cooldown_until', async () => {
    const clock = fakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });

    const fourHoursOut = new Date(clock.now().getTime() + 4 * 3600_000).toISOString();
    await store.putQuota(
      validateQuota({
        vendor: 'claude',
        account: 'default',
        kind: 'subscription_window',
        remaining: 0,
        unit: 'tokens',
        resets_at: null,
        confidence: 'estimated',
        source: 'ledger_countdown',
        updated: clock.now().toISOString(),
        cooldown_until: fourHoursOut,
        limit: 1000,
      }),
    );

    const updated = await quota.recordReported('claude', 'default', { remaining: 0.9 });

    expect(updated.cooldown_until).toBe(fourHoursOut); // still cooling down
    // Routing still excludes the account purely on `cooldown_until`,
    // independent of the (now much healthier-looking) `remaining` reading.
    const result = routeCandidates('engineer', 'standard', {
      vendors: { claude: { accounts: [{ id: 'default', auth: 'subscription' }] } } as never,
      quotas: [updated],
      now: clock.now(),
    });
    expect('none' in result).toBe(true);
  });

  test('recordReported refreshes pre_cooldown_remaining so recovery restores an up-to-date balance, not a stale pre-cooldown snapshot', async () => {
    const clock = fakeClock(Date.parse('2026-01-01T00:00:00.000Z'));
    const quota = new QuotaService({ store, now: clock.now });

    await quota.record429('claude', 'default'); // pre_cooldown_remaining <- full window
    await quota.recordReported('claude', 'default', {
      remaining: 400,
      unit: 'tokens',
      limit: 1000,
    });

    clock.advance(31_000); // past the 30s ladder cooldown
    const recovered = await quota.recordUsage(
      'claude',
      'default',
      ledgerLine({ in_tokens: 0, out_tokens: 0 }),
    );

    expect(recovered.remaining).toBe(400); // the reported balance, not the stale full-window one
  });
});
