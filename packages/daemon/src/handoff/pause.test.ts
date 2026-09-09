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

  test('resumes a paused ticket once resume_at has arrived, clearing the field', async () => {
    const { store } = fx;
    const past = new Date(Date.now() - 1000).toISOString();
    let ticket = makeTicket('TKT-0003' as TicketId, { status: 'ready', resume_at: past });
    ticket = await store.putTicket(ticket);
    ticket = await store.transitionTicket(ticket.id, 'paused', { by: 'daemon' });

    const result = await resumeDueTickets(store);

    expect(result.resumed).toEqual([ticket.id]);
    const updated = store.getTicket(ticket.id);
    expect(updated.status).toBe('ready');
    expect(updated.resume_at).toBeUndefined();
  });

  test('leaves a paused ticket alone before its resume_at arrives', async () => {
    const { store } = fx;
    const future = new Date(Date.now() + 3600_000).toISOString();
    let ticket = makeTicket('TKT-0004' as TicketId, { status: 'ready', resume_at: future });
    ticket = await store.putTicket(ticket);
    await store.transitionTicket(ticket.id, 'paused', { by: 'daemon' });

    const result = await resumeDueTickets(store);

    expect(result.resumed).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('paused');
  });
});
