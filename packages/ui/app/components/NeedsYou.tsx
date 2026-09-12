import type { HilRequest } from '@agile-agents/shared';
import { useState } from 'react';
import { approveHil, delegateHil, denyHil, noteHil } from '../lib/api';

/**
 * "Needs you" inbox (§17 "Attention queue" / session scope: "inbox-style
 * ... with detail-on-click and approve/delegate"). One line per item;
 * clicking opens detail + actions — never all details at once (§17 "Layout
 * direction").
 */
export function NeedsYou({ items, onChanged }: { items: HilRequest[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<HilRequest | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // T039: the typed answer that rides along with a button press — or, via
  // "Send note", stands alone (which resolves nothing; the EM decides).
  const [note, setNote] = useState('');

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setSelected(undefined);
      setNote('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {items.length === 0 ? (
        <p className="cr-empty-goal">Nothing needs you right now.</p>
      ) : (
        <div>
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className="cr-inbox-item hil-item"
              data-id={item.id}
              onClick={() => {
                setSelected(item);
                setNote('');
                setError(undefined);
              }}
            >
              <span className="cr-badge">{item.hil_kind}</span>
              <span style={{ flex: 1 }}>
                {item.gate}
                {item.ticket ? ` · ${item.ticket}` : ''}
              </span>
              {item.deadline && (
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  due {new Date(item.deadline).toLocaleTimeString()}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div
          className="cr-modal-backdrop"
          onClick={() => setSelected(undefined)}
          onKeyDown={(e) => e.key === 'Escape' && setSelected(undefined)}
          role="presentation"
        >
          <div
            className="cr-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <h2>
              {selected.gate} · {selected.hil_kind}
            </h2>
            <p>
              <strong>Requested:</strong> {new Date(selected.requested_at).toLocaleString()}
            </p>
            {selected.ticket && (
              <p>
                <strong>Ticket:</strong> {selected.ticket}
              </p>
            )}
            {selected.deadline && (
              <p>
                <strong>Deadline:</strong> {new Date(selected.deadline).toLocaleString()}
              </p>
            )}
            {selected.reason && (
              <p>
                <strong>Reason:</strong> {selected.reason}
              </p>
            )}
            {selected.note && (
              <p>
                <strong>Note:</strong> {selected.note}
              </p>
            )}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <label htmlFor="hil-note" style={{ display: 'block', marginTop: 8 }}>
              Your answer (optional)
            </label>
            <textarea
              id="hil-note"
              data-testid="hil-note"
              value={note}
              rows={3}
              style={{ width: '100%' }}
              placeholder="e.g. yes, but only for the seed script"
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="cr-modal-actions">
              <button
                type="button"
                className="cr-icon-btn approve"
                data-testid="hil-approve"
                disabled={busy}
                onClick={() => act(() => approveHil(selected.id, 'human', note.trim() || undefined))}
              >
                Approve
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="hil-deny"
                disabled={busy}
                onClick={() => act(() => denyHil(selected.id, 'human', note.trim() || undefined))}
              >
                Deny
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="hil-send-note"
                disabled={busy || note.trim().length === 0}
                title="Send this answer to the EM without deciding — the EM decides approve/deny from it"
                onClick={() => act(() => noteHil(selected.id, note.trim()))}
              >
                Send note
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'em'))}
              >
                Delegate to EM
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'architect'))}
              >
                Delegate to architect
              </button>
              <button type="button" className="cr-icon-btn" onClick={() => setSelected(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
