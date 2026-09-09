/**
 * Bus — `bus.send/poll/ack/heartbeat` over a `StateStore`
 * (design/agile-agents-design.md §5 "Comms bus"; T006 scope).
 *
 * Storage (§5 "Storage"): ULID message files under
 * `bus/inbox/<agent>/<ulid>.yaml` (unread), moved to
 * `bus/inbox/<agent>/done/<ulid>.yaml` on ack (§5 "Ordering / failure":
 * "Ack moves file to `done/`" — the file-move layout, not a sidecar
 * marker); every message that names a `ticket` is also filed at
 * `bus/threads/<ticket>/<ulid>.yaml` (every message touching a ticket).
 * Message and thread copies are written through `StateStore.putEntity` —
 * its own doc comment names exactly this as its intended use — so each
 * write gets the store's usual validate-then-atomic-write-then-commit
 * treatment and its own `entity_put` event; on top of that, `send` emits
 * one more `message` event per delivery (ticket's explicit requirement)
 * carrying the envelope's identifying fields, so `log/events.jsonl` has a
 * single "a message kind X was delivered" line per send, not just the
 * generic entity writes.
 *
 * The registry (`bus/agents/<agent>.yaml`) and the dead-agent path
 * (`transitionTicket` back to `ready`) are already implemented by T005's
 * `StateStore` (`putAgent`/`getAgent`/`listAgents`/`deleteAgent`,
 * `transitionTicket`) — this module is a thin orchestration layer over
 * those plus the two entity-file trees above, not a re-implementation.
 *
 * Directory listing: `StateStore` exposes no "list this entity directory"
 * primitive beyond the specific entities it names, so this module reads
 * `bus/inbox/**` directly off disk (this package's own `stateRoot`,
 * plumbed in by the constructor) using the same `node:fs` primitives
 * `store/fs.ts` uses — no new dependency, no edit to `store/**`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentId,
  type AgentRecord,
  type Message,
  type MessagePriority,
  type MessageRecipient,
  MessageSchema,
  type TicketId,
  type TicketStatus,
  validateMessage,
} from '@agile-agents/shared';
import type { StateStore } from '../store';
import { checkRoute } from './routing';
import { ulid } from './ulid';

export type Clock = () => Date;

/** CLAUDE.md tunable: "liveness timeout 5 min". */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * "`last_seen` older than N minutes with ticket `in_progress` → daemon
 * sends `escalate` to em, ticket back to `ready`" (§5 "Liveness"). The
 * ticket text broadens this to "(or any live status)" — read as every
 * status the dead-agent-reassignment edge table in `ticket.ts` names as a
 * valid `-> ready` source for this exact path: assigned, in_progress,
 * in_review, in_qa, blocked.
 */
const LIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
  'blocked',
];

const PRIORITY_LADDER: readonly MessagePriority[] = ['low', 'normal', 'urgent'];

function bumpPriority(priority: MessagePriority): MessagePriority {
  const index = PRIORITY_LADDER.indexOf(priority);
  const next = PRIORITY_LADDER[Math.min(index + 1, PRIORITY_LADDER.length - 1)];
  return next ?? priority;
}

export interface BusOptions {
  /** Injectable clock so tests can drive heartbeat/redelivery/liveness without sleeping. */
  now?: Clock;
  livenessTimeoutMs?: number;
}

export interface SendRejected {
  ok: false;
  reason: string;
}

export interface SendAccepted {
  ok: true;
  message: Message;
  /** The concrete agent ids the message was filed to, after ticket:/broadcast fan-out. */
  recipients: AgentId[];
}

export type SendResult = SendAccepted | SendRejected;

export interface PollOptions {
  priority?: MessagePriority;
}

export interface LivenessEscalation {
  agent: AgentId;
  ticket: TicketId;
}

export interface RedeliveryResult {
  /** Messages bumped one priority rung and left in the inbox. */
  redelivered: Array<{ agent: AgentId; id: string; from: MessagePriority; to: MessagePriority }>;
  /** Messages already at `urgent` past deadline: escalated to em, `requires_ack` cleared. */
  escalated: Array<{ agent: AgentId; id: string }>;
}

