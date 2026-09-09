import { useState } from 'react';
import { raiseHalt, releaseHalt } from '../lib/api';
import type { FeedQuotaInfo } from '../lib/feed-types';

/**
 * §17 "Sprint strip" + "Redirecting when things go wrong": spend and the
 * vendor barometer live behind a top-bar icon, shown on demand (§17 "Layout
 * direction: ... Spend and the vendor barometer are hidden behind an icon
 * in the top bar"). The Halt button writes a global halt with
 * `raised_by: human` — same hook path as a discovery halt, no explanation
 * required (§17 "a Halt button that writes a global halt file ... no
 * explanation needed to stop the bleeding").
 */
export function TopBar({
  connected,
  quota,
  haltCount,
  activeHaltIds,
  onChanged,
}: {
  connected: boolean;
  quota: FeedQuotaInfo[];
  haltCount: number;
  activeHaltIds: string[];
  onChanged: () => void;
}) {
  const [showQuota, setShowQuota] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function halt() {
    setBusy(true);
    setError(undefined);
    try {
      await raiseHalt('raised from the control room');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (activeHaltIds.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await Promise.all(activeHaltIds.map((id) => releaseHalt(id)));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cr-topbar">
      <h1>Agile Agents · Control Room</h1>
      <span
        className="cr-conn-dot"
        data-status={connected ? 'open' : 'closed'}
        title={connected ? 'connected' : 'reconnecting'}
      />
      <div className="spacer" />
      {error && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span>}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="quota-toggle"
          onClick={() => setShowQuota((v) => !v)}
        >
          ⚡ spend
        </button>
        {showQuota && (
          <div className="cr-quota-popover" data-testid="quota-popover">
            {quota.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', margin: 0 }}>No quota data yet.</p>
            ) : (
              quota.map((q) => (
                <div key={`${q.vendor}/${q.account}`} className="cr-quota-row">
                  <span className="cr-conf-dot" data-conf={q.confidence} />
                  <span style={{ minWidth: 90 }}>
                    {q.vendor}/{q.account}
                  </span>
                  <span className="cr-quota-bar" data-low={q.remaining_fraction < 0.15}>
                    <span style={{ width: `${Math.round(q.remaining_fraction * 100)}%` }} />
                  </span>
                  <span style={{ fontSize: 11, minWidth: 34, textAlign: 'right' }}>
                    {Math.round(q.remaining_fraction * 100)}%
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {haltCount > 0 && (
        <button
          type="button"
          className="cr-icon-btn"
          disabled={busy}
          onClick={resume}
          data-testid="resume-btn"
        >
          Resume ({haltCount})
        </button>
      )}
      <button
        type="button"
        className="cr-icon-btn danger"
        disabled={busy}
        onClick={halt}
        data-testid="halt-btn"
      >
        Halt
      </button>
    </div>
  );
}
