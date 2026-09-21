/**
 * "Needs you" (§17 "Attention queue"; T044 restyles T039/T040's minimal
 * list into the mockup's cards: a kind line, a headline, an explanation in
 * plain language, the buttons, and the free-text reply).
 *
 * Every card is inline — no modal. The mockup's premise is that the
 * operator reads the whole ask without a click, and T039's measurement of
 * the first hands-on run was that a one-line row told them nothing. The
 * buttons and the reply box are unchanged verbs: approve/deny with an
 * optional note, a note on its own (which resolves nothing — the EM decides
 * from it), and "Let the EM decide these from now on" = the existing
 * single-instance delegate route. A question card answers through
 * `QuestionService`, as a plain reply or recorded as a `DEC-*`.
 */

import type { HilRequest, Question } from '@agile-agents/shared';
import { useState } from 'react';
import { answerQuestion, approveHil, delegateHil, denyHil, noteHil } from '../lib/api';

/**
 * What each gate actually means, for someone who does not know the system
 * (the ticket's own Note). Keyed by `hil_kind` — the four §5 kinds — since
 * gate names are open-ended (`permission:qa`, `unblock`, `approve_plan`, …).
 */
const KIND_EXPLANATION: Record<string, string> = {
  unblock:
    'An agent tried something the guardrails stop. Allowing it once lets that one action through; denying it sends the agent back with the reason.',
  approve_decision:
    'A decision needs your sign-off before the team acts on it. Approving records it; denying sends it back to the architect.',
  steer:
    'The team wants direction before it continues. Anything you type here reaches the agent that asked and the EM.',
  demo: 'A walkthrough of finished work before it is promoted. Approving accepts it.',
};

function headlineFor(item: HilRequest): string {
  if (item.summary) return item.summary;
  return `${item.gate} needs a decision`;
}

function waitingFor(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `waiting ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `waiting ${minutes}m` : `waiting ${Math.round(minutes / 60)}h`;
}

export function NeedsYou({
  items,
  questions = [],
  onChanged,
}: {
  items: HilRequest[];
  questions?: Question[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** One draft per card id, so two open cards never share a reply box. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const draftOf = (id: string): string => drafts[id] ?? '';
  const setDraft = (id: string, value: string) =>
    setDrafts((current) => ({ ...current, [id]: value }));

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setDrafts((current) => ({ ...current, [id]: '' }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const count = items.length + questions.length;

  return (
    <section className="cr-needs" data-testid="needs-you">
      <div className="hd">
        <h2>Needs you</h2>
        <span className="count" data-testid="needs-you-count">
          {count}
        </span>
      </div>

      {error && (
        <p style={{ color: 'var(--danger)' }} data-testid="needs-you-error">
          {error}
        </p>
      )}

      {count === 0 && (
        <p className="cr-calm" data-testid="needs-you-empty">
          Nothing needs you right now.
        </p>
      )}

      {items.map((item) => (
        <article className="cr-card hil-item" key={item.id} data-id={item.id}>
          <div className="kind">
            {item.hil_kind} · {item.gate} · {item.stream} · {waitingFor(item.requested_at)}
          </div>
          <h3>{headlineFor(item)}</h3>
          <p>
            {KIND_EXPLANATION[item.hil_kind] ?? 'This gate is routed to you by the current policy.'}
            {item.reason ? ` Routed to you because: ${item.reason}.` : ''}
          </p>
          {item.note && (
            <p>
              <strong>Your earlier note:</strong> {item.note}
            </p>
          )}
          <div className="cr-actions">
            <button
              type="button"
              className="cr-btn signal"
              data-testid="hil-approve"
              disabled={busy}
              onClick={() =>
                act(item.id, () =>
                  approveHil(item.id, 'human', draftOf(item.id).trim() || undefined),
                )
              }
            >
              {item.hil_kind === 'classifier_review' ? 'Allow once' : 'Approve'}
            </button>
            <button
              type="button"
              className="cr-btn"
              data-testid="hil-deny"
              disabled={busy}
              onClick={() =>
                act(item.id, () => denyHil(item.id, 'human', draftOf(item.id).trim() || undefined))
              }
            >
              Deny
            </button>
            <button
              type="button"
              className="cr-btn"
              data-testid="hil-delegate-em"
              disabled={busy}
              title="Hands this gate, and this one only, to the EM to decide now"
              onClick={() => act(item.id, () => delegateHil(item.id, 'em'))}
            >
              Let the EM decide these from now on
            </button>
          </div>
          <div className="cr-reply">
            <input
              data-testid="hil-note"
              value={draftOf(item.id)}
              disabled={busy}
              placeholder="Or answer in your own words…"
              onChange={(e) => setDraft(item.id, e.target.value)}
            />
            <button
              type="button"
              className="cr-btn"
              data-testid="hil-send-note"
              disabled={busy || draftOf(item.id).trim().length === 0}
              title="Send this answer to the EM without deciding — the EM applies it"
              onClick={() => act(item.id, () => noteHil(item.id, draftOf(item.id).trim()))}
            >
              Send
            </button>
          </div>
          <p className="cr-help">
            A typed answer goes to the agent that asked and to the EM. If it amounts to allow or
            deny, the EM applies it; if it changes the ticket, the EM turns it into a contract
            change.
          </p>
        </article>
      ))}

      {questions.map((question) => (
        <article className="cr-card question-item" key={question.id} data-id={question.id}>
          <div className="kind">
            question · {question.raised_by} · {question.stream}
          </div>
          <h3 data-testid="question-text">{question.text}</h3>
          {question.options && (
            <p>
              <strong>Options offered:</strong> {question.options.join(' · ')}
            </p>
          )}
          <div className="cr-reply">
            <input
              data-testid="question-answer"
              value={draftOf(question.id)}
              disabled={busy}
              placeholder="e.g. the spec wins — refine the ticket against it"
              onChange={(e) => setDraft(question.id, e.target.value)}
            />
            <button
              type="button"
              className="cr-btn signal"
              data-testid="question-reply"
              disabled={busy || draftOf(question.id).trim().length === 0}
              title="Answer the raiser — no decision recorded"
              onClick={() =>
                act(question.id, () =>
                  answerQuestion(question.id, draftOf(question.id).trim(), 'reply'),
                )
              }
            >
              Answer
            </button>
            <button
              type="button"
              className="cr-btn"
              data-testid="question-decision"
              disabled={busy || draftOf(question.id).trim().length === 0}
              title="Answer and record it as a DEC-* through the oracle write guard"
              onClick={() =>
                act(question.id, () =>
                  answerQuestion(question.id, draftOf(question.id).trim(), 'decision'),
                )
              }
            >
              Record as decision
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
