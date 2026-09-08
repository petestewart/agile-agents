/**
 * Decode ACP protocol frames off the daemon's session data channel.
 *
 * Kept separate from `types.ts`, which is the pure wire *contract* shared by
 * both ends of the socket and stays type-only. This is main-process decode
 * logic.
 */
import type { AcpJsonRpcMessage, WireAcpEvent } from "./types";

/**
 * Parse a `sessionData` payload from an ACP session. Returns null for
 * anything that is not a well-formed ACP envelope, so a malformed or
 * future-shaped frame is dropped rather than crashing the router.
 *
 * `seq` is carried through when the daemon stamped one. Dropping it here would
 * make de-duplicating a replay against the live stream impossible, since the
 * two share exactly one sequence space and nothing else. It is copied under an
 * explicit `typeof … === "number"` test rather than a truthiness one: the
 * `truncated` notice is `seq: 0`, and it is the one event whose loss is not
 * recoverable, because it is the event that announces loss.
 */
export function parseAcpEvent(data: string): WireAcpEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  // Spread, so an envelope the daemon did not stamp stays `seq`-free rather
  // than gaining a `seq: undefined` a consumer could compare against.
  const seq = typeof event.seq === "number" ? { seq: event.seq } : {};
  // Same explicit numeric test as `seq`, and for the same reason: a generation
  // is a plain number and dropping it would leave a live consumer unable to
  // notice that its timeline was replaced.
  const gen = typeof event.gen === "number" ? { gen: event.gen } : {};
  switch (event.acp) {
    case "initialized":
      return { acp: "initialized", result: event.result, ...seq, ...gen };
    case "notification":
      if (typeof event.message !== "object" || event.message === null) return null;
      return { acp: "notification", message: event.message as AcpJsonRpcMessage, ...seq, ...gen };
    case "request":
      if (typeof event.id !== "number" && typeof event.id !== "string") return null;
      if (typeof event.method !== "string") return null;
      return {
        acp: "request",
        id: event.id,
        method: event.method,
        params: event.params,
        ...seq,
        ...gen,
      };
    case "truncated":
      // Only ever leads a replay, never arrives live — but it travels the same
      // channel as real events by design, so it must decode on it too.
      if (typeof event.dropped !== "number") return null;
      return { acp: "truncated", dropped: event.dropped, ...seq, ...gen };
    default:
      return null;
  }
}
