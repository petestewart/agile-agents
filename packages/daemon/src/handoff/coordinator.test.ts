import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TicketId } from '@agile-agents/shared';
import { validateLedgerLine } from '@agile-agents/shared';
import { QuotaService } from '../quota/records';
import type { RoutingTable } from '../quota/routing';
import { buildEvent } from '../store';
import { DEFAULT_GRACE_MS, HandoffCoordinator } from './coordinator';
import {
  type HandoffFixture,
  fakeHandoffRunner,
  makeHandoffFixture,
  makeTicket,
} from './test-helpers';

const ROUTING: RoutingTable = {
  'engineer:standard': [
    { vendor: 'claude', account: 'default' },
    { vendor: 'pi', account: 'pi-on-claude-max', model: 'glm-5.3' },
  ],
};

async function seedVendorsAndQuota(fx: HandoffFixture): Promise<void> {
  await fx.store.putVendors({
    claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
    pi: { accounts: [{ id: 'pi-on-claude-max', auth: 'subscription' }] },
  });
  const now = new Date().toISOString();
  // Both start fully available.
  await fx.store.putQuota({
    vendor: 'claude',
    account: 'default',
    kind: 'subscription_window',
    remaining: 1000,
    unit: 'tokens',
    resets_at: new Date(Date.now() + 3600_000).toISOString(),
    confidence: 'estimated',
    source: 'ledger_countdown',
    updated: now,
    cooldown_until: null,
    limit: 1000,
  });
  await fx.store.putQuota({
    vendor: 'pi',
    account: 'pi-on-claude-max',
    kind: 'subscription_window',
    remaining: 1000,
    unit: 'tokens',
    resets_at: new Date(Date.now() + 3600_000).toISOString(),
    confidence: 'estimated',
    source: 'ledger_countdown',
    updated: now,
    cooldown_until: null,
    limit: 1000,
  });
}

