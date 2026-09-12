import { useState } from 'react';
import { type BriefView, putBrief } from './plan-api';

/**
 * Brief pane — `oracle/product.md` (§17 v2; mockup `#p-brief`). Rendered as
 * the file's own text; "Edit" turns it into a textarea and saving goes
 * through `PUT /api/plan/brief`, i.e. the daemon's store, so the write is in
 * `events.jsonl` and on `agile-state`.
 */
export function BriefPane({ brief, onChanged }: { brief: BriefView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief.body);
  const [error, setError] = useState<string | undefined>(undefined);

  async function save() {
    setError(undefined);
    try {
      await putBrief(draft);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-brief">
      <div className="dochd">
        <span className="eyebrow">Brief</span>
        <span className="file">{brief.path}</span>
        {editing ? (
          <>
            <button type="button" className="cr-icon-btn" data-testid="brief-save" onClick={save}>
              Save
            </button>
            <button type="button" className="cr-icon-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="cr-icon-btn"
            data-testid="brief-edit"
            onClick={() => {
              setDraft(brief.body);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {editing ? (
        <textarea
          className="cr-textarea"
          data-testid="brief-text"
          style={{ minHeight: 260 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <div className="brief" data-testid="brief-body">
          {brief.stub && (
            <p style={{ color: 'var(--text-dim)' }}>
              No brief yet — type the goal in the chat and the architect writes this.
            </p>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{brief.body}</pre>
        </div>
      )}
    </div>
  );
}
