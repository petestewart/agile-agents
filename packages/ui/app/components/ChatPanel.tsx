import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatEntry, getEmChat, getSnapshot, sendEmChat } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import { type FeedEmInfo, emLabel } from '../lib/feed-types';
import { Markdown } from './Markdown';

interface ChatLine {
  /** The bus message id — the same id `chat_delta`/`chat_turn_end` frames carry, so a streamed reply and its stored copy are one line, never two. */
  id: string;
  from: 'you' | 'em';
  body: string;
  ts: string;
  streaming?: boolean;
}

function entryToLine(entry: ChatEntry): ChatLine {
  return {
    id: entry.id,
    from: entry.from === 'human' ? 'you' : 'em',
    body: entry.body,
    ts: entry.ts,
  };
}

function upsert(lines: ChatLine[], line: ChatLine): ChatLine[] {
  const at = lines.findIndex((l) => l.id === line.id);
  if (at === -1) return [...lines, line];
  const next = [...lines];
  next[at] = line;
  return next;
}

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
 */
export function ChatPanel() {
  // T043: the socket is the shell's single `/ws` connection (`FeedProvider`),
  // not a second one opened by this panel — T041 left it owning its own,
  // which meant an in-page chat cost two sockets and two snapshot payloads.
  const { connected, onChat, snapshot } = useFeed();
  const [lines, setLines] = useState<ChatLine[]>([]);
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
      const thread = await getEmChat();
      setLines((prev) => {
        // Keep anything still streaming: the stored copy lands only when the
        // turn ends, and dropping the partial mid-turn would blank the panel.
        const streaming = prev.filter((l) => l.streaming);
        return streaming.reduce(upsert, thread.map(entryToLine));
      });
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
        if (frame.type === 'chat_delta') {
          setLines((prev) => {
            const existing = prev.find((l) => l.id === frame.message_id);
            return upsert(prev, {
              id: frame.message_id,
              from: 'em',
              ts: existing?.ts ?? new Date().toISOString(),
              body: `${existing?.body ?? ''}${frame.text}`,
              streaming: true,
            });
          });
          return;
        }
        setLines((prev) =>
          prev.map((l) => (l.id === frame.message_id ? { ...l, streaming: false } : l)),
        );
        if (frame.error) setError(`EM: ${frame.error}`);
        // The finished reply is on the bus by now — re-read so the panel
        // shows exactly what a reload would.
        void reload();
      }),
    [onChat, reload],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on every new/extended line, which is what `lines` changing means.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(undefined);
    setDraft('');
    try {
      const result = await sendEmChat(body);
      if (result.streaming === false && result.reason) setError(result.reason);
      // The human's line is on the bus now; the thread read is authoritative
      // (no optimistic-only append that a reload would contradict).
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          <div key={l.id} className="cr-chat-msg" data-from={l.from} data-id={l.id}>
            <div className="meta">
              {l.from} · {new Date(l.ts).toLocaleTimeString()}
            </div>
            {/* T049 defect 6: the EM writes markdown — bold, lists, fenced
                code — and it used to render as raw text. The human's own
                line stays verbatim: it is not markdown and echoing it as
                anything else would misquote them. */}
            {l.from === 'em' ? <Markdown text={l.body} /> : <div>{l.body}</div>}
          </div>
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
          placeholder="Steer, ask, or redirect…"
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
          disabled={busy || draft.trim().length === 0}
          onClick={send}
        >
          Send
        </button>
      </div>
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
