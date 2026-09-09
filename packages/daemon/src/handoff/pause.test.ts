import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TicketId } from '@agile-agents/shared';
import { QuotaService } from '../quota/records';
import { pauseStuckReadyTickets, resumeDueTickets } from './pause';
import { type HandoffFixture, makeHandoffFixture, makeTicket } from './test-helpers';

describe('pauseStuckReadyTickets / resumeDueTickets', () => {
  let fx: HandoffFixture;

  beforeEach(() => {
    fx = makeHandoffFixture();
  });

  afterEach(() => fx.cleanup());

  test('pauses a ready ticket with no candidate above the floor, setting resume_at', async () => {
    const { store } = fx;
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await store.putQuota({
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 0,
      unit: 'tokens',
      resets_at: resetsAt,
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: new Date().toISOString(),
      cooldown_until: null,
      limit: 1000,
    });
    const ticket = makeTicket('TKT-0001' as TicketId, { status: 'ready' });
    await store.putTicket(ticket);

    const quota = new QuotaService({ store });
    const result = await pauseStuckReadyTickets([ticket.id], { store, quota });

    expect(result.paused).toEqual([ticket.id]);
    const updated = store.getTicket(ticket.id);
    expect(updated.status).toBe('paused');
    expect(updated.resume_at).toBe(resetsAt);
  });

  test('leaves a ready ticket alone when a candidate is above the floor', async () => {
    const { store } = fx;
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const ticket = makeTicket('TKT-0002' as TicketId, { status: 'ready' });
    await store.putTicket(ticket);

    const quota = new QuotaService({ store });
    const result = await pauseStuckReadyTickets([ticket.id], { store, quota });

    expect(result.paused).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('ready');
  });

  test('resumes a paused ticket once resume_at has arrived and the account is actually routable, clearing the field', async () => {
    const { store } = fx;
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const past = new Date(Date.now() - 1000).toISOString();
    let ticket = makeTicket('TKT-0003' as TicketId, { status: 'ready', resume_at: past });
    ticket = await store.putTicket(ticket);
    ticket = await store.transitionTicket(ticket.id, 'paused', { by: 'daemon' });

    const quota = new QuotaService({ store });
    const result = await resumeDueTickets({ store, quota });

    expect(result.resumed).toEqual([ticket.id]);
    const updated = store.getTicket(ticket.id);
    expect(updated.status).toBe('ready');
    expect(updated.resume_at).toBeUndefined();
  });

  test('leaves a paused ticket alone before its resume_at arrives', async () => {
    const { store } = fx;
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const future = new Date(Date.now() + 3600_000).toISOString();
    let ticket = makeTicket('TKT-0004' as TicketId, { status: 'ready', resume_at: future });
    ticket = await store.putTicket(ticket);
    await store.transitionTicket(ticket.id, 'paused', { by: 'daemon' });

    const quota = new QuotaService({ store });
    const result = await resumeDueTickets({ store, quota });

    expect(result.resumed).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('paused');
  });
});

