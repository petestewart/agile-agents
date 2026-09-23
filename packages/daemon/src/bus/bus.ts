/**
 * Bus — per-session inboxes plus the agent registry heartbeat, over a
 * `StateStore` (design/agile-agents-design.md §5 "Comms bus", narrowed by
 * T168 to what the reshape reads).
 *
 * Storage: `AgentMessage` files under `bus/inbox/<agent>/<ulid>.yaml`
 * (unread), moved to `bus/inbox/<agent>/done/<ulid>.yaml` on ack. They are
 * written directly by their producers (`gates/service.ts` delivers a gate
 * note to the session parked on it); the hook reads them with `poll` and
 * acks them once delivered. T168 deleted `send`, its role routing table,
 * ticket fan-out and the redelivery ladder: every one of them addressed the
 * old team roles.
 *
 * The registry (`bus/agents/<agent>.yaml`) is `StateStore`'s
 * (`putAgent`/`getAgent`/`heartbeat`); `heartbeat` here only adds
 * "register on first heartbeat".
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentId,
  type AgentMessage,
  type AgentRecord,
  type MessagePriority,
  validateAgentMessage,
} from '@agile-agents/shared';
import { NotFoundError, type StateStore } from '../store';

export type Clock = () => Date;

/** CLAUDE.md tunable: "liveness timeout 5 min". */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;

const PRIORITY_LADDER: readonly MessagePriority[] = ['low', 'normal', 'urgent'];

export interface BusOptions {
  /** Injectable clock so tests can drive heartbeat/redelivery/liveness without sleeping. */
  now?: Clock;
  livenessTimeoutMs?: number;
}

export interface PollOptions {
  priority?: MessagePriority;
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

  /**
   * This bus's configured liveness timeout (T012 review round 3, opus item
   * 4) — `HookService.resolveAgentByCwd` reads this to decide whether a
   * registered agent's `last_seen` is too stale to trust for cwd/role
   * resolution, rather than hardcoding `DEFAULT_LIVENESS_TIMEOUT_MS`
   * (which would silently diverge from a `Bus` constructed with a custom
   * `livenessTimeoutMs`, e.g. in a test).
   */
  getLivenessTimeoutMs(): number {
    return this.livenessTimeoutMs;
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

  /** Every message file currently in an agent's unread inbox (not `done/`), unsorted. */
  private listInboxFiles(agent: string): string[] {
    const dir = this.inboxDir(agent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.slice(0, -'.yaml'.length));
  }

  /**
   * Returns `agent`'s unread inbox, ordered urgent → normal → low (ties
   * broken by ulid, i.e. send order). Moves nothing — "poll ... moves
   * nothing" (standing rules).
   */
  poll(agent: AgentId, options: PollOptions = {}): AgentMessage[] {
    const ids = this.listInboxFiles(agent).sort();
    const messages = ids.map((id) =>
      this.store.getEntity(this.inboxRelPath(agent, id), validateAgentMessage),
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
  async ack(agent: AgentId, id: string): Promise<AgentMessage> {
    let message: AgentMessage;
    try {
      message = this.store.getEntity(this.inboxRelPath(agent, id), validateAgentMessage);
    } catch (err) {
      // Idempotent: an already-acked message is in `done/`; acking it
      // again (two hook events racing on one delivery) returns it.
      if (err instanceof NotFoundError) {
        return this.store.getEntity(this.inboxRelPath(agent, id, true), validateAgentMessage);
      }
      throw err;
    }
    await this.store.putEntity(this.inboxRelPath(agent, id, true), validateAgentMessage, message);
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
   *
   * Round 4 (QA round 3 REJECT): this used to rebuild the WHOLE record from
   * `patch`/`existing.{vendor,model,ticket,pid}` on every call, including
   * every heartbeat *after* the first — silently dropping `role`/`worktree`/
   * `session_id` (not in that field list) exactly like `StateStore.heartbeat`
   * did before this round's fix there. Now: an agent's true first heartbeat
   * (no existing record) still registers a minimal one via `putAgent`, same
   * as before; every heartbeat after that delegates to
   * `StateStore.heartbeat`, which only ever touches `last_seen`/`ticket` and
   * carries every other field over verbatim — so `vendor`/`model`/`pid` on
   * an EXISTING record are no longer patchable via a later heartbeat call
   * either (a narrower contract than before, but the one `StateStore`'s own
   * fix now enforces at the root; a real vendor/model/pid correction belongs
   * in a `putAgent` call, not a heartbeat).
   */
  async heartbeat(agent: AgentId, patch: Partial<AgentRecord> = {}): Promise<AgentRecord> {
    let existing: AgentRecord | undefined;
    try {
      existing = this.store.getAgent(agent);
    } catch {
      existing = undefined;
    }
    if (existing === undefined) {
      // First heartbeat for this agent — register a minimal record (§5:
      // "create on first heartbeat if absent"). `StateStore.heartbeat`
      // deliberately refuses to do this itself (round 4: heartbeating an
      // unregistered agent is a caller bug, not something to paper over) —
      // `Bus` is the one caller allowed to create a record here, and only
      // because there truly is none yet.
      const record: AgentRecord = {
        vendor: patch.vendor ?? 'unknown',
        model: patch.model ?? 'unknown',
        ...(patch.stream !== undefined ? { stream: patch.stream } : {}),
        pid: patch.pid,
        // `role` is what the hook path resolves a tool call's policy from
        // (`hook/service.ts`); dropping it here made every bus-registered
        // agent look role-less.
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        last_seen: this.now().toISOString(),
      };
      return this.store.putAgent(agent, record);
    }
    return this.store.heartbeat(agent, { stream: patch.stream }, this.now);
  }
}