describe('HandoffCoordinator — graceful handoff (offline, fake ACP agent)', () => {
  let fx: HandoffFixture;

  beforeEach(async () => {
    fx = makeHandoffFixture();
    await seedVendorsAndQuota(fx);
  });

  afterEach(() => fx.cleanup());

  test('a ticket started on claude finishes on pi after a simulated quota_low, handoff stanza in the thread, both vendors in the ledger', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0010' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);

    const spawned = await runner.spawn('engineer', ticket.id);
    expect(store.getTicket(ticket.id).status).toBe('in_progress');

    // Claude-side usage before the handoff.
    await store.appendLedgerLine(
      'nosprint',
      validateLedgerLine({
        ts: new Date().toISOString(),
        sprint: 'nosprint',
        ticket: ticket.id,
        agent: spawned.agentId,
        model: 'claude-sonnet',
        in_tokens: 500,
        out_tokens: 0,
        cost_usd: 0,
        kind: 'engineer',
      }),
    );

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
    });

    // Simulated quota_low on the running account (T024's "verify-before-build"
    // offline substitute for a real 429/usage crossing — see the pipeline
    // report).
    await store.appendEvent(
      buildEvent('quota_low', { data: { vendor: 'claude', account: 'default', remaining: 0.1 } }),
    );

    const first = await coordinator.tick([ticket.id]);
    expect(first.gracefulStarted).toEqual([ticket.id]);

    // The urgent instruction landed in the engineer's inbox.
    const inbox = bus.poll(spawned.agentId, { priority: 'urgent' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toContain('handoff stanza');
    expect(store.getTicket(ticket.id).status).toBe('in_progress'); // not stopped yet — waiting on compliance/deadline

    // Engineer complies: writes the handoff stanza and (per instruction) has
    // committed its WIP.
    await store.appendStanza({
      ts: new Date().toISOString(),
      ticket: ticket.id,
      agent: spawned.agentId,
      kind: 'handoff',
      summary: 'handing off before quota runs out',
      handoff: {
        done: 'wired the happy path',
        next: 'add the error path',
        uncommitted_state: 'clean — committed',
      },
    });

    const second = await coordinator.tick([ticket.id]);
    expect(second.compliedAndReassigned).toEqual([ticket.id]);

    const reassigned = store.getTicket(ticket.id);
    expect(reassigned.status).toBe('in_progress');
    expect(reassigned.routing?.vendor).toBe('pi');
    expect(reassigned.routing?.account).toBe('pi-on-claude-max');
    expect(reassigned.assignee).toBe(spawned.agentId); // same agent id — role+ticket-digits scheme

    // The handoff stanza is on the thread (board).
    const stanzas = store.listStanzas(ticket.id);
    expect(stanzas.some((s) => s.kind === 'handoff')).toBe(true);

    // Pi-side usage after the handoff.
    await store.appendLedgerLine(
      'nosprint',
      validateLedgerLine({
        ts: new Date().toISOString(),
        sprint: 'nosprint',
        ticket: ticket.id,
        agent: spawned.agentId,
        model: 'glm-5.3',
        in_tokens: 300,
        out_tokens: 0,
        cost_usd: 0,
        kind: 'engineer',
      }),
    );

    // Ledger carries both vendors' cells for the same ticket.
    const ledger = store.listLedger('nosprint').filter((l) => l.ticket === ticket.id);
    const models = new Set(ledger.map((l) => l.model));
    expect(models).toEqual(new Set(['claude-sonnet', 'glm-5.3']));
  });

  test('an unheeded graceful instruction escalates to a daemon-composed hard handoff past its deadline', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0011' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    let now = Date.now();
    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
      graceMs: 1000,
      now: () => new Date(now),
    });

    await store.appendEvent(
      buildEvent('quota_low', { data: { vendor: 'claude', account: 'default', remaining: 0.1 } }),
    );
    const first = await coordinator.tick([ticket.id]);
    expect(first.gracefulStarted).toEqual([ticket.id]);

    // No compliance — advance the fake clock past the deadline.
    now += DEFAULT_GRACE_MS === 1000 ? 1500 : 1500; // graceMs=1000 above regardless
    const second = await coordinator.tick([ticket.id]);
    expect(second.hardHandoffs).toEqual([ticket.id]);

    const stanzas = store.listStanzas(ticket.id);
    const handoffStanza = stanzas.find((s) => s.kind === 'handoff');
    expect(handoffStanza).toBeDefined();
    expect(handoffStanza?.agent).toBe('daemon');

    const reassigned = store.getTicket(ticket.id);
    expect(reassigned.routing?.vendor).toBe('pi');
    expect(reassigned.assignee).toBe(spawned.agentId);
  });

  test('quota_exhausted goes straight to a hard handoff, no graceful instruction', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0012' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
    });

    await store.appendEvent(
      buildEvent('quota_exhausted', {
        data: { vendor: 'claude', account: 'default', remaining: 0 },
      }),
    );
    const result = await coordinator.tick([ticket.id]);

    expect(result.gracefulStarted).toEqual([]);
    expect(result.hardHandoffs).toEqual([ticket.id]);
    expect(bus.poll(spawned.agentId, { priority: 'urgent' })).toHaveLength(0);

    const reassigned = store.getTicket(ticket.id);
    expect(reassigned.routing?.vendor).toBe('pi');
  });

  test('tick() pauses a ready ticket with no candidate and resumes it once resume_at arrives, via a fake clock', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    // Both accounts exhausted with a resets_at 1h out.
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    for (const [vendor, account] of [
      ['claude', 'default'],
      ['pi', 'pi-on-claude-max'],
    ] as const) {
      await store.putQuota({
        vendor,
        account,
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
    }

    const ticket = await store.putTicket(makeTicket('TKT-0013' as TicketId, { status: 'ready' }));

    let now = Date.now();
    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
      now: () => new Date(now),
    });

    const first = await coordinator.tick([ticket.id]);
    expect(first.paused).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).status).toBe('paused');
    expect(store.getTicket(ticket.id).resume_at).toBe(resetsAt);

    // Not yet due.
    const second = await coordinator.tick([ticket.id]);
    expect(second.resumed).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('paused');

    // Fast-forward the fake clock past resume_at.
    now = Date.parse(resetsAt) + 1000;
    const third = await coordinator.tick([ticket.id]);
    expect(third.resumed).toEqual([ticket.id]);
    expect(store.getTicket(ticket.id).status).toBe('ready');
    expect(store.getTicket(ticket.id).resume_at).toBeUndefined();
  });
});

