/**
 * Bus: per-session inboxes plus the registry heartbeat, over a
 * `StateStore`. `AgentMessage` files live at
 * `bus/inbox/<agent>/<ulid>.yaml` and move to `done/` on ack; producers
 * write them directly (a gate note for the session parked on it), and the
 * hook reads them with `poll`. The registry itself is `StateStore`'s;
 * `heartbeat` here only adds "register on first heartbeat".
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

/** Liveness timeout (5 min). */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;

const PRIORITY_LADDER: readonly MessagePriority[] = ['low', 'normal', 'urgent'];

export interface BusOptions {
  /** Injectable clock for tests. */
  now?: Clock;
  livenessTimeoutMs?: number;
}

export interface PollOptions {
  priority?: MessagePriority;
}

/** Inbox order: urgent, normal, low; ties by ulid (send order). */
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

  /** The liveness timeout the hook uses to distrust a stale registry entry (configurable per bus). */
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

  /** Message ids in an agent's unread inbox (not `done/`), unsorted. */
  private listInboxFiles(agent: string): string[] {
    const dir = this.inboxDir(agent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.slice(0, -'.yaml'.length));
  }

  /** `agent`'s unread inbox by priority, then send order. Moves nothing. */
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

  /** Marks `id` delivered by moving it to `done/`. Idempotent: an already-acked message is returned. */
  async ack(agent: AgentId, id: string): Promise<AgentMessage> {
    let message: AgentMessage;
    try {
      message = this.store.getEntity(this.inboxRelPath(agent, id), validateAgentMessage);
    } catch (err) {
      // Already acked (two hook events racing one delivery): return it.
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
   * Bumps `last_seen`, registering a minimal record on an agent's first
   * heartbeat. Later heartbeats delegate to `StateStore.heartbeat`, which
   * touches only `last_seen`/`stream`; correcting vendor/model/pid is a
   * `putAgent`.
   */
  async heartbeat(agent: AgentId, patch: Partial<AgentRecord> = {}): Promise<AgentRecord> {
    let existing: AgentRecord | undefined;
    try {
      existing = this.store.getAgent(agent);
    } catch {
      existing = undefined;
    }
    if (existing === undefined) {
      // First heartbeat: register a minimal record. Only `Bus` may create
      // one here; `StateStore.heartbeat` refuses an unregistered agent.
      const record: AgentRecord = {
        vendor: patch.vendor ?? 'unknown',
        model: patch.model ?? 'unknown',
        ...(patch.stream !== undefined ? { stream: patch.stream } : {}),
        pid: patch.pid,
        // `role` decides the hook's policy for this agent's calls.
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        last_seen: this.now().toISOString(),
      };
      return this.store.putAgent(agent, record);
    }
    return this.store.heartbeat(agent, { stream: patch.stream }, this.now);
  }
}
