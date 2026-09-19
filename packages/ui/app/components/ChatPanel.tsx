import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { getEmChat, getSnapshot, sendEmChat } from '../lib/api';
import { type ChatLine, chatReducer, initialChatState } from '../lib/chat-state';
import { useFeed } from '../lib/feed-context';
import { type FeedEmInfo, emLabel } from '../lib/feed-types';
import { Markdown } from './Markdown';

/**
 * How long the panel waits for a `chat_turn_end` before it gives up on a
 * turn. The daemon's own per-turn budget is 120 s
 * (`em/resident.ts`'s `DEFAULT_EM_TURN_TIMEOUT_MS`), and it reports its
 * timeout as a `chat_turn_end` with an `error`, so this is deliberately
 * longer: it only fires when the socket dropped or the daemon died mid-turn —
 * the cases where no frame is ever coming and the panel would otherwise show
 * a thinking indicator forever.
 */
const TURN_WATCHDOG_MS = 150_000;

/** What the bubble says when the watchdog fires — the thread on the bus is still the authority, so it says where to look. */
const TURN_WATCHDOG_MESSAGE =
  'no reply arrived within 150s — the connection to the daemon may have dropped. Reload to re-read the thread.';

/**
 * §17 "EM chat" — the side panel over the EM's ACP stream.
 *
 * T041 closed the gap this panel shipped with in T025: the daemon now keeps
 * a resident EM session (`packages/daemon/src/em/resident.ts`), so a send
 * both lands on the EM's bus inbox (`POST /api/chat/em`) *and* streams the
 * EM's reply back over `/ws` as `chat_delta` frames, ending in one
 * `chat_turn_end`. History comes from the bus (`GET /api/chat/em`), never
 * from this component's own memory — which is what makes a reload, a second
 * tab, and the popped-out `/control-room/chat` window all show the same
 * thread.
 *
 * T051 made the *waiting* part honest. All of the panel's line state lives in
 * `lib/chat-state.ts`'s reducer now: Send appends the human's line plus an
 * empty, `pending` EM bubble that renders a thinking indicator, every
 * `chat_delta` is matched to a line by `message_id` (never by position or
 * "the last EM line"), `chat_turn_end` clears the indicator, and a failed,
 * refused or unanswered turn puts its reason in that same bubble instead of
 * leaving it spinning. The stale-text half of the defect was in the daemon —
 * `acp-client`'s `session.on()` replays the event ring, so the per-turn
 * listener `runTurn` used to attach handed the *previous* reply to the new
 * turn as its first deltas; fixed at that source, with a regression test in
 * `em/resident.test.ts`.
 */
