import { useState } from 'react';
import { PaneClose } from './PaneClose';
import { type OracleDoc, putRule } from './plan-api';

/**
 * Rules pane — `oracle/specs/SPEC-*.md` (§17 v2; mockup `#p-rules`).
 *
 * "Editing a rule that tickets already depend on becomes a proposed
 * decision, so those tickets get re-checked" — that rule is enforced
 * daemon-side (`plan/service.ts`'s `putRule`); this pane shows which tickets
 * cite a rule up front, and reports which of the two happened after a save.
 */
export function RulesPane({ rules, onChanged }: { rules: OracleDoc[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  function startNew() {
    setEditing('new');
    setTitle('');
    setBody('');
    setStatus(undefined);
  }

  function startEdit(doc: OracleDoc) {
    setEditing(doc.entry.id);
    setTitle(doc.entry.title);
    setBody(doc.body);
    setStatus(undefined);
  }

  async function save() {
    setError(undefined);
    try {
      const result = await putRule({
        ...(editing && editing !== 'new' ? { id: editing } : {}),
        title,
        body,
      });
      setStatus(
        result.proposed
          ? `Proposed to the architect: ${result.cited_by?.join(', ')} already cite this rule, so it is re-checked rather than rewritten.`
          : `Saved as ${result.entry?.id}.`,
      );
      setEditing(undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-rules">
      <div className="dochd">
        <span className="eyebrow">Rules ({rules.length})</span>
        <span className="file">oracle/specs/SPEC-*.md</span>
        <button type="button" className="cr-icon-btn" data-testid="rule-add" onClick={startNew}>
          Add rule
        </button>
        <PaneClose />
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {status && (
        <p style={{ color: 'var(--ok)' }} data-testid="rule-status">
          {status}
        </p>
      )}
      {editing && (
        <div className="rule" data-testid="rule-editor">
          <input
            className="cr-textarea"
            data-testid="rule-title"
            style={{ minHeight: 0 }}
            placeholder="Rule title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="cr-textarea"
            data-testid="rule-body"
            placeholder="What every ticket must follow…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button type="button" className="cr-icon-btn" data-testid="rule-save" onClick={save}>
            Save rule
          </button>
        </div>
      )}
      {rules.map((doc) => (
        <div className="rule" key={doc.entry.id} data-testid={`rule-${doc.entry.id}`}>
          <span className="id">{doc.entry.id}</span> <b>{doc.entry.title}</b>{' '}
          <span className="cr-badge">{doc.entry.status}</span>
          <p style={{ whiteSpace: 'pre-wrap' }}>{doc.body}</p>
          <div className="src">
            {doc.cited_by.length > 0
              ? `Applies to: ${doc.cited_by.join(', ')} — an edit here becomes a proposed decision`
              : 'Not cited by any live ticket yet'}{' '}
            ·{' '}
            <button
              type="button"
              className="cr-icon-btn"
              data-testid={`rule-edit-${doc.entry.id}`}
              onClick={() => startEdit(doc)}
            >
              Edit
            </button>
          </div>
        </div>
      ))}
      {rules.length === 0 && !editing && <p style={{ color: 'var(--text-dim)' }}>No rules yet.</p>}
    </div>
  );
}
