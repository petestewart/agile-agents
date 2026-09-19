import { useState } from 'react';
import { Markdown } from '../Markdown';
import { PaneClose } from './PaneClose';
import { type OracleDoc, publishDecision } from './plan-api';

/**
 * Decisions pane — `oracle/decisions/DEC-*.md` (§17 v2; mockup `#p-dec`):
 * "the permanent record of answered questions that changed something".
 *
 * Publishing goes through the oracle write guard, so the §4 ripple walk runs
 * *and* the architect re-examination pass runs over every not-done ticket
 * (§17 v2) — the result of both is reported back here, because a decision
 * that quietly staled three tickets is exactly what the operator needs told.
 */
export function DecisionsPane({
  decisions,
  onChanged,
}: { decisions: OracleDoc[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function publish() {
    setError(undefined);
    try {
      const result = await publishDecision({ title, body });
      const updated = result.reexamined.filter((r) => r.verdict !== 'unchanged');
      setStatus(
        `Published ${result.entry.id}. Ripple staled ${result.stale.length} ticket(s); re-examined ${result.reexamined.length}, changing ${updated.length}.`,
      );
      setOpen(false);
      setTitle('');
      setBody('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-decisions">
      <div className="dochd">
        <span className="eyebrow">Decisions ({decisions.length})</span>
        <span className="file">oracle/decisions/DEC-*.md</span>
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="decision-add"
          onClick={() => setOpen((v) => !v)}
        >
          Record a decision
        </button>
        <PaneClose />
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {status && (
        <p style={{ color: 'var(--ok)' }} data-testid="decision-status">
          {status}
        </p>
      )}
      {open && (
        <div className="rule" data-testid="decision-editor">
          <input
            className="cr-textarea"
            data-testid="decision-title"
            style={{ minHeight: 0 }}
            placeholder="What was decided"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="cr-textarea"
            data-testid="decision-body"
            placeholder="The question, the choice, and why"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="button"
            className="cr-icon-btn"
            data-testid="decision-publish"
            onClick={publish}
          >
            Publish
          </button>
        </div>
      )}
      {decisions.map((doc) => (
        <div className="rule" key={doc.entry.id} data-testid={`decision-${doc.entry.id}`}>
          <span className="id">{doc.entry.id}</span> <b>{doc.entry.title}</b>{' '}
          <span className="cr-badge">{`${doc.entry.status} · ${doc.entry.by}`}</span>
          {/* Markdown prose, for the same reason as the Rules pane (T049):
              `oracle/decisions/DEC-*.md` is a markdown file. The raw text is
              what the Record-a-decision textarea above holds. */}
          <Markdown text={doc.body} testId={`decision-body-${doc.entry.id}`} />
        </div>
      ))}
      {decisions.length === 0 && <p style={{ color: 'var(--text-dim)' }}>No decisions yet.</p>}
    </div>
  );
}
