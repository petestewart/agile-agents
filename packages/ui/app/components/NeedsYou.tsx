import type { HilRequest, Question } from '@agile-agents/shared';
import { useState } from 'react';
import { answerQuestion, approveHil, delegateHil, denyHil, noteHil } from '../lib/api';

/**
 * "Needs you" inbox (§17 "Attention queue" / session scope: "inbox-style
 * ... with detail-on-click and approve/delegate"). One line per item;
 * clicking opens detail + actions — never all details at once (§17 "Layout
 * direction").
 *
 * T040 (§17 "Control room v2" → "Questions vs Decisions"): an open
 * `Question` is a Needs-you card too — "a pending question is a Needs-you
 * card" (ticket scope). Minimal by design (a reply box and a "Record as
 * decision" button); T042/T044 restyle it.
 */
export function NeedsYou({
  items,
  questions = [],
  onChanged,
}: {
  items: HilRequest[];
  questions?: Question[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<HilRequest | undefined>(undefined);
  const [selectedQuestion, setSelectedQuestion] = useState<Question | undefined>(undefined);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // T039: the typed answer that rides along with a button press — or, via
  // "Send note", stands alone (which resolves nothing; the EM decides).
  const [note, setNote] = useState('');

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setSelected(undefined);
      setNote('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function answer(question: Question, resolvedAs: 'reply' | 'decision') {
    setBusy(true);
    setError(undefined);
    try {
      await answerQuestion(question.id, reply.trim(), resolvedAs);
      setSelectedQuestion(undefined);
      setReply('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {questions.length > 0 && (
        <div>
          {questions.map((question) => (
            <button
              type="button"
              key={question.id}
              className="cr-inbox-item question-item"
              data-id={question.id}
              onClick={() => {
                setSelectedQuestion(question);
                setReply('');
                setError(undefined);
              }}
            >
              <span className="cr-badge">question</span>
              <span style={{ flex: 1 }}>
                {question.text}
                {question.ticket ? ` · ${question.ticket}` : ''}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                from {question.raised_by}
              </span>
            </button>
          ))}
        </div>
      )}

      {items.length === 0 && questions.length === 0 ? (
        <p className="cr-empty-goal">Nothing needs you right now.</p>
      ) : (
        <div>
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className="cr-inbox-item hil-item"
              data-id={item.id}
              onClick={() => {
                setSelected(item);
                setNote('');
                setError(undefined);
              }}
            >
              <span className="cr-badge">{item.hil_kind}</span>
              <span style={{ flex: 1 }}>
                {item.gate}
                {item.ticket ? ` · ${item.ticket}` : ''}
              </span>
              {item.deadline && (
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  due {new Date(item.deadline).toLocaleTimeString()}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedQuestion && (
        <div
          className="cr-modal-backdrop"
          onClick={() => setSelectedQuestion(undefined)}
          onKeyDown={(e) => e.key === 'Escape' && setSelectedQuestion(undefined)}
          role="presentation"
        >
          <div
            className="cr-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <h2>Question · {selectedQuestion.raised_by}</h2>
            <p data-testid="question-text">{selectedQuestion.text}</p>
            {selectedQuestion.ticket && (
              <p>
                <strong>Ticket:</strong> {selectedQuestion.ticket}
              </p>
            )}
            {selectedQuestion.options && (
              <ul>
                {selectedQuestion.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
            )}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <label htmlFor="question-answer" style={{ display: 'block', marginTop: 8 }}>
              Your answer
            </label>
            <textarea
              id="question-answer"
              data-testid="question-answer"
              value={reply}
              rows={3}
              style={{ width: '100%' }}
              placeholder="e.g. the spec wins — refine the ticket against it"
              onChange={(e) => setReply(e.target.value)}
            />
            <div className="cr-modal-actions">
              <button
                type="button"
                className="cr-icon-btn approve"
                data-testid="question-reply"
                disabled={busy || reply.trim().length === 0}
                title="Answer the raiser — no decision recorded"
                onClick={() => answer(selectedQuestion, 'reply')}
              >
                Reply
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="question-decision"
                disabled={busy || reply.trim().length === 0}
                title="Answer and record it as a DEC-* through the oracle write guard"
                onClick={() => answer(selectedQuestion, 'decision')}
              >
                Record as decision
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                onClick={() => setSelectedQuestion(undefined)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div
          className="cr-modal-backdrop"
          onClick={() => setSelected(undefined)}
          onKeyDown={(e) => e.key === 'Escape' && setSelected(undefined)}
          role="presentation"
        >
          <div
            className="cr-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <h2>
              {selected.gate} · {selected.hil_kind}
            </h2>
            <p>
              <strong>Requested:</strong> {new Date(selected.requested_at).toLocaleString()}
            </p>
            {selected.ticket && (
              <p>
                <strong>Ticket:</strong> {selected.ticket}
              </p>
            )}
            {selected.deadline && (
              <p>
                <strong>Deadline:</strong> {new Date(selected.deadline).toLocaleString()}
              </p>
            )}
            {selected.reason && (
              <p>
                <strong>Reason:</strong> {selected.reason}
              </p>
            )}
            {selected.note && (
              <p>
                <strong>Note:</strong> {selected.note}
              </p>
            )}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
            <label htmlFor="hil-note" style={{ display: 'block', marginTop: 8 }}>
              Your answer (optional)
            </label>
            <textarea
              id="hil-note"
              data-testid="hil-note"
              value={note}
              rows={3}
              style={{ width: '100%' }}
              placeholder="e.g. yes, but only for the seed script"
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="cr-modal-actions">
              <button
                type="button"
                className="cr-icon-btn approve"
                data-testid="hil-approve"
                disabled={busy}
                onClick={() =>
                  act(() => approveHil(selected.id, 'human', note.trim() || undefined))
                }
              >
                Approve
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="hil-deny"
                disabled={busy}
                onClick={() => act(() => denyHil(selected.id, 'human', note.trim() || undefined))}
              >
                Deny
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="hil-send-note"
                disabled={busy || note.trim().length === 0}
                title="Send this answer to the EM without deciding — the EM decides approve/deny from it"
                onClick={() => act(() => noteHil(selected.id, note.trim()))}
              >
                Send note
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'em'))}
              >
                Delegate to EM
              </button>
              <button
                type="button"
                className="cr-icon-btn"
                disabled={busy}
                onClick={() => act(() => delegateHil(selected.id, 'architect'))}
              >
                Delegate to architect
              </button>
              <button type="button" className="cr-icon-btn" onClick={() => setSelected(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
