/**
 * The ACP side of the session-interface boundary (spec
 * `specs/agent-control-channel.md` §6.4 "Option C"): pure derivations from
 * the internal ACP-shaped event stream into the protocol-neutral contract in
 * `@shared/agent-session-contract` — turn-end mapping and final-assistant-
 * message extraction (the §5.2 reply).
 *
 * This module is the *only* place ACP vocabulary (`stopReason`,
 * `session/update` discriminants, `_terma/turn_ended`) meets the contract's
 * vocabulary (`status`, `error`, `reply`). A future transport (Codex
 * `app-server`, §12.2) writes its own sibling translator against the same
 * contract; nothing downstream of the contract may import this file's ACP
 * inputs.
 *
 * Everything here is a pure fold over already-decoded `AcpEvent`s — no I/O,
 * no daemon, no timers — mirroring `turn-state.ts`'s reducer style so the
 * derivations are trivially unit-testable. The stateful wiring (who holds
 * the fold, when it resets) belongs to the mailbox's session handle
 * (ACC-06), which consumes only the contract types these functions produce.
 */
import type {
  SessionReply,
  SessionTurnEnd,
  SessionTurnError,
} from "@shared/agent-session-contract";
import { REPLY_TEXT_MAX_CHARS } from "@shared/agent-session-contract";
import { ACP_TURN_ENDED_METHOD } from "@shared/acp-types";
import type { AcpEvent, WireAcpEvent } from "./types";

/**
 * Map the daemon-synthesized turn-end marker's `stopReason` to the neutral
 * turn-end signal. The daemon records `stopReason` as a string when the
 * `session/prompt` round trip resolved and `null` when it rejected
 * (`acp-session.ts`), so:
 *
 * - `null` → `failed` (`turn_failed`) — the turn did not finish cleanly.
 * - `"cancelled"` → `cancelled`, no error: an interrupted turn is an
 *   outcome, not a fault.
 * - any other string (`"end_turn"`, `"max_tokens"`, `"refusal"`, …) →
 *   `completed`: the round trip settled and the agent's reply text is what
 *   it is. Distinguishing harness-specific early-stop reasons is exactly the
 *   vendor vocabulary the contract keeps out; a transport with typed turn
 *   errors (Codex, §12.1) expresses them through its own translator instead.
 */
export function turnEndFromStopReason(stopReason: string | null): SessionTurnEnd {
  if (stopReason === null) {
    return {
      status: "failed",
      error: turnError("turn_failed", "The turn did not finish cleanly (prompt rejected)"),
    };
  }
  if (stopReason === "cancelled") return { status: "cancelled", error: null };
  return { status: "completed", error: null };
}

/**
 * Turn-end for an agent process that exited mid-turn. A dying agent emits no
 * `_terma/turn_ended` the consumer can rely on, so exit is a turn-end source
 * of its own — the same reason `session-driver.ts` settles on `onExit`.
 */
export function turnEndFromExit(exitCode: number): SessionTurnEnd {
  return {
    status: "failed",
    error: turnError("session_exited", `Agent process exited mid-turn (code ${exitCode})`),
  };
}

/** Turn-end for a transport-level error surfaced mid-turn. */
export function turnEndFromError(message: string): SessionTurnEnd {
  return { status: "failed", error: turnError("session_error", message) };
}

/**
 * Read the turn-end marker off one event, or null for every other frame.
 * The `_terma/turn_ended` notification is the only in-stream turn boundary
 * (see `turn-state.ts` for why "any frame ⇒ running" is wrong).
 */
export function turnEndFromEvent(event: AcpEvent | WireAcpEvent): SessionTurnEnd | null {
  if (event.acp !== "notification") return null;
  if (event.message.method !== ACP_TURN_ENDED_METHOD) return null;
  const stopReason = asRecord(event.message.params)?.stopReason;
  return turnEndFromStopReason(typeof stopReason === "string" ? stopReason : null);
}

/**
 * Accumulator for the §5.2 reply text: the **final assistant message** of a
 * turn, not the concatenation of everything the agent said.
 *
 * Message-boundary semantics match the conversation timeline's
 * (`acp-conversation.ts`): consecutive `agent_message_chunk` frames are
 * deltas of one streaming message; any other turn item — a thought chunk, a
 * tool call, a user echo — closes it, and a later `agent_message_chunk` run
 * starts a *new* message that replaces the previous run as the reply
 * candidate. Thoughts and tool traffic never enter `text`.
 *
 * `text` is clamped one char past `REPLY_TEXT_MAX_CHARS` while folding, so
 * an unbounded stream cannot grow the state; `replyFromFinalMessage` turns
 * the overflow into `truncated: true`.
 */
export interface FinalMessageState {
  text: string;
  /** Whether an agent message is currently streaming (next chunk appends). */
  streaming: boolean;
}

export const INITIAL_FINAL_MESSAGE: FinalMessageState = { text: "", streaming: false };

/** Fold one event into the final-message state. Non-turn frames change nothing. */
export function applyFinalMessageEvent(
  state: FinalMessageState,
  event: AcpEvent | WireAcpEvent
): FinalMessageState {
  if (event.acp !== "notification") return state;
  if (event.message.method !== "session/update") return state;
  const update = asRecord(asRecord(event.message.params)?.update);
  if (update === null || typeof update.sessionUpdate !== "string") return state;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const chunk = chunkText(update.content);
      if (chunk === null) return state;
      if (!state.streaming) return { text: clamp(chunk), streaming: true };
      // Already past the cap: appending cannot change the reply, so skip the
      // string concatenation instead of building it just to clamp it away.
      if (state.text.length > REPLY_TEXT_MAX_CHARS) return state;
      return { text: clamp(state.text + chunk), streaming: true };
    }
    // The daemon-synthesized prompt echo: a new turn is beginning, so the
    // previous turn's text is not this turn's reply. Resetting here makes
    // the fold self-anchoring even over a stream spanning turn boundaries.
    case "user_message_chunk":
      return { text: "", streaming: false };
    // A non-message turn item closes the streaming message. The accumulated
    // text stays as the candidate — it is only replaced if the agent speaks
    // again afterwards.
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
      return state.streaming ? { ...state, streaming: false } : state;
    // Metadata updates (`plan`, `usage_update`, `session_info_update`, …)
    // are not message-boundary evidence — a trailing `session_info_update`
    // arrives after turn end and must not disturb the reply.
    default:
      return state;
  }
}

/**
 * Assemble the normalized §5.2 reply from the folded final message and the
 * turn-end signal. On `failed`, `text` still carries whatever streamed
 * before the failure — often the best diagnostic there is.
 */
export function replyFromFinalMessage(
  state: FinalMessageState,
  end: SessionTurnEnd
): SessionReply {
  const truncated = state.text.length > REPLY_TEXT_MAX_CHARS;
  return {
    status: end.status,
    text: truncated ? state.text.slice(0, REPLY_TEXT_MAX_CHARS) : state.text,
    ...(end.error !== null ? { error: end.error } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function turnError(code: string, message: string): SessionTurnError {
  return { code, message };
}

/** Keep at most one char past the cap: enough to detect truncation, no more. */
function clamp(text: string): string {
  return text.length > REPLY_TEXT_MAX_CHARS + 1 ? text.slice(0, REPLY_TEXT_MAX_CHARS + 1) : text;
}

function chunkText(content: unknown): string | null {
  const record = asRecord(content);
  if (record === null) return null;
  return typeof record.text === "string" ? record.text : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
