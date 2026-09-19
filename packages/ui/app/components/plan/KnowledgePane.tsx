import type { KbFact } from '@agile-agents/shared';
import { useState } from 'react';
import { Markdown } from '../Markdown';
import { PaneClose } from './PaneClose';
import { putKnowledge } from './plan-api';

/**
 * Knowledge pane — `knowledge/facts/*.md` (§17 v2; mockup `#p-kb`): "things
 * the team learned about this repo that are worth not re-learning". Writes
 * go through `store.putKbFact`, which maintains `knowledge/index.yaml` and
 * mints a `kb_put` event.
 */
export function KnowledgePane({
  facts,
  onChanged,
}: { facts: Array<{ fact: KbFact; body: string }>; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  async function save() {
    setError(undefined);
    try {
      await putKnowledge({ ...(editing ? { id: editing } : {}), body });
      setAdding(false);
      setEditing(undefined);
      setBody('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-knowledge">
      <div className="dochd">
        <span className="eyebrow">Knowledge ({facts.length})</span>
        <span className="file">knowledge/facts/*.md</span>
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="fact-add"
          onClick={() => {
            setAdding(true);
            setEditing(undefined);
            setBody('');
          }}
        >
          Add fact
        </button>
        <PaneClose />
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {(adding || editing) && (
        <div className="rule" data-testid="fact-editor">
          <textarea
            className="cr-textarea"
            data-testid="fact-body"
            placeholder="Something about this repo worth not re-learning…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button type="button" className="cr-icon-btn" data-testid="fact-save" onClick={save}>
            Save
          </button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Fact</th>
            <th>Scope</th>
            <th>Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {facts.map(({ fact, body: text }) => (
            <tr key={fact.id} data-testid={`fact-${fact.id}`}>
              {/* `knowledge/facts/*.md` is markdown too (T049): a fact that
                  names a symbol in backticks should read as code, not as
                  backticks. The raw text is what the editor above holds. */}
              <td>
                <Markdown text={text} testId={`fact-body-${fact.id}`} />
              </td>
              <td className="mono">{fact.scope.join(', ')}</td>
              <td className="mono">{fact.source}</td>
              <td>
                <button
                  type="button"
                  className="cr-link"
                  data-testid={`fact-edit-${fact.id}`}
                  onClick={() => {
                    setEditing(fact.id);
                    setAdding(false);
                    setBody(text);
                  }}
                >
                  edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {facts.length === 0 && <p style={{ color: 'var(--text-dim)' }}>Nothing learned yet.</p>}
    </div>
  );
}
