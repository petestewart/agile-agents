import type { TicketId } from '@agile-agents/shared';
import { useState } from 'react';
import { PaneClose } from './PaneClose';
import { type SprintBoard, type SprintRowTicket, moveTicket } from './plan-api';

/**
 * Sprints pane — `sprints/S-*.yaml` plus the projection (§17 v2; mockup
 * `#p-sprint`): "finished ones with review and report links, the next one
 * settled, later ones projected from the graph. Rows show a blocked/blocker
 * pill only, never the ticket lists; the ticket detail panel carries
 * blocked-by/blocks. One row action, **move**."
 */
function pill(ticket: SprintRowTicket) {
  if (ticket.blocked_by.length > 0) {
    return (
      <span className="pill warn" title={`blocked by ${ticket.blocked_by.length} ticket(s)`}>
        blocked
      </span>
    );
  }
  if (ticket.blocks.length > 0) {
    return (
      <span className="pill" title={`blocks ${ticket.blocks.length} ticket(s)`}>
        blocker
      </span>
    );
  }
  return <span className="left">—</span>;
}

export function SprintsPane({
  board,
  onChanged,
  onSelect,
}: {
  board: SprintBoard;
  onChanged: () => void;
  onSelect: (id: TicketId) => void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);

  async function move(id: TicketId, to: 'next' | 'later') {
    setError(undefined);
    try {
      await moveTicket(id, to);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-sprints">
      <div className="dochd">
        <span className="eyebrow">Sprints ({board.rows.length})</span>
        <span className="file">sprints/S-*.yaml</span>
        <PaneClose />
      </div>
      <p className="src">
        Each sprint is the frontier of the ticket graph when it starts. Only the next one is
        settled; later ones are projected and change whenever you change the graph.
      </p>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {board.rows.map((row) => (
        <div
          className="rule"
          key={`${row.id}-${row.state}`}
          data-testid={`sprint-row-${row.id}`}
          style={row.state === 'projected' ? { opacity: 0.75 } : undefined}
        >
          <span className="id">{row.id}</span>{' '}
          <b>
            {row.state === 'finished'
              ? `Done · ${row.done} of ${row.total} merged`
              : row.state === 'running'
                ? `Running · ${row.done} of ${row.total} done`
                : row.state === 'next'
                  ? 'Next'
                  : 'Projected'}
          </b>{' '}
          <span className="pill">{row.total} tickets</span>
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {row.tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <button
                      type="button"
                      className="cr-link"
                      data-testid={`sprint-ticket-${ticket.id}`}
                      onClick={() => onSelect(ticket.id)}
                    >
                      {ticket.id} · {ticket.title}
                    </button>
                  </td>
                  <td>{pill(ticket)}</td>
                  <td>
                    {(row.state === 'next' || row.state === 'projected') && (
                      <button
                        type="button"
                        className="cr-link"
                        data-testid={`sprint-move-${ticket.id}`}
                        onClick={() => move(ticket.id, row.state === 'next' ? 'later' : 'next')}
                      >
                        move
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {row.state === 'finished' && row.report && (
            <div className="src">
              <a href={`/${row.report}`}>report</a> · review at {row.review_at ?? 'sprint close'}
            </div>
          )}
        </div>
      ))}
      {board.rows.length === 0 && (
        <p style={{ color: 'var(--text-dim)' }}>Nothing to sprint on yet.</p>
      )}
    </div>
  );
}
