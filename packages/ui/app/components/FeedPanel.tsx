import type { Event } from '@agile-agents/shared';
import { useMemo, useState } from 'react';

const FILTERS: Array<{ label: string; test: (e: Event) => boolean }> = [
  { label: 'all', test: () => true },
  { label: 'halts', test: (e) => e.kind === 'halt_created' || e.kind === 'halt_released' },
  { label: 'decisions', test: (e) => e.kind === 'oracle_put' },
  {
    label: 'verdicts',
    test: (e) =>
      e.kind === 'message' && typeof e.data.kind === 'string' && e.data.kind.includes('verdict'),
  },
  { label: 'denials', test: (e) => e.kind === 'hook_decision' && e.data.decision === 'deny' },
  {
    label: 'quota',
    test: (e) => e.kind === 'quota_low' || e.kind === 'quota_exhausted' || e.kind === 'quota_put',
  },
];

/**
 * §17 "Feed": event log tailed live, filterable by ticket/agent/kind.
 * Renders the tail already carried by `FeedSnapshot.events` plus live `/ws`
 * event frames appended by `App`; the daemon caps how far back it goes
 * (`DEFAULT_SNAPSHOT_EVENT_LIMIT`), this panel just filters and slices for
 * display.
 */
export function FeedPanel({ events }: { events: Event[] }) {
  const [filter, setFilter] = useState(0);
  const [ticketFilter, setTicketFilter] = useState('');

  const filtered = useMemo(() => {
    const byKind = events.filter(FILTERS[filter]?.test ?? (() => true));
    const byTicket = ticketFilter
      ? byKind.filter((e) => JSON.stringify(e).includes(ticketFilter))
      : byKind;
    return byTicket.slice(-100).reverse();
  }, [events, filter, ticketFilter]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {FILTERS.map((f, i) => (
          <button
            type="button"
            key={f.label}
            className="cr-icon-btn"
            aria-pressed={filter === i}
            style={
              filter === i ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined
            }
            onClick={() => setFilter(i)}
          >
            {f.label}
          </button>
        ))}
        <input
          placeholder="filter by id (ticket/agent)…"
          value={ticketFilter}
          onChange={(e) => setTicketFilter(e.target.value)}
          style={{
            marginLeft: 'auto',
            font: 'inherit',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '4px 8px',
            background: 'var(--bg)',
            color: 'var(--text)',
          }}
        />
      </div>
      {filtered.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>No matching events yet.</p>
      ) : (
        <table className="cr-events-table" id="events-body-table">
          <tbody id="events-body">
            {filtered.map((e, i) => (
              <tr key={`${e.ts}-${e.kind}-${i}`}>
                <td style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </td>
                <td className="kind">{e.kind}</td>
                <td style={{ wordBreak: 'break-word' }}>
                  {e.ticket ? `${e.ticket} · ` : ''}
                  {e.agent ? `${e.agent} · ` : ''}
                  {JSON.stringify(e.data)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
