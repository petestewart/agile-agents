/**
 * `HandoffCoordinator` — the daemon-side tick that drives T024's whole
 * scope (design/agile-agents-design.md §10 "Quota-driven pause and
 * handoff"): reacts to `quota_low`/`quota_exhausted` events by starting a
 * graceful or hard handoff, escalates an unheeded graceful instruction to a
 * hard one past its deadline, and (via `pause.ts`) pauses/resumes tickets
 * against the quota floor. Same shape as `em/loop.ts`'s `EmLoop` — a plain
 * class with process-local bookkeeping across `tick()` calls, meant to run
 * alongside it in the daemon's ceremony timer (see the pipeline report's
 * wiring section — this ticket does not own `daemon.ts`).
 *
 * Event-cursor design: `quota_low`/`quota_exhausted` are read off
 * `store.listEvents()` (which carries the structured `{vendor, account}`
 * `QuotaService.emitQuotaEvent` already writes) rather than polled off
 * `em`'s bus inbox — a `Message`'s own schema has no vendor/account fields,
 * only a free-text `body` (§5 "Message"). A `lastSeenIndex` cursor (not a
 * timestamp: two events can share one `ts` at sub-millisecond daemon
 * speed) means every event is processed exactly once per coordinator
 * instance; a restart re-scans from empty and could reprocess a handoff
 * that already happened, but `startGracefulOrHard`'s own guards (ticket
 * must still be `in_progress` under the same vendor/account) make a
 * replay a no-op rather than a duplicate handoff.
 */

