import type { FeedSnapshot, Halt, Policy } from '@agile-agents/shared';

/**
 * §17 "Sprint strip": goal, tickets done, token burn vs budget, global halt
 * count. "Gate chips" (session scope) renders `policy.gates` (the daemon's
 * `.agile/policy.yaml`, `store.getPolicy()`) — the gate-name -> owner table
 * a human reads to know what's auto-decided vs routed to them.
 */
export function SprintStrip({
  sprint,
  halts,
  gates,
}: {
  sprint: FeedSnapshot['sprint'];
  halts: Halt[];
  gates?: Policy['gates'];
}) {
  const { tickets } = sprint;
  return (
    <div className="cr-panel">
      <div className="cr-sprint-strip">
        <div className="cr-stat">
          <span className="label">Sprint</span>
          <span className="value">{sprint.sprint?.id ?? 'none'}</span>
        </div>
        <div className="cr-stat">
          <span className="label">Goal</span>
          <span className="value">{sprint.sprint?.goal ?? '—'}</span>
        </div>
        <div className="cr-stat">
          <span className="label">Done</span>
          <span className="value">
            {tickets.done}/{tickets.total}
          </span>
        </div>
        <div className="cr-stat">
          <span className="label">In flight</span>
          <span className="value">{tickets.in_flight}</span>
        </div>
        <div className="cr-stat">
          <span className="label">Stale</span>
          <span className="value">{tickets.stale}</span>
        </div>
        <div className="cr-stat">
          <span className="label">Halts</span>
          <span className="value" data-testid="halt-count">
            {halts.length}
          </span>
        </div>
        {halts.map((h) => (
          <span key={h.id} className="cr-gate-chip" title={h.reason}>
            {h.id}: {Array.isArray(h.scope) ? `${h.scope.length} tickets` : h.scope}
          </span>
        ))}
      </div>
      {gates && Object.keys(gates).length > 0 && (
        <div className="cr-sprint-strip" style={{ paddingTop: 0 }}>
          {Object.entries(gates).map(([name, owner]) => (
            <span key={name} className="cr-gate-chip" data-testid={`gate-chip-${name}`}>
              {name}: {String(owner)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
