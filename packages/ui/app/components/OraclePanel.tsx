import type { KbId, KbIndex, OracleEntry, OracleId, OracleIndex } from '@agile-agents/shared';
import { useState } from 'react';
import { getKbFact, getOracleEntry, proposeOracleEdit } from '../lib/api';

type Selected =
  | { type: 'oracle'; id: OracleId; entry: OracleEntry; body: string }
  | { type: 'kb'; id: KbId; body: string };

/**
 * §17 "Oracle / KB viewer": Oracle pane renders decisions/specs from the
 * index; KB tab for the knowledge store. "Human edits are proposed, not
 * saved — they become a decision request the architect processes through
 * the write guard" — `proposeOracleEdit` is a `bus.send` to the architect
 * (`POST /api/oracle/propose`), never a direct write to `.agile/oracle` or
 * `.agile/knowledge`.
 */
export function OraclePanel({ oracle, kb }: { oracle: OracleIndex; kb: KbIndex }) {
  const [tab, setTab] = useState<'oracle' | 'kb'>('oracle');
  const [selected, setSelected] = useState<Selected | undefined>(undefined);
  const [proposal, setProposal] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function openOracle(id: OracleId) {
    setError(undefined);
    try {
      const { entry, body } = await getOracleEntry(id);
      setSelected({ type: 'oracle', id, entry, body });
      setProposal('');
      setStatus(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openKb(id: KbId) {
    setError(undefined);
    try {
      const { body } = await getKbFact(id);
      setSelected({ type: 'kb', id, body });
      setProposal('');
      setStatus(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitProposal() {
    if (!selected || proposal.trim().length === 0) return;
    setError(undefined);
    try {
      await proposeOracleEdit(selected.id, proposal);
      setStatus('Sent to the architect as a decision request.');
      setProposal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const oracleIds = Object.keys(oracle) as OracleId[];
  const kbIds = Object.keys(kb) as KbId[];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0,1fr)', gap: 0 }}>
      <div style={{ borderRight: '1px solid var(--border)', maxHeight: 480, overflowY: 'auto' }}>
        <div style={{ display: 'flex', gap: 4, padding: '4px 4px 8px' }}>
          <button
            type="button"
            className="cr-icon-btn"
            aria-pressed={tab === 'oracle'}
            onClick={() => setTab('oracle')}
          >
            Oracle ({oracleIds.length})
          </button>
          <button
            type="button"
            className="cr-icon-btn"
            aria-pressed={tab === 'kb'}
            onClick={() => setTab('kb')}
          >
            KB ({kbIds.length})
          </button>
        </div>
        {tab === 'oracle'
          ? oracleIds.map((id) => (
              <button
                type="button"
                key={id}
                className="cr-list-row"
                data-testid={`oracle-item-${id}`}
                onClick={() => openOracle(id)}
                style={{ width: '100%', textAlign: 'left', border: 'none' }}
              >
                <span className="cr-badge">{id}</span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{oracle[id]?.title}</span>
              </button>
            ))
          : kbIds.map((id) => (
              <button
                type="button"
                key={id}
                className="cr-list-row"
                data-testid={`kb-item-${id}`}
                onClick={() => openKb(id)}
                style={{ width: '100%', textAlign: 'left', border: 'none' }}
              >
                <span className="cr-badge">{id}</span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{kb[id]?.kind}</span>
              </button>
            ))}
        {tab === 'oracle' && oracleIds.length === 0 && (
          <p style={{ color: 'var(--text-dim)', padding: 8 }}>No Oracle entries yet.</p>
        )}
        {tab === 'kb' && kbIds.length === 0 && (
          <p style={{ color: 'var(--text-dim)', padding: 8 }}>No knowledge-store facts yet.</p>
        )}
      </div>
      <div style={{ padding: '4px 16px', maxHeight: 480, overflowY: 'auto' }}>
        {!selected && <p style={{ color: 'var(--text-dim)' }}>Select an entry to read it.</p>}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        {selected && (
          <div>
            <h3 style={{ marginBottom: 4 }}>
              {selected.id}
              {selected.type === 'oracle' ? ` · ${selected.entry.title}` : ''}
            </h3>
            {selected.type === 'oracle' && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
                status {selected.entry.status}
                {selected.entry.supersedes ? ` · supersedes ${selected.entry.supersedes}` : ''}
                {selected.entry.depends.length
                  ? ` · depends ${selected.entry.depends.join(', ')}`
                  : ''}
                {selected.entry.affects.length
                  ? ` · affects ${selected.entry.affects.join(', ')}`
                  : ''}
              </div>
            )}
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{selected.body}</pre>

            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <label htmlFor="propose-edit" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                Propose an edit — opens a decision request to the architect; the write guard and
                ripple walk still run.
              </label>
              <textarea
                id="propose-edit"
                className="cr-textarea"
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                placeholder="Describe the change…"
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="cr-icon-btn"
                  data-testid="propose-edit-submit"
                  disabled={proposal.trim().length === 0}
                  onClick={submitProposal}
                >
                  Propose edit
                </button>
                {status && <span style={{ color: 'var(--ok)', fontSize: 12 }}>{status}</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
