import type { Policy } from '@agile-agents/shared';
import { PaneClose } from './PaneClose';

/**
 * Who decides — `policy.yaml` (§17 v2; mockup `#p-policy`). Read-only here
 * on purpose: the editor is Settings (T043 owns `PUT /api/policy`), and the
 * mockup's own pane is a table plus an "Open Settings" link.
 */
export function PolicyPane({
  policy,
  onOpenSettings,
}: { policy?: Policy; onOpenSettings?: () => void }) {
  const gates = policy?.gates ?? {};
  return (
    <div className="pane" data-testid="pane-policy">
      <div className="dochd">
        <span className="eyebrow">Who decides</span>
        <span className="file">policy.yaml</span>
        {onOpenSettings && (
          <button
            type="button"
            className="cr-icon-btn"
            data-testid="policy-open-settings"
            onClick={onOpenSettings}
          >
            Open Settings
          </button>
        )}
        <PaneClose />
      </div>
      <table>
        <thead>
          <tr>
            <th>Decision</th>
            <th>Decided by</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(gates).map(([gate, owner]) => (
            <tr key={gate} data-testid={`policy-gate-${gate}`}>
              <td className="mono">{gate}</td>
              <td>
                <b>{String(owner)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(gates).length === 0 && (
        <p style={{ color: 'var(--text-dim)' }}>No policy loaded.</p>
      )}
    </div>
  );
}
