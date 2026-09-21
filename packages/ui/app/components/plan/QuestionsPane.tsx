import type { Question } from '@agile-agents/shared';
import { useState } from 'react';
import { answerQuestion, raiseQuestion } from '../../lib/api';
import { PaneClose } from './PaneClose';

/**
 * Questions pane — `questions/Q-*.yaml` (§17 v2 "Questions vs
 * Decisions"; mockup `#p-q`). The store and its routes are T040's; this pane
 * is the Plan-screen view of them: open questions first, each answerable in
 * the operator's own words, either as a plain reply or recorded as a
 * decision ("Answering one records a Decision, edits a ticket or rule, or is
 * just a reply").
 */
export function QuestionsPane({
  questions,
  onChanged,
}: { questions: Question[]; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const open = questions.filter((q) => q.status === 'open');
  const answered = questions.filter((q) => q.status !== 'open');

  async function answer(id: string, resolvedAs: 'reply' | 'decision') {
    const text = drafts[id]?.trim();
    if (!text) return;
    setError(undefined);
    try {
      await answerQuestion(id, text, resolvedAs);
      setDrafts((prev) => ({ ...prev, [id]: '' }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function ask() {
    if (!asking.trim()) return;
    setError(undefined);
    try {
      await raiseQuestion(asking.trim());
      setAsking('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-questions">
      <div className="dochd">
        <span className="eyebrow">Open questions ({open.length})</span>
        <span className="file">questions/Q-*.yaml</span>
        <PaneClose />
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="rule">
        <input
          className="cr-textarea"
          data-testid="question-ask"
          style={{ minHeight: 0 }}
          placeholder="Ask one…"
          value={asking}
          onChange={(e) => setAsking(e.target.value)}
        />
        <button type="button" className="cr-icon-btn" data-testid="question-ask-send" onClick={ask}>
          Ask
        </button>
      </div>
      {open.map((q) => (
        <div className="rule" key={q.id} data-testid={`question-${q.id}`}>
          <span className="id">{q.id}</span> <b>{q.text}</b>
          <div className="src">
            Raised by {q.raised_by} · {q.stream}
          </div>
          <div className="reply">
            <input
              data-testid={`question-answer-${q.id}`}
              placeholder="Answer in your own words"
              value={drafts[q.id] ?? ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
            <button
              type="button"
              className="cr-icon-btn"
              data-testid={`question-reply-${q.id}`}
              onClick={() => answer(q.id, 'reply')}
            >
              Reply
            </button>
            <button
              type="button"
              className="cr-icon-btn"
              data-testid={`question-decide-${q.id}`}
              onClick={() => answer(q.id, 'decision')}
            >
              Record as a decision
            </button>
          </div>
        </div>
      ))}
      {open.length === 0 && <p style={{ color: 'var(--text-dim)' }}>Nothing open.</p>}
      {answered.length > 0 && (
        <div className="src" style={{ marginTop: 10 }}>
          {answered.length} answered — each one is in Decisions or on its ticket.
        </div>
      )}
    </div>
  );
}
