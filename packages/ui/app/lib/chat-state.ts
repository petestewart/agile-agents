/**
 * The EM chat panel's state, as a pure reducer (T051).
 *
 * T041 put the thread on the bus and streamed the reply over `/ws`, and
 * `ChatPanel` folded those frames straight into a `useState` array. Two
 * defects lived in that fold:
 *
 * 1. nothing marked "a turn is running" — between Send and the first
 *    `chat_delta` the panel showed the human's line and no answer at all,
 *    and whatever text arrived first (which, until this ticket's daemon fix,
 *    could be a replay of the *previous* reply) appeared as a fully-formed
 *    EM bubble;
 * 2. a turn that failed or never answered left the panel waiting forever.
 *
 * So the pending EM bubble is now an explicit state (`pending: true`, empty
 * body → the thinking indicator), the in-flight turn is named
 * (`state.turnId`), and every `chat_delta` is matched to a line **by
 * `message_id`** — never by position, and never by "the last EM line".
 *
 * Pure and DOM-free on purpose: `bun test` covers the delta-to-turn matching
 * without a browser (the same reason `markdown.ts` is a string function).
 */

import type { ChatEntry } from './api';
import type { ChatFrame } from './ws';

export interface ChatLine {
  /**
   * The bus message id — the same id `chat_delta`/`chat_turn_end` frames
   * carry, so a streamed reply and its stored copy are one line, never two.
   * Until the daemon has named them, an optimistic line carries a local id
   * (`local:…`), which the `turn_started` action replaces with the real one.
   */
  id: string;
  from: 'you' | 'em';
  body: string;
  ts: string;
  /** Deltas for this line are still arriving. */
  streaming?: boolean;
  /** The turn has started and nothing has streamed yet: render the thinking indicator, never text. */
  pending?: boolean;
  /** The turn failed, timed out, or was never accepted — shown in the bubble instead of hanging. */
  error?: string;
  /** Appended by this browser before the daemon confirmed it; replaced by the stored copy on the next history read. */
  local?: boolean;
}

export interface ChatState {
  lines: ChatLine[];
  /**
   * The line the in-flight EM turn writes into — `PENDING_LINE_ID` until the
   * POST reports the reply id, then the reply id itself. `undefined` means no
   * turn is running, which is also what re-enables Send.
   */
  turnId?: string;
}

/** The placeholder's id between Send and the POST's `reply_id`. Namespaced so it can never collide with a ulid. */
export const PENDING_LINE_ID = 'local:pending-em';

/** The human's optimistic line id, replaced by the bus message's own id. */
export const PENDING_HUMAN_ID = 'local:pending-you';

export type ChatAction =
  /** A `GET /api/chat/em` read — the bus is the source of truth for everything it covers. */
  | { type: 'history'; entries: ChatEntry[] }
  /** Send clicked: the human's line and the EM's empty, thinking placeholder. */
  | { type: 'send'; body: string; ts: string }
  /** The POST came back: the daemon's ids for the two lines `send` appended. */
  | { type: 'turn_started'; messageId?: string; replyId?: string }
  /** The POST failed, or the daemon accepted the line with nothing to answer it. */
  | { type: 'send_failed'; reason: string }
  /** A `/ws` chat frame. */
  | { type: 'frame'; frame: ChatFrame; ts?: string }
  /** No `chat_turn_end` arrived within the client's budget. */
  | { type: 'turn_timeout'; reason: string };

export const initialChatState: ChatState = { lines: [] };

export function entryToLine(entry: ChatEntry): ChatLine {
  return {
    id: entry.id,
    from: entry.from === 'human' ? 'you' : 'em',
    body: entry.body,
    ts: entry.ts,
  };
}

function replaceLine(lines: ChatLine[], id: string, patch: Partial<ChatLine>): ChatLine[] {
  const at = lines.findIndex((l) => l.id === id);
  if (at === -1) return lines;
  const next = [...lines];
  next[at] = { ...next[at], ...patch } as ChatLine;
  return next;
}