import type { AgentId, Event, Ticket, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { QuotaService } from '../quota/records';
import type { RoutingTable } from '../quota/routing';
import type { Runner } from '../runner';
import type { StateStore } from '../store';
import { sendGracefulHandoffInstruction } from './graceful';
import { composeHardHandoff } from './hard';
import { pauseStuckReadyTickets, resumeDueTickets } from './pause';
import { reassignTicket } from './reassign';

/** CLAUDE.md names no handoff-grace tunable directly; the liveness timeout (5 min) is the closest existing "how long before we assume this agent isn't coming back" tunable in scope, reused here rather than inventing a new one. */
export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

interface PendingGraceful {
  ticket: TicketId;
  agentId: AgentId;
  vendor: string;
  account: string;
  deadlineMs: number;
  /** Number of stanzas on this ticket's board at the moment the instruction was sent — a later stanza count means the agent complied. */
  stanzaCountAtInstruction: number;
}

export interface HandoffCoordinatorOptions {
  store: StateStore;
  bus: Bus;
  runner: Pick<Runner, 'spawn' | 'stop'>;
  quota: Pick<QuotaService, 'list'>;
  repoRoot: string;
  graceMs?: number;
  routing?: RoutingTable;
  floor?: number;
  now?: () => Date;
}

export interface HandoffTickResult {
  gracefulStarted: TicketId[];
  compliedAndReassigned: TicketId[];
  hardHandoffs: TicketId[];
  paused: TicketId[];
  resumed: TicketId[];
}

export class HandoffCoordinator {
  private lastEventIndex = 0;
  private readonly pending = new Map<TicketId, PendingGraceful>();

  constructor(private readonly opts: HandoffCoordinatorOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private stanzaCount(ticket: TicketId): number {
    try {
      return this.opts.store.listStanzas(ticket).length;
    } catch {
      return 0;
    }
  }

  /** Every ticket currently `in_progress` and routed to `(vendor, account)`, with its assignee. */
  private inProgressOn(vendor: string, account: string): Array<{ ticket: Ticket; agentId: AgentId }> {
    const hits: Array<{ ticket: Ticket; agentId: AgentId }> = [];
    for (const ticket of this.opts.store.listTickets()) {
      if (ticket.status !== 'in_progress') continue;
      if (ticket.routing?.vendor !== vendor) continue;
      if ((ticket.routing?.account ?? 'default') !== account) continue;
      if (!ticket.assignee) continue;
      hits.push({ ticket, agentId: ticket.assignee as AgentId });
    }
    return hits;
  }

  /** `quota_low`: inject the graceful instruction and start the deadline clock. Already-pending tickets for this account are left alone (idempotent against a duplicate event). */
  private async startGraceful(vendor: string, account: string): Promise<TicketId[]> {
    const started: TicketId[] = [];
    const now = this.now();
    for (const { ticket, agentId } of this.inProgressOn(vendor, account)) {
      if (this.pending.has(ticket.id)) continue;
      const deadlineMs = now.getTime() + (this.opts.graceMs ?? DEFAULT_GRACE_MS);
      const deadline = new Date(deadlineMs).toISOString();
      await sendGracefulHandoffInstruction({
        bus: this.opts.bus,
        agent: agentId,
        ticket: ticket.id,
        vendor,
        account,
        deadline,
        now: () => now,
      });
      this.pending.set(ticket.id, {
        ticket: ticket.id,
        agentId,
        vendor,
        account,
        deadlineMs,
        stanzaCountAtInstruction: this.stanzaCount(ticket.id),
      });
      started.push(ticket.id);
    }
    return started;
  }

  /** `quota_exhausted`: no time to wait for compliance — straight to hard handoff for every affected in-progress ticket. */
  private async startHardImmediately(vendor: string, account: string): Promise<TicketId[]> {
    const done: TicketId[] = [];
    for (const { ticket, agentId } of this.inProgressOn(vendor, account)) {
      this.pending.delete(ticket.id);
      await this.runHardHandoff(ticket.id, agentId, `quota exhausted on ${vendor}/${account}`);
      done.push(ticket.id);
    }
    return done;
  }

  /** Stops the running session, waits for its own exit handling to ready the ticket (the dead-agent path, §5 "Liveness"), composes a daemon-written handoff stanza, and reassigns. */
  private async runHardHandoff(ticket: TicketId, agentId: AgentId, reason: string): Promise<void> {
    const stopped = this.opts.runner.stop(agentId);
    if (!stopped) {
      // Already gone (crashed on its own) — the liveness sweep or its own
      // exit handler already readied the ticket; nothing further to await.
    }
    await this.waitReady(ticket);

    const current = this.opts.store.getTicket(ticket);
    if (current.worktree) {
      const { handoff, summary } = composeHardHandoff({
        store: this.opts.store,
        ticket,
        worktreePath: `${this.opts.repoRoot}/${current.worktree}`,
        repoRoot: this.opts.repoRoot,
        reason,
      });
      await this.opts.store.appendStanza({
        ts: this.now().toISOString(),
        ticket,
        agent: 'daemon',
        kind: 'handoff',
        summary: summary.slice(0, 4000),
        handoff,
      });
    }

    await this.reassign(ticket, { vendor: current.routing?.vendor, account: current.routing?.account });
  }

  /** Polls until `runner.stop`'s own exit handling has readied the ticket (bounded — a session that never emits `exit` at all is a bug elsewhere, not something to spin on forever). */
  private async waitReady(ticket: TicketId, maxWaitMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      let current: Ticket;
      try {
        current = this.opts.store.getTicket(ticket);
      } catch {
        return;
      }
      if (current.status === 'ready' || current.status === 'paused') return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async reassign(
    ticket: TicketId,
    exclude: { vendor?: string; account?: string },
  ): Promise<boolean> {
    const current = this.opts.store.getTicket(ticket);
    if (current.status !== 'ready') return false;
    const result = await reassignTicket({
      store: this.opts.store,
      bus: this.opts.bus,
      runner: this.opts.runner,
      quota: this.opts.quota,
      ticket,
      exclude:
        exclude.vendor && exclude.account
          ? { vendor: exclude.vendor, account: exclude.account }
          : undefined,
      routing: this.opts.routing,
      floor: this.opts.floor,
      now: () => this.now(),
    });
    return !('none' in result);
  }

  /** New `quota_low`/`quota_exhausted` events since the last `tick()`, in file order. */
  private drainQuotaEvents(): Event[] {
    const events = this.opts.store.listEvents();
    const fresh = events
      .slice(this.lastEventIndex)
      .filter((e) => e.kind === 'quota_low' || e.kind === 'quota_exhausted');
    this.lastEventIndex = events.length;
    return fresh;
  }

  /** Pending graceful entries past their deadline with no compliance yet -> hard handoff. Compliant ones (a fresh stanza landed) -> stop + reassign without waiting out the rest of the deadline. */
  private async checkPending(): Promise<{ complied: TicketId[]; hard: TicketId[] }> {
    const complied: TicketId[] = [];
    const hard: TicketId[] = [];
    const nowMs = this.now().getTime();

    for (const entry of [...this.pending.values()]) {
      let current: Ticket;
      try {
        current = this.opts.store.getTicket(entry.ticket);
      } catch {
        this.pending.delete(entry.ticket);
        continue;
      }
      // Already moved on by some other path (reassigned, done, etc.).
      if (current.status !== 'in_progress' || current.assignee !== entry.agentId) {
        this.pending.delete(entry.ticket);
        continue;
      }

      const compliedAlready = this.stanzaCount(entry.ticket) > entry.stanzaCountAtInstruction;
      if (compliedAlready) {
        this.pending.delete(entry.ticket);
        this.opts.runner.stop(entry.agentId);
        await this.waitReady(entry.ticket);
        const ok = await this.reassign(entry.ticket, { vendor: entry.vendor, account: entry.account });
        if (ok) complied.push(entry.ticket);
        continue;
      }

      if (nowMs >= entry.deadlineMs) {
        this.pending.delete(entry.ticket);
        await this.runHardHandoff(
          entry.ticket,
          entry.agentId,
          `graceful handoff deadline elapsed on ${entry.vendor}/${entry.account}`,
        );
        hard.push(entry.ticket);
      }
    }

    return { complied, hard };
  }

  /** One full pass: quota events -> graceful/hard start, pending deadlines, pause/resume. */
  async tick(sprintTicketIds: readonly TicketId[]): Promise<HandoffTickResult> {
    const events = this.drainQuotaEvents();
    const gracefulStarted: TicketId[] = [];
    const hardFromEvents: TicketId[] = [];

    for (const event of events) {
      const vendor = typeof event.data.vendor === 'string' ? event.data.vendor : undefined;
      const account = typeof event.data.account === 'string' ? event.data.account : undefined;
      if (!vendor || !account) continue;
      if (event.kind === 'quota_exhausted') {
        hardFromEvents.push(...(await this.startHardImmediately(vendor, account)));
      } else {
        gracefulStarted.push(...(await this.startGraceful(vendor, account)));
      }
    }

    const { complied, hard } = await this.checkPending();

    const paused = await pauseStuckReadyTickets(sprintTicketIds, {
      store: this.opts.store,
      quota: this.opts.quota,
      now: () => this.now(),
      routing: this.opts.routing,
      floor: this.opts.floor,
    });
    const resumed = await resumeDueTickets(this.opts.store, () => this.now());

    return {
      gracefulStarted,
      compliedAndReassigned: complied,
      hardHandoffs: [...hardFromEvents, ...hard],
      paused: paused.paused,
      resumed: resumed.resumed,
    };
  }
}
