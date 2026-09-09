import type { HilRequest } from '@agile-agents/shared';
import { useState } from 'react';
import { approveHil, delegateHil } from '../lib/api';

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

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setSelected(undefined);
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
            <div
              key={item.id}
              className="cr-inbox-item hil-item"
              data-id={item.id}
              onClick={() => setSelected(item)}
              role="button"
              tabIndex={0}
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
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="cr-modal-backdrop" onClick={() => setSelected(undefined)}>
          <div className="cr-modal" onClick={(e) => e.stopPropagation()}>
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
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <div className="cr-modal-actions">
              <button
                className="cr-icon-btn approve"
                data-testid="hil-approve"
                disabled={busy}
                onClick={() => act(() => approveHil(selected.id))}
              >
                Approve
              </button>
              <button
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'em'))}
              >
                Delegate to EM
              </button>
              <button
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'architect'))}
              >
                Delegate to architect
              </button>
              <button className="cr-icon-btn" onClick={() => setSelected(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