describe('resume_at / resumability — round 3 review-fix (opus blocker 1)', () => {
  let fx: HandoffFixture;

  beforeEach(async () => {
    fx = makeHandoffFixture();
    // The shipped Claude-only single-account shape (CLAUDE.md "v0 defaults").
    await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
  });

  afterEach(() => fx.cleanup());

  test('a 30s 429 on a single account resumes in ~30s, not at the ~24h window resets_at', async () => {
    const { store, bus } = fx;
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(now);

    const quota = new QuotaService({ store, bus, now: clock });
    await quota.record429('claude', 'default'); // cooldown_until = +30s; resets_at ~ +24h (default window)

    const ticket = await store.putTicket(makeTicket('TKT-0100' as TicketId, { status: 'ready' }));

    const paused = await pauseStuckReadyTickets([ticket.id], { store, quota, now: clock });
    expect(paused.paused).toEqual([ticket.id]);
    const afterPause = store.getTicket(ticket.id);
    expect(afterPause.status).toBe('paused');
    const resumeAtMs = Date.parse(afterPause.resume_at as string);
    // Must track the 30s cooldown, not the ~24h resets_at.
    expect(resumeAtMs - now).toBeLessThan(60_000);
    expect(resumeAtMs - now).toBeGreaterThanOrEqual(30_000);

    // 90s later — 60s after the account is routable again.
    now += 90_000;
    const tooEarlyCheck = await resumeDueTickets({ store, quota, now: clock });
    expect(tooEarlyCheck.resumed).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).status).toBe('ready');
  });

  test('a 4h manual cooldown does not resume early at an unrelated resets_at, and does not flap', async () => {
    const { store } = fx;
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(now);
    const quota = new QuotaService({ store, now: clock });

    const fourHoursOut = new Date(now + 4 * 3600_000).toISOString();
    // Stands in for `handoff/cooldown.ts`'s `setManualCooldown` (a pure
    // `quota/**` unit here — see `cooldown.test.ts` for the module itself).
    await store.putQuota({
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 0,
      unit: 'tokens',
      // An unrelated, much-sooner window reset — the exact shape that used
      // to cause the flap (round 1/2 picked this up as "the" resume time).
      resets_at: new Date(now + 3600_000).toISOString(),
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: new Date(now).toISOString(),
      cooldown_until: fourHoursOut,
      limit: 1000,
    });

    const ticket = await store.putTicket(makeTicket('TKT-0101' as TicketId, { status: 'ready' }));
    const paused = await pauseStuckReadyTickets([ticket.id], { store, quota, now: clock });
    expect(paused.paused).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).resume_at).toBe(fourHoursOut);

    // At the unrelated 1h resets_at: must NOT resume (still manually
    // cooling down) and must NOT flap to `ready`.
    now += 3600_000 + 1000;
    const atResetsAt = await resumeDueTickets({ store, quota, now: clock });
    expect(atResetsAt.resumed).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('paused');

    // A pause pass at the same instant must not re-pause something that
    // was never resumed in the first place (no observable flap either way).
    const rePause = await pauseStuckReadyTickets([ticket.id], { store, quota, now: clock });
    expect(rePause.paused).toEqual([]); // already paused, untouched

    // Past the real 4h manual expiry: now routable, resumes for real.
    now = Date.parse(fourHoursOut) + 1000;
    const atRealExpiry = await resumeDueTickets({ store, quota, now: clock });
    expect(atRealExpiry.resumed).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).status).toBe('ready');
  });

  test('a countdown-only pause (no cooldown) resumes at resets_at, computed over the routed candidate only', async () => {
    const { store } = fx;
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(now);
    const quota = new QuotaService({ store, now: clock });

    const resetsAt = new Date(now + 2 * 3600_000).toISOString();
    await store.putQuota({
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 0, // below the floor purely via countdown — no cooldown at all
      unit: 'tokens',
      resets_at: resetsAt,
      confidence: 'estimated',
      source: 'ledger_countdown',
      updated: new Date(now).toISOString(),
      cooldown_until: null,
      limit: 1000,
    });

    const ticket = await store.putTicket(makeTicket('TKT-0102' as TicketId, { status: 'ready' }));
    const paused = await pauseStuckReadyTickets([ticket.id], { store, quota, now: clock });
    expect(paused.paused).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).resume_at).toBe(resetsAt);

    // Before resets_at: still paused.
    now += 3600_000;
    const early = await resumeDueTickets({ store, quota, now: clock });
    expect(early.resumed).toEqual([]);

    // At/after resets_at, the window has rolled over (rearmed on read via
    // `QuotaService.list()`'s own recovery) -> routable again.
    now = Date.parse(resetsAt) + 1000;
    const onTime = await resumeDueTickets({ store, quota, now: clock });
    expect(onTime.resumed).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).status).toBe('ready');
  });
});
