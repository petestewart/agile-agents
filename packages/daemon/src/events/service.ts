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
 * - `recover()`: run once at startup. A crash between the log append and
 *   the queue append leaves an event with no delivery; this re-adds its
 *   `pending` lines, so nothing routed is dropped.
 */

import {
  type EventDeliveryStatus,
  type RoutedEvent,
  type RoutedEventId,
  type RoutedEventType,
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

export class RoutedEventService {
  private byId: Map<string, RoutedEvent> | undefined;

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
    return stored;
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
