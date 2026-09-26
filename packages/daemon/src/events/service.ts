/**
 * `RoutedEventService` (T240, projects-design §14.9, §15, P9, P10): the
 * routed event API that the router (T241), delivery (T242) and producers
 * (T244) build on. All writes go through `StateStore`, fsynced before the
 * call returns.
 *
 * - `emit(input)`: mints the id and time, appends the event to
 *   `events/log.jsonl` and one `pending` delivery per `routing` entry to
 *   `events/queue/<node>.jsonl`. The caller (the router) supplies `routing`.
 * - `pendingFor(node)`: the node's still-pending deliveries with their
 *   events, oldest first.
 * - `mark(node, ids, status, meta)`: moves pending deliveries to `delivered`,
 *   `superseded` or `expired` in one write. Only a pending delivery moves.
 * - `get(id)`: one event by id (`read_event`).
 * - `onEmitted(fn)`: called after each stored event (delivery, T242, wakes
 *   its recipients).
 * - `recover()`: run once at startup. A crash between the log append and
 *   the queue append leaves an event with no delivery; this re-adds its
 *   `pending` lines, so nothing routed is dropped.
 */

import {
  type Delivery,
  type EventDeliveryStatus,
  type RoutedEvent,
  type RoutedEventId,
  type RoutedEventType,
  type RoutingEntry,
  ulid,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';

export type EmitInput = Omit<RoutedEvent, 'id' | 'at'> & { type: RoutedEventType };

export interface PendingDelivery {
  event: RoutedEvent;
  node: string;
}

export interface MarkMeta {
  session?: string;
  digest?: string;
}

/** T245: one row of a node's Activity: the event, why it came, and what became of it. */
export interface ActivityEntry {
  event: RoutedEvent;
  because: RoutingEntry['because'];
  status: EventDeliveryStatus;
  delivered_at?: string;
  session?: string;
  digest?: string;
}

/** Cap on Activity rows returned, newest first. */
export const ACTIVITY_MAX = 200;

export class RoutedEventService {
  private byId: Map<string, RoutedEvent> | undefined;
  private readonly listeners: ((event: RoutedEvent) => void)[] = [];

  constructor(
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private index(): Map<string, RoutedEvent> {
    if (this.byId === undefined) {
      this.byId = new Map(this.store.readRoutedEvents().map((e) => [e.id, e]));
    }
    return this.byId;
  }

  async emit(input: EmitInput): Promise<RoutedEvent> {
    const event = { ...input, id: `E-${ulid()}`, at: this.now().toISOString() };
    const deliveries = input.routing.map((r) => ({
      event: event.id,
      node: r.node,
      status: 'pending',
    }));
    const stored = await this.store.appendRoutedEvent(event, deliveries);
    this.index().set(stored.id, stored);
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        // A listener never fails the emit: the event is already stored.
      }
    }
    return stored;
  }

  onEmitted(listener: (event: RoutedEvent) => void): void {
    this.listeners.push(listener);
  }

  get(id: RoutedEventId | string): RoutedEvent | undefined {
    return this.index().get(id);
  }

  /** The latest status of each event in the node's queue, in first-seen order. */
  private statuses(node: string): Map<string, EventDeliveryStatus> {
    const out = new Map<string, EventDeliveryStatus>();
    for (const line of this.store.readDeliveries(node)) out.set(line.event, line.status);
    return out;
  }

  /**
   * T245: every event routed to `node`, newest first, with its reason and
   * the latest delivery line (status, and the session or digest that carried it).
   */
  activityFor(node: string, limit = ACTIVITY_MAX): ActivityEntry[] {
    const latest = new Map<string, Delivery>();
    for (const line of this.store.readDeliveries(node)) latest.set(line.event, line);
    const out: ActivityEntry[] = [];
    for (const [id, line] of latest) {
      const event = this.get(id);
      if (event === undefined) continue;
      const because = event.routing.find((r) => r.node === node)?.because ?? 'self';
      out.push({
        event,
        because,
        status: line.status,
        ...(line.delivered_at !== undefined ? { delivered_at: line.delivered_at } : {}),
        ...(line.session !== undefined ? { session: line.session } : {}),
        ...(line.digest !== undefined ? { digest: line.digest } : {}),
      });
    }
    return out.reverse().slice(0, limit);
  }

  /** T245: the repo view's events: every event on `repo`, newest first. */
  forRepo(repo: string, limit = ACTIVITY_MAX): RoutedEvent[] {
    return this.recent(limit, (e) => e.repo === repo);
  }

  /** T338: the event log: every routed event (or those `keep` passes), newest first. */
  recent(limit = ACTIVITY_MAX, keep: (e: RoutedEvent) => boolean = () => true): RoutedEvent[] {
    return [...this.index().values()].filter(keep).reverse().slice(0, limit);
  }

  pendingFor(node: string): PendingDelivery[] {
    const pending: PendingDelivery[] = [];
    for (const [id, status] of this.statuses(node)) {
      if (status !== 'pending') continue;
      const event = this.get(id);
      if (event === undefined)
        throw new Error(`delivery for unknown event ${id} in ${node}'s queue`);
      pending.push({ event, node });
    }
    return pending;
  }

  async mark(
    node: string,
    ids: readonly string[],
    status: Exclude<EventDeliveryStatus, 'pending'>,
    meta: MarkMeta = {},
  ): Promise<void> {
    const statuses = this.statuses(node);
    for (const id of ids) {
      const current = statuses.get(id);
      if (current !== 'pending') {
        throw new Error(`delivery of ${id} to ${node} is ${current ?? 'absent'}, not pending`);
      }
    }
    const at = this.now().toISOString();
    await this.store.appendDeliveries(
      [...new Set(ids)].map((event) => ({
        event,
        node,
        status,
        ...(status === 'delivered' ? { delivered_at: at } : {}),
        ...meta,
      })),
    );
  }

  /** Re-adds `pending` for any routed node whose queue never got the event. Returns how many. */
  async recover(): Promise<number> {
    const missing: { event: string; node: string; status: 'pending' }[] = [];
    const seen = new Map<string, Set<string>>();
    for (const event of this.index().values()) {
      for (const { node } of event.routing) {
        let ids = seen.get(node);
        if (ids === undefined) {
          ids = new Set(this.store.readDeliveries(node).map((d) => d.event));
          seen.set(node, ids);
        }
        if (!ids.has(event.id)) missing.push({ event: event.id, node, status: 'pending' });
      }
    }
    if (missing.length > 0) await this.store.appendDeliveries(missing);
    return missing.length;
  }
}