/** Order inbox reads deterministically: urgent first, then normal, then low; ties broken by ulid (chronological). */
function priorityRank(priority: MessagePriority): number {
  return PRIORITY_LADDER.indexOf(priority);
}

export class Bus {
  private readonly now: Clock;
  private readonly livenessTimeoutMs: number;

  constructor(
    private readonly store: StateStore,
    private readonly stateRoot: string,
    options: BusOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
  }

  private inboxDir(agent: string, sub?: string): string {
    return sub
      ? join(this.stateRoot, 'bus', 'inbox', agent, sub)
      : join(this.stateRoot, 'bus', 'inbox', agent);
  }

  private inboxRelPath(agent: string, id: string, done = false): string {
    return done
      ? join('bus', 'inbox', agent, 'done', `${id}.yaml`)
      : join('bus', 'inbox', agent, `${id}.yaml`);
  }

  private threadRelPath(ticket: TicketId, id: string): string {
    return join('bus', 'threads', ticket, `${id}.yaml`);
  }

  /** Every message file currently in an agent's unread inbox (not `done/`), unsorted. */
  private listInboxFiles(agent: string): string[] {
    const dir = this.inboxDir(agent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.slice(0, -'.yaml'.length));
  }

  /** Every agent id that currently has an inbox directory (registered or not — em/architect/human/daemon may never call `heartbeat`). */
  private listInboxAgents(): string[] {
    const dir = join(this.stateRoot, 'bus', 'inbox');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /**
   * Resolves a single `to` token into concrete agent ids to file the
   * message under. `ticket:<id>` fans out to the ticket's `assignee` plus
   * every agent currently registered against that ticket (`AgentRecord.ticket
   * === id`) — DESIGN-GAP: §4's `Ticket` schema carries only one `assignee`
   * field (no reviewer/qa list), so "fan-out to everyone on it" (§5
   * "Message") is read via the bus registry rather than the ticket record.
   * `broadcast` fans out to every registered agent except the sender.
   */
  private resolveRecipients(to: MessageRecipient, from: AgentId): AgentId[] {
    if (to === 'broadcast') {
      return this.store
        .listAgents()
        .map((a) => a.id)
        .filter((id) => id !== from) as AgentId[];
    }
    if (to.startsWith('ticket:')) {
      const ticketId = to.slice('ticket:'.length) as TicketId;
      const recipients = new Set<string>();
      try {
        const ticket = this.store.getTicket(ticketId);
        if (ticket.assignee) recipients.add(ticket.assignee);
      } catch {
        // Ticket doesn't exist (yet, or ever) — fan-out degrades to whoever
        // the registry already has on it, rather than failing the send.
      }
      for (const agent of this.store.listAgents()) {
        if (agent.record.ticket === ticketId) recipients.add(agent.id);
      }
      return [...recipients] as AgentId[];
    }
    return [to as AgentId];
  }

  /**
   * Validates, routes, and files `input` as a `Message`. Rejects (no files
   * written, no event emitted) if the body cap is exceeded or any `to`
   * entry fails a §5 routing rule — "disallowed routes are rejected with a
   * reason" (acceptance criterion).
   */
  async send(input: unknown): Promise<SendResult> {
    let message: Message;
    try {
      message = validateMessage(input);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    for (const to of message.to) {
      const check = checkRoute({ from: message.from, to, kind: message.kind });
      if (!check.allowed) {
        return { ok: false, reason: `${message.from} -> ${to} (${message.kind}): ${check.reason}` };
      }
    }

    const recipients = new Set<AgentId>();
    for (const to of message.to) {
      for (const id of this.resolveRecipients(to, message.from)) recipients.add(id);
    }

    // One send = one atomic batch of inbox files (+ thread copy) = one
    // `message` event = one commit on agile-state.
    const writes = [...recipients].map((agent) => ({
      relPath: this.inboxRelPath(agent, message.id),
      validator: validateMessage,
      data: message,
    }));
    if (message.ticket) {
      writes.push({
        relPath: this.threadRelPath(message.ticket, message.id),
        validator: validateMessage,
        data: message,
      });
    }
    await this.store.putEntities(writes, {
      ts: this.now().toISOString(),
      kind: 'message',
      ticket: message.ticket,
      agent: message.from,
      data: {
        id: message.id,
        to: message.to,
        kind: message.kind,
        priority: message.priority,
        recipients: [...recipients],
      },
    });

    return { ok: true, message, recipients: [...recipients] };
  }

  /**
   * Returns `agent`'s unread inbox, ordered urgent → normal → low (ties
   * broken by ulid, i.e. send order). Moves nothing — "poll ... moves
   * nothing" (standing rules).
   */
  poll(agent: AgentId, options: PollOptions = {}): Message[] {
    const ids = this.listInboxFiles(agent).sort();
    const messages = ids.map((id) =>
      this.store.getEntity(this.inboxRelPath(agent, id), validateMessage),
    );
    const filtered = options.priority
      ? messages.filter((m) => m.priority === options.priority)
      : messages;
    return [...filtered].sort((a, b) => {
      const rankDiff = priorityRank(b.priority) - priorityRank(a.priority);
      return rankDiff !== 0 ? rankDiff : a.id.localeCompare(b.id);
    });
  }

  /**
   * Marks `id` delivered: moves `bus/inbox/<agent>/<id>.yaml` to
   * `bus/inbox/<agent>/done/<id>.yaml` (§5 "Ordering / failure": "Ack moves
   * file to `done/`"). Idempotent-ish: throws `NotFoundError` (from the
   * store) if `id` isn't in the unread inbox — including if it was already
   * acked, so a caller can distinguish "already done" from "no such message".
   */
  async ack(agent: AgentId, id: string): Promise<Message> {
    const message = this.store.getEntity(this.inboxRelPath(agent, id), validateMessage);
    await this.store.putEntity(this.inboxRelPath(agent, id, true), validateMessage, message);
    await this.store.deleteEntity(this.inboxRelPath(agent, id));
    return message;
  }

  /**
   * Updates (or creates) `agent`'s registry entry with `last_seen = now()`.
   * "`bus.heartbeat` rides on the pre-tool-use hook" (§5 "Liveness") — the
   * hook/adapter is expected to already know its own vendor/model/pid at
   * spawn time and pass them on first heartbeat; a later heartbeat may omit
   * `patch` entirely to just bump `last_seen`.
   *
   * DESIGN-GAP: §5 gives no yaml example for `agents/<agent>.yaml` beyond
   * the field list in `AgentRecord` (vendor/model/ticket/pid/last_seen), so
   * "create on first heartbeat if absent" is this module's own reading —
   * the alternative (heartbeat before registration is an error) would make
   * every agent's first heartbeat racy against whatever else is supposed to
   * call `putAgent` first, and nothing in §5 names such a call.
   */
  async heartbeat(agent: AgentId, patch: Partial<AgentRecord> = {}): Promise<AgentRecord> {
    let existing: Partial<AgentRecord> = {};
    try {
      existing = this.store.getAgent(agent);
    } catch {
      // First heartbeat for this agent — fall through to defaults below.
    }
    const record: AgentRecord = {
      vendor: patch.vendor ?? existing.vendor ?? 'unknown',
      model: patch.model ?? existing.model ?? 'unknown',
      ticket: patch.ticket ?? existing.ticket,
      pid: patch.pid ?? existing.pid ?? process.pid,
      last_seen: this.now().toISOString(),
    };
    return this.store.putAgent(agent, record);
  }

  /**
   * Sweeps every registered agent for a stale `last_seen` against an
   * in-flight ticket: sends `escalate` to `em`, transitions the ticket back
   * to `ready`, and removes the agent record ("registry heartbeat timeout
   * emits an `escalate` to `em` and returns the ticket to `ready`" —
   * acceptance criterion). `now` is injectable for the fake-clock test.
   */
  async checkLiveness(now: Date = this.now()): Promise<LivenessEscalation[]> {
    const escalations: LivenessEscalation[] = [];
    for (const { id, record } of this.store.listAgents()) {
      if (!record.ticket) continue;
      const lastSeenMs = Date.parse(record.last_seen);
      if (Number.isNaN(lastSeenMs) || now.getTime() - lastSeenMs < this.livenessTimeoutMs) {
        continue;
      }

      let ticket: TicketId | undefined;
      try {
        const found = this.store.getTicket(record.ticket);
        if (LIVE_TICKET_STATUSES.includes(found.status)) ticket = found.id;
      } catch {
        // Ticket vanished from under the agent — nothing to ripple back.
      }
      if (!ticket) continue;

      await this.sendSystemMessage({
        from: 'daemon',
        to: ['em'],
        kind: 'escalate',
        priority: 'urgent',
        ticket,
        body: `agent ${id} unresponsive since ${record.last_seen} (liveness timeout) on ${ticket}`,
        now,
      });
      await this.store.transitionTicket(ticket, 'ready', {
        by: 'daemon',
        reason: `liveness timeout: ${id} unresponsive since ${record.last_seen}`,
      });
      await this.store.deleteAgent(id as AgentId);
      escalations.push({ agent: id as AgentId, ticket });
    }
    return escalations;
  }

  /**
   * Redelivery ladder (§5 "Ordering / failure": "Unacked `requires_ack`
   * past deadline re-delivers one priority up, then escalates to em"): for
   * every unacked `requires_ack` message whose `deadline` has passed,
   * bumps its priority one rung (low→normal→urgent) and extends `deadline`
   * by the same window it started with; a message already at `urgent`
   * instead escalates to `em` and has `requires_ack` cleared so the next
   * sweep doesn't escalate it again. `now` is injectable for the
   * fake-clock test.
   *
   * DESIGN-GAP: a `requires_ack` message with no `deadline` at all can
   * never be judged overdue by this sweep (nothing in §5 gives it a
   * default window) — such messages are skipped, not redelivered.
   */
  async sweepRedelivery(now: Date = this.now()): Promise<RedeliveryResult> {
    const result: RedeliveryResult = { redelivered: [], escalated: [] };
    for (const agent of this.listInboxAgents()) {
      for (const id of this.listInboxFiles(agent)) {
        const relPath = this.inboxRelPath(agent, id);
        const message = this.store.getEntity(relPath, validateMessage);
        if (!message.requires_ack || !message.deadline) continue;
        const deadlineMs = Date.parse(message.deadline);
        if (Number.isNaN(deadlineMs) || now.getTime() < deadlineMs) continue;

        if (message.priority === 'urgent') {
          await this.sendSystemMessage({
            from: 'daemon',
            to: ['em'],
            kind: 'escalate',
            priority: 'urgent',
            ticket: message.ticket,
            body: `message ${message.id} to ${agent} (${message.kind}) unacked past deadline`,
            now,
          });
          await this.store.putEntity(relPath, validateMessage, {
            ...message,
            requires_ack: false,
          });
          result.escalated.push({ agent: agent as AgentId, id });
          continue;
        }

        const windowMs = Number.isNaN(Date.parse(message.ts))
          ? this.livenessTimeoutMs
          : Math.max(deadlineMs - Date.parse(message.ts), 1000);
        const nextPriority = bumpPriority(message.priority);
        await this.store.putEntity(relPath, validateMessage, {
          ...message,
          priority: nextPriority,
          deadline: new Date(now.getTime() + windowMs).toISOString(),
        });
        result.redelivered.push({
          agent: agent as AgentId,
          id,
          from: message.priority,
          to: nextPriority,
        });
      }
    }
    return result;
  }

  /** Internal daemon-originated sends (liveness/redelivery escalation) — bypasses public routing errors surfacing as `SendResult`, since these are always-legal `daemon -> em` messages by construction. */
  private async sendSystemMessage(input: {
    from: 'daemon';
    to: MessageRecipient[];
    kind: 'escalate';
    priority: MessagePriority;
    ticket?: TicketId;
    body: string;
    now: Date;
  }): Promise<void> {
    const message = MessageSchema.parse({
      id: ulid(input.now.getTime()),
      ts: input.now.toISOString(),
      from: input.from,
      to: input.to,
      kind: input.kind,
      priority: input.priority,
      ticket: input.ticket,
      body: input.body,
      requires_ack: false,
    });
    const outcome = await this.send(message);
    if (!outcome.ok) {
      // Every call site above constructs a daemon -> em escalate, which
      // `checkRoute` always allows — a rejection here means the routing
      // table and this module's own assumptions have drifted apart.
      throw new Error(`internal bus invariant violated: ${outcome.reason}`);
    }
  }
}
