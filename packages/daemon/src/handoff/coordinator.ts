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
 * only a free-text `body` (§5 "Message"). The cursor is seeded to the
 * *current* event-log length in the constructor (round 2 review-fix, opus
 * B5 — round 1 started it at `0`, replaying the entire historical log on
 * the first tick after every daemon restart: any past `quota_low` for an
 * account a ticket happens to be running on again would immediately fire a
 * spurious instruction/stop/reassign on otherwise-healthy work), so only
 * events appended *after* this coordinator instance came up are ever seen.
 * Not a timestamp (two events can share one `ts` at sub-millisecond daemon
 * speed) — an index into the append-only log both dedupes within one
 * instance's lifetime and, seeded at startup, never looks backward past it.
 *
 * Stop→reassign handshake (round 2 review-fix, opus B2): round 1 polled
 * `Ticket.status` to decide the old session was gone, which raced
 * `Runner`'s own bookkeeping — `session.ts`'s `finish()` transitions the
 * ticket to `ready` *before* it drops the agent from `Runner`'s internal
 * `live` map (via `handle.exited`'s own resolution), so a poll that returns
 * the instant the ticket reads `ready` can still land inside the window
 * where `Runner.spawn`'s "already running" guard fires. Every stop→reassign
 * path here now awaits the actual session's `exited` promise (found via
 * `runner.list()`, the same handle a real `Runner` or this package's own
 * fake-runner test helper exposes) before ever calling `reassignTicket`,
 * closing that race the way `em/assign.ts`'s own "already running" guard
 * already documents as a known hazard elsewhere in this codebase.
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
  /**
   * ISO timestamp of the graceful instruction itself (round 2 review-fix,
   * opus B1 — round 1's "any later stanza counts as compliance" let a
   * routine `progress` stanza posted for an unrelated reason satisfy the
   * check with no `handoff` stanza ever written). Compliance now requires a
   * `kind: 'handoff'` stanza whose own `ts` is strictly after this one.
   */
  instructionTs: string;
}

export interface HandoffCoordinatorOptions {
  store: StateStore;
  bus: Bus;
  /** `list` is required (round 2, opus B2) — see this file's header on the stop→reassign handshake. */
  runner: Pick<Runner, 'spawn' | 'stop' | 'list'>;
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
  /** Round 2 (opus B5): seeded to the log's current length, not `0` — see this file's header. */
  private lastEventIndex: number;
  private readonly pending = new Map<TicketId, PendingGraceful>();

  constructor(private readonly opts: HandoffCoordinatorOptions) {
    this.lastEventIndex = opts.store.listEvents().length;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private hasHandoffStanzaSince(ticket: TicketId, sinceTs: string): boolean {
    let stanzas: ReturnType<StateStore['listStanzas']>;
    try {
      stanzas = this.opts.store.listStanzas(ticket);
    } catch {
      return false;
    }
    return stanzas.some((s) => s.kind === 'handoff' && s.ts > sinceTs);
  }

  /** Awaits the real session's own exit — round 2 (opus B2), see this file's header. A `runner.list()` miss means the agent is already gone (its own `handle.exited` already settled and `Runner` already dropped it from `live`), so there is nothing left to await. */
  private async waitStopped(agentId: AgentId): Promise<void> {
    const handle = this.opts.runner.list().find((r) => r.agentId === agentId);
    if (!handle) return;
    await handle.exited;
  }

  /** Every ticket currently `in_progress` and routed to `(vendor, account)`, with its assignee. */
  private inProgressOn(
    vendor: string,
    account: string,
  ): Array<{ ticket: Ticket; agentId: AgentId }> {
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
      const instructionTs = now.toISOString();
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
        instructionTs,
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

  /** Stops the running session, awaits its actual exit (round 2, opus B2 — see file header), then composes+reassigns via `finishHardHandoff`. */
  private async runHardHandoff(ticket: TicketId, agentId: AgentId, reason: string): Promise<void> {
    const stopped = this.opts.runner.stop(agentId);
    if (stopped) {
      await this.waitStopped(agentId);
    }
    // `stopped === false` means the agent was already gone (crashed on its
    // own, or the liveness sweep already reaped it) — its own exit handling
    // has already run either way, so proceeding straight to composing the
    // handoff is correct without anything further to await.
    await this.finishHardHandoff(ticket, reason);
  }

  /** Composes the daemon-written handoff stanza (when the ticket still has a worktree) and reassigns — the tail both `runHardHandoff` and the "agent exited during the graceful wait" path (round 2, opus N3) share. Assumes the old session is already fully stopped. */
  private async finishHardHandoff(ticket: TicketId, reason: string): Promise<void> {
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

    await this.reassign(ticket, {
      vendor: current.routing?.vendor,
      account: current.routing?.account,
    });
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

  /**
   * Pending graceful entries past their deadline with no compliance yet ->
   * hard handoff. Compliant ones (an actual `handoff` stanza landed, round
   * 2 opus B1) -> stop + reassign without waiting out the rest of the
   * deadline. An entry whose agent already exited on its own during the
   * wait (round 2, opus N3 — e.g. the liveness sweep beat this coordinator
   * to it) is not simply dropped: it gets the same daemon-composed hard
   * handoff a deadline timeout would have gotten it, since the account it
   * was on is exactly as unavailable either way.
   */
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
      // Already moved on by some other path (reassigned, done, etc.) — or
      // the agent exited on its own (round 2, opus N3).
      if (current.status !== 'in_progress' || current.assignee !== entry.agentId) {
        this.pending.delete(entry.ticket);
        if (current.status === 'ready') {
          await this.finishHardHandoff(
            entry.ticket,
            `agent exited during graceful wait on ${entry.vendor}/${entry.account}`,
          );
          hard.push(entry.ticket);
        }
        continue;
      }

      // Round 2 (opus B1): compliance requires the actual `handoff` stanza
      // the instruction asked for, not merely *any* later stanza.
      const compliedAlready = this.hasHandoffStanzaSince(entry.ticket, entry.instructionTs);
      if (compliedAlready) {
        this.pending.delete(entry.ticket);
        const stopped = this.opts.runner.stop(entry.agentId);
        if (stopped) await this.waitStopped(entry.agentId);
        const ok = await this.reassign(entry.ticket, {
          vendor: entry.vendor,
          account: entry.account,
        });
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