describe('HandoffCoordinator — round 2 review-fix regressions', () => {
  let fx: HandoffFixture;

  beforeEach(async () => {
    fx = makeHandoffFixture();
    await seedVendorsAndQuota(fx);
  });

  afterEach(() => fx.cleanup());

  test('B1: an ordinary progress stanza does not count as compliance — only a handoff stanza does, and the deadline path still composes one', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0020' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    let now = Date.now();
    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
      graceMs: 10_000,
      now: () => new Date(now),
    });

    await store.appendEvent(
      buildEvent('quota_low', { data: { vendor: 'claude', account: 'default', remaining: 0.1 } }),
    );
    await coordinator.tick([ticket.id]);

    // An ordinary progress stanza, not a handoff — must NOT be treated as compliance.
    now += 100;
    await store.appendStanza({
      ts: new Date(now).toISOString(),
      ticket: ticket.id,
      agent: spawned.agentId,
      kind: 'progress',
      summary: 'still working on it',
    });

    const stillWaiting = await coordinator.tick([ticket.id]);
    expect(stillWaiting.compliedAndReassigned).toEqual([]);
    expect(stillWaiting.hardHandoffs).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('in_progress');
    expect(store.getTicket(ticket.id).routing?.vendor).toBe('claude'); // not reassigned

    // Deadline elapses with still no handoff stanza -> hard handoff composes one.
    now += 20_000;
    const afterDeadline = await coordinator.tick([ticket.id]);
    expect(afterDeadline.hardHandoffs).toEqual([ticket.id]);
    const stanzas = store.listStanzas(ticket.id);
    expect(stanzas.some((s) => s.kind === 'handoff' && s.agent === 'daemon')).toBe(true);
    expect(store.getTicket(ticket.id).routing?.vendor).toBe('pi');
  });

  test('B2: a slow-exiting session (live clears well after the ticket is readied) does not throw "already running" and still reassigns', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store, { exitDelayMs: 200 });
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0021' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
    });

    await store.appendEvent(
      buildEvent('quota_exhausted', {
        data: { vendor: 'claude', account: 'default', remaining: 0 },
      }),
    );

    // Must not throw/reject even though the fake runner's `live` set only
    // clears 200ms after the ticket is readied (measured race in round 1).
    const result = await coordinator.tick([ticket.id]);

    expect(result.hardHandoffs).toEqual([ticket.id]);
    // Reassigned under the *same* agent id (role+ticket-digits scheme) —
    // `live` has it again from the new spawn, not because the old one was
    // never actually torn down (that's what the earlier `waitStopped`
    // inside `runHardHandoff` had to get right for this reassign to have
    // succeeded at all, rather than throwing "already running").
    const reassigned = store.getTicket(ticket.id);
    expect(reassigned.status).toBe('in_progress');
    expect(reassigned.routing?.vendor).toBe('pi');
    expect(reassigned.assignee).toBe(spawned.agentId);
  });

  test('B5: a coordinator constructed after historical quota events exist does not replay them', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0022' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    await runner.spawn('engineer', ticket.id);

    // A historical event from "before the restart" — must never be seen by
    // a coordinator constructed after it.
    await store.appendEvent(
      buildEvent('quota_low', { data: { vendor: 'claude', account: 'default', remaining: 0.1 } }),
    );

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
    });
    const result = await coordinator.tick([ticket.id]);

    expect(result.gracefulStarted).toEqual([]);
    expect(result.hardHandoffs).toEqual([]);
    expect(store.getTicket(ticket.id).status).toBe('in_progress');
  });

  test('N3: an agent that exits on its own during the graceful wait still gets a daemon-composed hard handoff, not a silent drop', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    let ticket = makeTicket('TKT-0023' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: ROUTING,
      graceMs: 60_000,
    });

    await store.appendEvent(
      buildEvent('quota_low', { data: { vendor: 'claude', account: 'default', remaining: 0.1 } }),
    );
    const first = await coordinator.tick([ticket.id]);
    expect(first.gracefulStarted).toEqual([ticket.id]);

    // The agent crashes/exits on its own — simulated exactly as a real
    // crash would surface: `runner.stop` from outside this coordinator
    // (e.g. the liveness sweep), readying the ticket without any handoff
    // stanza and well before the graceful deadline.
    runner.stop(spawned.agentId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getTicket(ticket.id).status).toBe('ready');

    const second = await coordinator.tick([ticket.id]);
    expect(second.hardHandoffs).toEqual([ticket.id]);
    const stanzas = store.listStanzas(ticket.id);
    expect(stanzas.some((s) => s.kind === 'handoff' && s.agent === 'daemon')).toBe(true);
    expect(store.getTicket(ticket.id).routing?.vendor).toBe('pi');
  });

  test('N2: reassignment returns none (letting pause run) rather than re-spawning on the very account being handed off from', async () => {
    const { store, bus } = fx;
    const runner = fakeHandoffRunner(store);
    const quota = new QuotaService({ store, bus });

    // Only claude is configured/routed — no alternative candidate exists.
    const soloRouting: RoutingTable = {
      'engineer:standard': [{ vendor: 'claude', account: 'default' }],
    };

    let ticket = makeTicket('TKT-0024' as TicketId, {
      status: 'ready',
      routing: {
        vendor: 'claude',
        account: 'default',
        model: 'claude-sonnet',
        attempts: 0,
        max_attempts: 2,
        escalation: [],
      },
    });
    ticket = await store.putTicket(ticket);
    const spawned = await runner.spawn('engineer', ticket.id);

    const coordinator = new HandoffCoordinator({
      store,
      bus,
      runner,
      quota,
      repoRoot: fx.repo,
      routing: soloRouting,
    });

    await store.appendEvent(
      buildEvent('quota_exhausted', {
        data: { vendor: 'claude', account: 'default', remaining: 0 },
      }),
    );
    const result = await coordinator.tick([ticket.id]);

    // Hard handoff still ran (stopped + composed the stanza); reassignment
    // itself must not have re-spawned on claude/default.
    expect(result.hardHandoffs).toEqual([ticket.id]);
    const reassigned = store.getTicket(ticket.id);
    expect(reassigned.status).toBe('ready'); // left ready, not re-spawned
    expect(runner.live.has(spawned.agentId)).toBe(false);
  });
});