/**
 * Folds one action into the panel's state. Total: an unknown id, a frame for
 * a turn this browser never started (a second tab's send) and a duplicate
 * `chat_turn_end` all have defined, non-destructive outcomes.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history': {
      const stored = action.entries.map(entryToLine);
      const byId = new Map(stored.map((l) => [l.id, l]));
      // An error the daemon reported over `/ws` is not in the stored body
      // (the bus copy reads "(the EM session could not answer: …)"), so it is
      // carried onto the stored line rather than lost to the re-read.
      for (const prior of state.lines) {
        if (prior.error === undefined) continue;
        const hit = byId.get(prior.id);
        if (hit) hit.error = prior.error;
      }
      /**
       * What survives a history read: only lines the bus does not have yet
       * *and* that belong to a turn still in flight. A placeholder with no
       * live turn is dropped — which is what makes "a reload never shows a
       * placeholder" true by construction, since a reload starts from
       * `initialChatState` with no `turnId` at all.
       */
      const inFlight = state.lines.filter(
        (l) =>
          !byId.has(l.id) &&
          state.turnId !== undefined &&
          (l.id === state.turnId || l.local === true || l.streaming === true),
      );
      return { ...state, lines: [...stored, ...inFlight] };
    }

    case 'send': {
      // One turn at a time: a second send while a turn is in flight is
      // refused here as well as disabled in the UI.
      if (state.turnId !== undefined) return state;
      return {
        lines: [
          ...state.lines,
          { id: PENDING_HUMAN_ID, from: 'you', body: action.body, ts: action.ts, local: true },
          {
            id: PENDING_LINE_ID,
            from: 'em',
            body: '',
            ts: action.ts,
            pending: true,
            local: true,
          },
        ],
        turnId: PENDING_LINE_ID,
      };
    }

    case 'turn_started': {
      let lines = state.lines;
      if (action.messageId !== undefined) {
        lines = replaceLine(lines, PENDING_HUMAN_ID, { id: action.messageId });
      }
      if (action.replyId === undefined) return { ...state, lines };
      // The reply id names the turn from here on: `chat_delta` frames carry
      // it, and so does the stored reply, so adopting it is what makes the
      // streamed bubble and its bus copy one line.
      const target = state.turnId ?? PENDING_LINE_ID;
      // T111: the turn can already be over by the time this POST response
      // lands — a session that fails on spawn ends before the browser learns
      // the reply id, and `chat_turn_end` has already patched the
      // placeholder and cleared `turnId`. Re-arming it here would leave the
      // panel waiting forever for an end frame that has been and gone (the
      // input stays disabled, "the EM is answering" stays on screen). Adopt
      // the id either way, but only re-arm a turn still in flight.
      const ended =
        state.turnId === undefined &&
        lines.some((l) => l.id === target && l.pending !== true && l.streaming !== true);
      lines = replaceLine(lines, target, { id: action.replyId });
      return ended ? { lines } : { lines, turnId: action.replyId };
    }

    // Both end the turn the same way: the reason goes in the bubble, and the
    // input unblocks — a chat that waits forever on a turn nobody will finish
    // is the defect, not a safe default.
    case 'send_failed':
    case 'turn_timeout': {
      const turnId = state.turnId;
      if (turnId === undefined) return state;
      return {
        lines: replaceLine(state.lines, turnId, {
          pending: false,
          streaming: false,
          error: action.reason,
        }),
        turnId: undefined,
      };
    }

    case 'frame': {
      const frame = action.frame;
      if (frame.type === 'chat_delta') {
        const at = state.lines.findIndex((l) => l.id === frame.message_id);
        if (at !== -1) {
          const line = state.lines[at] as ChatLine;
          return {
            ...state,
            lines: replaceLine(state.lines, frame.message_id, {
              body: `${line.body}${frame.text}`,
              pending: false,
              streaming: true,
            }),
          };
        }
        /**
         * The turn is this browser's, but its reply id arrived on the socket
         * before the POST's response did (the daemon streams as soon as the
         * turn is queued). The placeholder adopts the id — this is the "first
         * delta after the send" case, and it is why the frame's id, not a
         * position, decides which bubble text lands in.
         */
        if (state.turnId?.startsWith('local:')) {
          return {
            lines: replaceLine(state.lines, state.turnId, {
              id: frame.message_id,
              body: frame.text,
              pending: false,
              streaming: true,
            }),
            turnId: frame.message_id,
          };
        }
        // Someone else's turn (another tab, the pop-out window): a new line,
        // never an append to whatever happens to be last.
        return {
          ...state,
          lines: [
            ...state.lines,
            {
              id: frame.message_id,
              from: 'em',
              body: frame.text,
              ts: action.ts ?? new Date().toISOString(),
              streaming: true,
            },
          ],
        };
      }
      // `chat_turn_end`: the turn is over either way — the indicator goes,
      // and an error is rendered in the bubble rather than left to a toast.
      const patch: Partial<ChatLine> = {
        pending: false,
        streaming: false,
        ...(frame.error !== undefined
          ? { error: `the EM session could not answer: ${frame.error}` }
          : {}),
      };
      const known = state.lines.some((l) => l.id === frame.message_id);
      // An end for a turn this browser never saw a delta for still has to
      // land on the placeholder — but only while the placeholder is still
      // unnamed (`local:`), never on a turn already bound to another id.
      const unnamed = state.turnId?.startsWith('local:') === true ? state.turnId : undefined;
      const target = known ? frame.message_id : unnamed;
      if (target === undefined) return state;
      return {
        lines: replaceLine(state.lines, target, patch),
        turnId: state.turnId === target ? undefined : state.turnId,
      };
    }

    default:
      return state;
  }
}
