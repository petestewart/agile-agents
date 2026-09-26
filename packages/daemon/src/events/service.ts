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
 * - `page({before, limit, repo})` (T383): the event log a page at a time,
 *   newest first, for the cockpit's Events and a repo card.
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

/** T383: the most events one page of the log may ask for. */
export const EVENT_PAGE_MAX = 500;

/** T383: which part of the log a page reads. */
export interface EventPageQuery {
  /** Only events older than this one (earlier in the log); the newest when absent. */
  before?: string;
  /** How many at most (default `ACTIVITY_MAX`). */
  limit?: number;
  /** Only the events on this repo. */
  repo?: string;
}

/** T383: one page of the log, newest first. */
export interface EventPage {
  events: RoutedEvent[];
  /** Older events that pass the filter exist beyond this page. */
  more: boolean;
  /** Every event in the log that passes the filter, on any page. */
  total: number;
}

/** T383: a page's `before` names no event in the log. */
export class UnknownEventError extends Error {
  constructor(readonly id: string) {
    super(`no event ${id} in the log`);
    this.name = 'UnknownEventError';
  }
}

/** The log in append order, and each event's place in it. */
interface LogIndex {
  list: RoutedEvent[];
  at: Map<string, number>;
}

export class RoutedEventService {
  private log: LogIndex | undefined;
  private readonly listeners: ((event: RoutedEvent) => void)[] = [];

  constructor(
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private index(): LogIndex {
    if (this.log === undefined) {
      const list = this.store.readRoutedEvents();
      this.log = { list, at: new Map(list.map((e, i) => [e.id, i])) };
    }
    return this.log;
  }

  async emit(input: EmitInput): Promise<RoutedEvent> {
    const event = { ...input, id: `E-${ulid()}`, at: this.now().toISOString() };
    const deliveries = input.routing.map((r) => ({
      event: event.id,
      node: r.node,
      status: 'pending',
    }));
    const stored = await this.store.appendRoutedEvent(event, deliveries);
    // A first read of the index after the append already holds it.
    const log = this.index();
    if (!log.at.has(stored.id)) {
      log.at.set(stored.id, log.list.length);
      log.list.push(stored);
    }
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
    const log = this.index();
    const i = log.at.get(id);
    return i === undefined ? undefined : log.list[i];
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
    return this.walk(this.index().list.length, limit, keep).events;
  }

  /**
   * T383: one page of the log, newest first. `before` pages back: only the
   * events older than that one (earlier in the append-only log, which is the
   * order they happened in). Throws `UnknownEventError` when `before` names
   * no event. `repo` keeps that repo's events, as `forRepo` does.
   */
  page(query: EventPageQuery = {}): EventPage {
    const log = this.index();
    let start = log.list.length;
    if (query.before !== undefined) {
      const at = log.at.get(query.before);
      if (at === undefined) throw new UnknownEventError(query.before);
      start = at;
    }
    const repo = query.repo;
    const keep = repo === undefined ? () => true : (e: RoutedEvent) => e.repo === repo;
    const { events, more } = this.walk(start, query.limit ?? ACTIVITY_MAX, keep);
    const total = repo === undefined ? log.list.length : log.list.filter(keep).length;
    return { events, more, total };
  }

  /** Up to `limit` events that `keep` passes, from just before `start` back; `more` if one was left. */
  private walk(
    start: number,
    limit: number,
    keep: (e: RoutedEvent) => boolean,
  ): { events: RoutedEvent[]; more: boolean } {
    const { list } = this.index();
    const events: RoutedEvent[] = [];
    for (let i = start - 1; i >= 0; i--) {
      const event = list[i] as RoutedEvent;
      if (!keep(event)) continue;
      if (events.length >= limit) return { events, more: true };
      events.push(event);
    }
    return { events, more: false };
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
    for (const event of this.index().list) {
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
