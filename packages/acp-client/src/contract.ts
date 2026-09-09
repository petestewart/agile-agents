/**
 * Pure derivations from the ACP-shaped event stream into the vendor-neutral
 * turn/reply contract (`types.ts`): turn-end mapping and final-assistant-
 * message extraction.
 *
 * Provenance: lifted from Terma
 * (vendor/terma/src/main/lib/terminal-host/acp-session-contract.ts) and
 * adapted only in naming (`_terma/turn_ended` → `_agile/turn_ended`, via
 * `types.ts`'s `ACP_TURN_ENDED_METHOD`). This module is the *only* place ACP
 * vocabulary (`stopReason`, `session/update` discriminants) meets the
 * contract's vocabulary (`status`, `error`, reply text) — everything here is
 * a pure fold over already-decoded events, no I/O, no timers.
 */
import { ACP_TURN_ENDED_METHOD } from './types';
import type {
  AcpEvent,
  SessionReply,
  SessionTurnEnd,
  SessionTurnError,
  WireAcpEvent,
} from './types';
import { REPLY_TEXT_MAX_CHARS } from './types';

/**
 * Map the recorded turn-end marker's `stopReason` to the neutral turn-end
 * signal:
 *
 * - `null` → `failed` (`turn_failed`) — the turn did not finish cleanly
 *   (the `session/prompt` round trip rejected).
 * - `"cancelled"` → `cancelled`, no error: an interrupted turn is an
 *   outcome, not a fault.
 * - any other string (`"end_turn"`, `"max_tokens"`, `"refusal"`, …) →
 *   `completed`: the round trip settled and the agent's reply text is what
 *   it is. Distinguishing harness-specific early-stop reasons is exactly the
 *   vendor vocabulary the contract keeps out.
 */
export function turnEndFromStopReason(stopReason: string | null): SessionTurnEnd {
  if (stopReason === null) {
    return {
      status: 'failed',
      error: turnError('turn_failed', 'The turn did not finish cleanly (prompt rejected)'),
    };
  }
  if (stopReason === 'cancelled') return { status: 'cancelled', error: null };
  return { status: 'completed', error: null };
}

/** Turn-end for an agent process that exited mid-turn. */
export function turnEndFromExit(exitCode: number): SessionTurnEnd {
  return {
    status: 'failed',
    error: turnError('session_exited', `Agent process exited mid-turn (code ${exitCode})`),
  };
}

/** Turn-end for a transport-level error surfaced mid-turn. */
export function turnEndFromError(message: string): SessionTurnEnd {
  return { status: 'failed', error: turnError('session_error', message) };
}

/**
 * Read the turn-end marker off one event, or null for every other frame.
 * The turn-ended notification is the only in-stream turn boundary.
 */
export function turnEndFromEvent(event: AcpEvent | WireAcpEvent): SessionTurnEnd | null {
  if (event.acp !== 'notification') return null;
  if (event.message.method !== ACP_TURN_ENDED_METHOD) return null;
  const stopReason = asRecord(event.message.params)?.stopReason;
  return turnEndFromStopReason(typeof stopReason === 'string' ? stopReason : null);
}

/**
 * Accumulator for the reply text: the **final assistant message** of a turn,
 * not the concatenation of everything the agent said.
 *
 * Consecutive `agent_message_chunk` frames are deltas of one streaming
 * message; any other turn item — a thought chunk, a tool call, a user echo
 * — closes it, and a later `agent_message_chunk` run starts a *new* message
 * that replaces the previous run as the reply candidate. Thoughts and tool
 * traffic never enter `text`.
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

export const INITIAL_FINAL_MESSAGE: FinalMessageState = { text: '', streaming: false };

/** Fold one event into the final-message state. Non-turn frames change nothing. */
export function applyFinalMessageEvent(
  state: FinalMessageState,
  event: AcpEvent | WireAcpEvent,
): FinalMessageState {
  if (event.acp !== 'notification') return state;
  if (event.message.method !== 'session/update') return state;
  const update = asRecord(asRecord(event.message.params)?.update);
  if (update === null || typeof update.sessionUpdate !== 'string') return state;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const chunk = chunkText(update.content);
      if (chunk === null) return state;
      if (!state.streaming) return { text: clamp(chunk), streaming: true };
      // Already past the cap: appending cannot change the reply, so skip the
      // string concatenation instead of building it just to clamp it away.
      if (state.text.length > REPLY_TEXT_MAX_CHARS) return state;
      return { text: clamp(state.text + chunk), streaming: true };
    }
    // The recorded prompt echo: a new turn is beginning, so the previous
    // turn's text is not this turn's reply. Resetting here makes the fold
    // self-anchoring even over a stream spanning turn boundaries.
    case 'user_message_chunk':
      return { text: '', streaming: false };
    // A non-message turn item closes the streaming message. The accumulated
    // text stays as the candidate — it is only replaced if the agent speaks
    // again afterwards.
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
      return state.streaming ? { ...state, streaming: false } : state;
    // Metadata updates (`plan`, `usage_update`, `session_info_update`, …)
    // are not message-boundary evidence.
    default:
      return state;
  }
}

/**
 * Assemble the normalized reply from the folded final message and the
 * turn-end signal. On `failed`, `text` still carries whatever streamed
 * before the failure — often the best diagnostic there is.
 */
export function replyFromFinalMessage(state: FinalMessageState, end: SessionTurnEnd): SessionReply {
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
  return typeof record.text === 'string' ? record.text : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
