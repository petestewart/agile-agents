import type { Halt, Stanza, Ticket, TicketId } from '@agile-agents/shared';
import { useState } from 'react';
import { getTicketDetail } from '../lib/api';

const STATUS_ORDER: Ticket['status'][] = [
  'draft',
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
  'blocked',
  'stale',
  'done',
];

/**
 * §17 "Board": tickets columned by status. Tier/points on card, amber mark
 * when inside a halt scope. Click -> rendered ticket + thread/stanzas
 * (worktree diff is a documented gap, see report — no daemon read endpoint
 * exposes a worktree diff yet).
 */
export function BoardPanel({ tickets, halts }: { tickets: Ticket[]; halts: Halt[] }) {
  const [detail, setDetail] = useState<{ ticket: Ticket; stanzas: Stanza[] } | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  function inHaltScope(id: TicketId): boolean {
    return halts.some((h) => h.scope === 'global' || (Array.isArray(h.scope) && h.scope.includes(id)));
  }

  async function open(id: TicketId) {
    setError(undefined);
    try {
      const result = await getTicketDetail(id);
      setDetail(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const byStatus = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const list = byStatus.get(t.status) ?? [];
    list.push(t);
    byStatus.set(t.status, list);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }}>
        {STATUS_ORDER.filter((s) => (byStatus.get(s) ?? []).length > 0).map((status) => (
          <div key={status} style={{ minWidth: 180 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
              {status.toUpperCase()} ({byStatus.get(status)?.length ?? 0})
            </div>
            {(byStatus.get(status) ?? []).map((t) => (
              <div
                key={t.id}
                className="cr-list-row"
                data-testid={`ticket-card-${t.id}`}
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  borderLeft: inHaltScope(t.id) ? '3px solid var(--danger)' : undefined,
                }}
                onClick={() => open(t.id)}
                role="button"
                tabIndex={0}
              >
                <strong style={{ fontSize: 12.5 }}>
                  {t.id} {t.title}
                </strong>
                <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {t.tier} · {t.points}pt
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {detail && (
        <div className="cr-modal-backdrop" onClick={() => setDetail(undefined)}>
          <div className="cr-modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {detail.ticket.id} — {detail.ticket.title}
            </h2>
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {JSON.stringify(detail.ticket, null, 2)}
            </pre>
            <h3 style={{ fontSize: 13 }}>Stanzas ({detail.stanzas.length})</h3>
            {detail.stanzas
              .slice(-5)
              .reverse()
              .map((s, i) => (
                <pre key={i} style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                  {JSON.stringify(s, null, 2)}
                </pre>
              ))}
            <div className="cr-modal-actions">
              <button className="cr-icon-btn" onClick={() => setDetail(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
