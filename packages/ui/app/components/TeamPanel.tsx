import type { AgentId, AgentRecord, Halt, Stanza } from '@agile-agents/shared';
import { useState } from 'react';
import { getTicketDetail } from '../lib/api';

/**
 * §17 "Team": one row per registered agent — vendor/model, current ticket,
 * last heartbeat, latest board stanza. Halted agents striped. Click ->
 * stanza history (via the agent's current ticket's board, `store.
 * listStanzas`) + thread (bus thread is a later iteration — see report gap).
 */
export function TeamPanel({
  agents,
  halts,
}: {
  agents: Array<{ id: AgentId; record: AgentRecord }>;
  halts: Halt[];
}) {
  const [detail, setDetail] = useState<{ id: AgentId; stanzas: Stanza[] } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const haltedAgents = new Set(
    halts.flatMap((h) => (Array.isArray(h.scope) ? [] : h.scope === 'global' ? ['*'] : [])),
  );

  async function open(agent: { id: AgentId; record: AgentRecord }) {
    setError(undefined);
    if (!agent.record.ticket) {
      setDetail({ id: agent.id, stanzas: [] });
      return;
    }
    try {
      const { stanzas } = await getTicketDetail(agent.record.ticket);
      setDetail({ id: agent.id, stanzas });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (agents.length === 0) return <p style={{ color: 'var(--text-dim)' }}>No registered agents.</p>;

  return (
    <div>
      {agents.map((a) => {
        const halted = haltedAgents.has('*');
        return (
          <button
            type="button"
            key={a.id}
            className="cr-list-row"
            onClick={() => open(a)}
            style={{ width: '100%', textAlign: 'left', border: 'none' }}
          >
            <span className={`cr-badge${halted ? ' status-halted' : ''}`}>{a.id}</span>
            <span style={{ flex: 1 }}>
              {a.record.vendor}/{a.record.model}
              {a.record.ticket ? ` · ${a.record.ticket}` : ''}
            </span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              {a.record.last_seen ? new Date(a.record.last_seen).toLocaleTimeString() : 'never'}
            </span>
          </button>
        );
      })}

      {detail && (
        <div
          className="cr-modal-backdrop"
          onClick={() => setDetail(undefined)}
          onKeyDown={(e) => e.key === 'Escape' && setDetail(undefined)}
          role="presentation"
        >
          <div
            className="cr-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <h2>{detail.id}</h2>
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            {detail.stanzas.length === 0 ? (
              <p style={{ color: 'var(--text-dim)' }}>No board stanzas yet.</p>
            ) : (
              detail.stanzas
                .slice(-10)
                .reverse()
                .map((s) => (
                  <div key={`${s.ts}-${s.kind}`} style={{ marginBottom: 10 }}>
                    <div className="meta" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                      {s.kind} · {s.ts}
                    </div>
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12.5 }}>
                      {JSON.stringify(s, null, 2)}
                    </pre>
                  </div>
                ))
            )}
            <div className="cr-modal-actions">
              <button type="button" className="cr-icon-btn" onClick={() => setDetail(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
