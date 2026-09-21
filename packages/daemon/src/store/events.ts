/**
 * Event construction and reconstruction (T123 — cockpit design §7.4).
 *
 * Construction: every `StateStore` mutation builds exactly one `Event` here
 * and the store appends it to `<home>/log/events.jsonl`. `StateStore` is the
 * only writer of that file; services that are not themselves store
 * mutations (`GateService`, `QuestionService`, the hook endpoint, the
 * runner) go through the store's public `appendEvent`.
 *
 * Durability: §7.4 asks for an `fsync` on gate and land events — the two
 * kinds whose loss would be silently wrong (a gate resolved but forgotten
 * lets a run proceed on an answer nobody can audit; a land event lost
 * leaves a merged branch unrecorded). `needsFsync` is that rule, kept pure
 * and prefix-based so T141's `land_*` kinds are covered the day they are
 * added.
 *
 * Reconstruction: `reconstructStreams` rebuilds every stream's status pair
 * from the log alone. It is the check that keeps "every state change emits
 * exactly one event" honest — if a stream mutation forgets its event, or
 * emits one without the status pair, the reconstruction diverges from the
 * records on disk and `events.test.ts` fails.
 */

import type { Event, EventKind } from '@agile-agents/shared';
import { validateEvent } from '@agile-agents/shared';

export interface BuildEventInput {
  /** The stream this event is about (`agile tail --stream`). */
  stream?: string;
  /** The agent session this event came from (`agile tail --session`). */
  session?: string;
  /** Pre-reshape agent id — hook path and agent registry only. */
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

/**
 * §7.4: "fsync on gate and land events". Prefix-based on purpose — every
 * kind in the gate family (`gate_raised`, `gate_resolved`) and every
 * `land_*` kind T141 adds is covered without a second list to keep in sync.
 */
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
 * Rebuilds `{stream id → {agent_status, human_status, archived}}` from the
 * event log alone. Pure: it reads nothing but the events it is given, in
 * order, so a test can compare its output against what the store's own
 * `listStreams` reads off disk.
 *
 * Every stream event carries the *resulting* status pair in `data`, so the
 * last event for a stream is the whole answer for that stream — no need to
 * replay patches. A stream event missing its pair is a bug in the emitter,
 * and shows up here as a divergence from the records.
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