export function ChatPanel() {
  // T043: the socket is the shell's single `/ws` connection (`FeedProvider`),
  // not a second one opened by this panel — T041 left it owning its own,
  // which meant an in-page chat cost two sockets and two snapshot payloads.
  const { connected, onChat, snapshot } = useFeed();
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const lines = chat.lines;
  /** A turn is in flight: the EM is answering, so Send is refused with a visible reason. */
  const turnInFlight = chat.turnId !== undefined;
  /**
   * T049 defect 5: the resident EM session's `vendor / model` for the header.
   * Seeded from the `/ws` snapshot (which only arrives on connect) and then
   * re-read with the thread, because the model is reported on the session's
   * `session/new` — i.e. on the *first* turn, long after the socket opened.
   * `claude / unknown` is what the ticket rejects, so the header shows only
   * what the session has actually reported.
   */
  const [em, setEm] = useState<FeedEmInfo | undefined>(undefined);
  /** Lets `reload` (which has no deps, by design) tell whether the model is still outstanding. */
  const emRef = useRef<FeedEmInfo | undefined>(undefined);
  emRef.current = em;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (snapshot?.em) setEm(snapshot.em);
  }, [snapshot?.em]);

  const reload = useCallback(async () => {
    try {
      // The socket's snapshot arrives on connect, which is before the
      // session has reported a model, so the header needs one more read —
      // but only while the model is still outstanding, never once per turn
      // forever (the snapshot carries the event window with it).
      if (emRef.current === undefined || emRef.current.model === 'unknown') {
        void getSnapshot()
          .then((snap) => {
            if (snap.em) setEm(snap.em);
          })
          .catch(() => {
            // The header degrades to "no session yet"; the thread read below
            // is what this function actually exists for.
          });
      }
      // The reducer keeps whatever belongs to a turn still in flight (the
      // partial reply, the placeholder) and takes everything else from the
      // bus — a history read mid-turn must not blank the pending bubble, and
      // a history read with no turn running must never show one.
      dispatch({ type: 'history', entries: await getEmChat() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      onChat((frame) => {
        dispatch({ type: 'frame', frame });
        if (frame.type === 'chat_turn_end') {
          // The finished reply is on the bus by now — re-read so the panel
          // shows exactly what a reload would.
          void reload();
        }
      }),
    [onChat, reload],
  );

  /**
   * The watchdog: without it a dropped socket or a dead daemon leaves the
   * thinking indicator running and the input disabled with no way out. Armed
   * per turn (`chat.turnId`), disarmed the moment the turn ends.
   */
  useEffect(() => {
    if (chat.turnId === undefined) return;
    const timer = setTimeout(
      () => dispatch({ type: 'turn_timeout', reason: TURN_WATCHDOG_MESSAGE }),
      TURN_WATCHDOG_MS,
    );
    return () => clearTimeout(timer);
  }, [chat.turnId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on every new/extended line, which is what `lines` changing means.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  async function send() {
    const body = draft.trim();
    // One turn at a time: the EM session serialises prompts anyway
    // (`ResidentEm`'s turn chain), and a second bubble waiting on a turn that
    // has not started is exactly the "pending bubble lying about its state"
    // this ticket is about.
    if (!body || busy || turnInFlight) return;
    setBusy(true);
    setError(undefined);
    setDraft('');
    // The human's line and the EM's empty, thinking placeholder go up before
    // the POST: the panel must never look idle between Send and the first
    // frame. Both carry local ids until the daemon names them just below.
    dispatch({ type: 'send', body, ts: new Date().toISOString() });
    try {
      const result = await sendEmChat(body);
      dispatch({
        type: 'turn_started',
        ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
        ...(result.reply_id !== undefined ? { replyId: result.reply_id } : {}),
      });
      if (result.streaming === false) {
        // Nothing is going to answer (no resident EM wired, e.g.): say so in
        // the bubble and free the input rather than waiting on a turn that
        // was never started.
        dispatch({
          type: 'send_failed',
          reason: result.reason ?? 'the daemon has no EM session to answer this',
        });
      }
      // The human's line is on the bus now; the thread read is authoritative
      // (the optimistic line above is replaced by its stored copy).
      await reload();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      dispatch({ type: 'send_failed', reason });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cr-chat-col">
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>em</strong>
        <span
          className="cr-chat-model"
          data-testid="chat-model"
          title={
            em
              ? `The resident EM session runs on ${emLabel(em)}`
              : 'No resident EM session has reported yet — send a message to start one'
          }
        >
          {em ? emLabel(em) : 'no session yet'}
        </span>
        <span className="cr-conn-dot" data-status={connected ? 'open' : 'closed'} />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
      <div className="cr-chat-log" ref={logRef} data-testid="chat-log">
        {lines.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
            Steer, ask, or redirect. Messages go to the EM&apos;s inbox and its reply streams back
            here.
          </p>
        )}
        {lines.map((l) => (
          <ChatMessage key={l.id} line={l} />
        ))}
        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 12 }} data-testid="chat-error">
            {error}
          </p>
        )}
      </div>
      <div className="cr-chat-input">
        <textarea
          className="cr-textarea"
          rows={2}
          value={draft}
          placeholder={turnInFlight ? 'The EM is answering…' : 'Steer, ask, or redirect…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="chat-send"
          // A send while a turn is in flight is refused, and the reason is on
          // screen (below) rather than only in this attribute.
          title={turnInFlight ? 'The EM is still answering the last message' : 'Send to the EM'}
          disabled={busy || turnInFlight || draft.trim().length === 0}
          onClick={send}
        >
          Send
        </button>
      </div>
      {turnInFlight && (
        <p className="cr-chat-note" data-testid="chat-busy">
          The EM is answering — one turn at a time.
        </p>
      )}
    </div>
  );
}

/**
 * One line. Three shapes, and which one renders is decided by the line's own
 * state, never by where it sits in the list: the thinking indicator while the
 * turn has produced nothing, the reply (markdown, streamed or stored), and the
 * turn's failure reason when it has one.
 */
function ChatMessage({ line }: { line: ChatLine }) {
  return (
    <div
      className="cr-chat-msg"
      data-from={line.from}
      data-id={line.id}
      {...(line.pending ? { 'data-pending': 'true' } : {})}
      {...(line.streaming ? { 'data-streaming': 'true' } : {})}
    >
      <div className="meta">
        {line.from} · {new Date(line.ts).toLocaleTimeString()}
      </div>
      {line.pending && (
        // `<output>` (implicit `role=status`) with `aria-live=polite`: a screen
        // reader hears "the EM is thinking" when the bubble appears, and hears
        // the reply when it replaces this.
        <output className="cr-chat-thinking" aria-live="polite" data-testid="chat-thinking">
          <span className="cr-chat-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>thinking…</span>
        </output>
      )}
      {/* T049 defect 6: the EM writes markdown — bold, lists, fenced
          code — and it used to render as raw text. The human's own
          line stays verbatim: it is not markdown and echoing it as
          anything else would misquote them. */}
      {!line.pending &&
        (line.from === 'em' ? <Markdown text={line.body} /> : <div>{line.body}</div>)}
      {line.error && (
        <p className="cr-chat-line-error" data-testid="chat-line-error">
          {line.error}
        </p>
      )}
    </div>
  );
}

/**
 * The pop-out window's whole page (`/control-room/chat`): the same panel,
 * the same `GET /api/chat/em` thread and the same `/ws` frames, with no
 * board around it. Routed in `main.tsx` off `location.pathname`.
 */
export function ChatWindow() {
  return (
    <div className="cr-root" data-view="chat">
      <div className="cr-frame" data-chat="max" data-main="closed">
        <ChatPanel />
      </div>
    </div>
  );
}
