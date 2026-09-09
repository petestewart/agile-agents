import { useState } from 'react';
import { sendEmChat } from '../lib/api';

interface ChatLine {
  from: 'you' | 'em';
  body: string;
  ts: number;
}

/**
 * §17 "EM chat": a side panel over the ACP stream — "steer -> action-set
 * cards (via `bus.send` to `em` and the feed WebSocket)". A true ACP stream
 * proxy (the EM's own typed message stream, §18 "Technical shape") is out
 * of this ticket's reach without touching `daemon.ts`/`index.ts` (off
 * limits to this worker) to spawn/relay the EM's child process — so this
 * ships the bus-backed half: every send lands on the EM's inbox via
 * `bus.send` (`POST /api/chat/em`) and appears in the event log, but the
 * EM's reply and any action-set card are not yet rendered here (documented
 * gap, `.pipeline-report.md`).
 */
export function ChatPanel({ connected }: { connected: boolean }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(undefined);
    setDraft('');
    setLines((prev) => [...prev, { from: 'you', body, ts: Date.now() }]);
    try {
      await sendEmChat(body);
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
        <span className="cr-conn-dot" data-status={connected ? 'open' : 'closed'} />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
      <div className="cr-chat-log">
        {lines.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
            Steer, ask, or redirect. Messages go straight to the EM&apos;s inbox and appear in the
            Feed. The EM&apos;s own reply and any steer → action-set card render only once the ACP
            stream proxy is wired up (gap noted for the manager).
          </p>
        )}
        {lines.map((l) => (
          <div key={`${l.ts}-${l.from}`} className="cr-chat-msg">
            <div className="meta">
              {l.from} · {new Date(l.ts).toLocaleTimeString()}
            </div>
            <div>{l.body}</div>
          </div>
        ))}
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
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
