/**
 * Event construction and reconstruction (§7.4). Every store mutation
 * builds one `Event` here; `StateStore` is the only writer of
 * `log/events.jsonl` (other services use `appendEvent`). Gate and land
 * events are fsynced: losing one would be silently wrong.
 * `reconstructStreams` rebuilds every stream's status pair from the log
 * alone, which keeps "every state change emits exactly one event" honest
 * (`events.test.ts`).
 */

import type { Event, EventKind } from '@agile-agents/shared';
import { validateEvent } from '@agile-agents/shared';

export interface BuildEventInput {
  /** The stream this event is about (`agile tail --stream`). */
  stream?: string;
  /** The agent session this event came from (`agile tail --session`). */
  session?: string;
  /** Agent id: hook path and agent registry only. */
  agent?: string;
  data?: Record<string, unknown>;
}

/** Builds (and validates) an `Event` of the given kind, ts stamped now. */
export function buildEvent(kind: EventKind, input: BuildEventInput = {}): Event {
  return validateEvent({
    ts: new Date().toISOString(),
    kind,
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    data: input.data ?? {},
  });
}

/** §7.4: fsync gate and land events; prefix-based, so new kinds in either family are covered. */
export function needsFsync(kind: EventKind | string): boolean {
  return kind.startsWith('gate_') || kind.startsWith('land_');
}

/** The status pair (plus archived flag) of one stream, as rebuilt from the log. */
export interface ReconstructedStream {
  agent_status: string;
  human_status: string;
  archived: boolean;
}

const STREAM_EVENT_KINDS: ReadonlySet<string> = new Set([
  'stream_created',
  'stream_updated',
  'stream_closed',
  'stream_archived',
]);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `{stream id → status pair + archived}` from the events alone, in order.
 * Each stream event carries the resulting pair, so the last one is the
 * answer; an event missing it shows up as a divergence from the records.
 */
export function reconstructStreams(events: readonly Event[]): Record<string, ReconstructedStream> {
  const streams: Record<string, ReconstructedStream> = {};
  for (const event of events) {
    if (!STREAM_EVENT_KINDS.has(event.kind)) continue;
    const id = event.stream ?? asString(event.data?.stream);
    if (id === undefined) continue;
    const agentStatus = asString(event.data?.agent_status);
    const humanStatus = asString(event.data?.human_status);
    if (agentStatus === undefined || humanStatus === undefined) continue;
    streams[id] = {
      agent_status: agentStatus,
      human_status: humanStatus,
      archived: event.data?.archived === true,
    };
  }
  return streams;
}
