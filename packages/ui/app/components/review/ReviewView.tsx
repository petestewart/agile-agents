/**
 * The sprint Review view (T044 — §17 "Control room v2", mockup `#s4`: "The
 * sprint review gate, and the story you couldn't get today. Plain-language
 * summary first, then what went wrong, then the decision. The same text
 * lands in `runs/*.md`").
 *
 * The narrative is NOT built here: `GET /api/sprint/review` returns exactly
 * what `packages/daemon/src/em/report.ts` renders into `runs/<ts>.md`, so
 * "the Review tab's narrative equals the runs file body" holds by
 * construction. This component renders those strings and wires the decision
 * to the existing `sprint_review` gate verbs (T039's approve/deny + note).
 *
 * T050: which of the three things it renders is decided by the daemon, not
 * here — `report.phase` is derived from the same `sprint_review` gate the
 * top bar reads, so the bar and this tab cannot disagree:
 *
 *   `running`        a notice plus a clearly-labelled progress summary. No
 *                    accept/send-back, no reply box, no "proposes next" —
 *                    the defect this fixes was offering all three 1m27s
 *                    into a sprint with every ticket still `in_progress`.
 *   `review_pending` the review narrative with both decisions open.
 *   `reviewed`       the same narrative, read-only, with the decision taken.
 */

import type { HilRequest } from '@agile-agents/shared';
import { useCallback, useEffect, useState } from 'react';
import { approveHil, denyHil, getSprintReport } from '../../lib/api';
import type { SprintReport } from '../../lib/feed-types';

function PerTicket({ report }: { report: SprintReport }): JSX.Element {
  return (
    <section className="cr-section">
      <div className="cr-section-hd">
        <span className="cr-eyebrow">
          {report.phase === 'running' ? 'Per ticket · so far' : 'Per ticket'}
        </span>
      </div>
      <dl className="cr-kv" data-testid="review-per-ticket">
        {report.per_ticket.map((line) => (
          <div key={line.ticket} style={{ display: 'contents' }}>
            <dt className="mono">{line.ticket}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
        {report.per_ticket.length === 0 && (
          <>
            <dt>—</dt>
            <dd>No tickets in this sprint.</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Decisions({ report }: { report: SprintReport }): JSX.Element {
  return (
    <section className="cr-section">
      <div className="cr-section-hd">
        <span className="cr-eyebrow">Decisions made without you</span>
      </div>
      {report.decisions.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }} data-testid="review-decisions-empty">
          None — every gate this sprint came to you.
        </p>
      ) : (
        <div className="cr-table-wrap">
          <table className="cr-table" data-testid="review-decisions">
            <thead>
              <tr>
                <th>When</th>
                <th>Gate</th>
                <th>Decided by</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {report.decisions.map((decision) => (
                <tr key={`${decision.at}-${decision.gate}`}>
                  <td className="mono">{new Date(decision.at).toLocaleTimeString()}</td>
                  <td>{decision.gate}</td>
                  <td>{decision.decided_by}</td>
                  <td>{decision.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ReviewView({
  gate,
  onChanged,
}: {
  /** The pending `sprint_review` request, when there is one — its absence makes this a read-only retrospective. */
  gate?: HilRequest;
  onChanged: () => void;
}): JSX.Element {
  const [report, setReport] = useState<SprintReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await getSprintReport());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * The narrative is phase-dependent, so it has to be re-pulled whenever the
   * gate appears or is decided — App remounts this view on the gate's id for
   * exactly that reason (`key` in `App.tsx`), which runs this effect again.
   */
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: 'approve' | 'deny') {
    if (!gate) return;
    setBusy(true);
    setError(undefined);
    try {
      await (decision === 'approve'
        ? approveHil(gate.id, 'human', note.trim() || undefined)
        : denyHil(gate.id, 'human', note.trim() || undefined));
      setNote('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!report) {
    return (
      <div className="cr-review-view" data-testid="review-view">
        <p style={{ color: 'var(--text-dim)' }}>{error ?? 'Building the sprint report…'}</p>
      </div>
    );
  }

  const sprintName = report.sprint ?? 'This sprint';

  /**
   * A running sprint has no review to take. It gets the notice the ticket
   * asks for plus a progress summary that says, in its own words, that it
   * is in progress — and nothing that looks like a decision.
   */
  if (report.phase === 'running') {
    return (
      <div className="cr-review-view" data-testid="review-view" data-phase="running">
        <section className="cr-section" data-testid="review-running">
          <div className="cr-section-hd">
            <span className="cr-eyebrow">In progress</span>
          </div>
          <h2 style={{ margin: '4px 0 12px' }}>
            {sprintName} is running · the review appears when it finishes
          </h2>
          <article className="cr-card summary" data-testid="review-progress">
            <p style={{ color: 'var(--text-dim)' }}>
              Nothing here is a sprint review — it is where the sprint stands right now, and it is
              still in progress.
            </p>
            <p data-testid="review-asked">
              <b>What was asked:</b> {report.asked}
            </p>
            <p data-testid="review-progress-built">
              <b>Where it stands:</b> {report.built}
            </p>
            <p data-testid="review-progress-wrong">
              <b>Trouble so far:</b> {report.went_wrong}
            </p>
            <p data-testid="review-progress-where">
              <b>Where the code is:</b> {report.where}
            </p>
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          </article>
        </section>

        <PerTicket report={report} />
        <Decisions report={report} />
      </div>
    );
  }

  const canDecide = report.phase === 'review_pending' && gate !== undefined;

  return (
    <div className="cr-review-view" data-testid="review-view" data-phase={report.phase}>
      <section className={canDecide ? 'cr-needs' : 'cr-section'}>
        <div className="hd">
          <h2>
            {canDecide ? `${sprintName} is ready for your review` : `${sprintName} · review closed`}
          </h2>
          {canDecide && <span className="count">1</span>}
        </div>
        {report.decision && (
          <p data-testid="review-decision">
            <b>Your decision:</b>{' '}
            {report.decision.decision === 'approve' ? 'Accepted and merged to main' : 'Sent back'}{' '}
            by {report.decision.decided_by} at {new Date(report.decision.at).toLocaleString()}
            {report.decision.note ? ` — “${report.decision.note}”` : ''}.
          </p>
        )}
        <article className="cr-card summary" data-testid="review-summary">
          <p data-testid="review-asked">
            <b>What was asked:</b> {report.asked}
          </p>
          <p data-testid="review-built">
            <b>What was built:</b> {report.built}
          </p>
          <p data-testid="review-wrong">
            <b>What went wrong:</b> {report.went_wrong}
          </p>
          <p data-testid="review-where">
            <b>Where the code is:</b> {report.where}
          </p>
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          {canDecide && (
            <>
              <div className="cr-actions">
                <button
                  type="button"
                  className="cr-btn signal"
                  data-testid="review-accept"
                  disabled={busy}
                  title="Resolve the sprint_review gate"
                  onClick={() => decide('approve')}
                >
                  Accept and merge to main
                </button>
                <button
                  type="button"
                  className="cr-btn"
                  data-testid="review-send-back"
                  disabled={busy}
                  onClick={() => decide('deny')}
                >
                  Send it back
                </button>
              </div>
              <div className="cr-reply">
                <input
                  data-testid="review-note"
                  value={note}
                  disabled={busy}
                  placeholder="Or say what you want: “accept 2001 and 2003, send 2002 back”"
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </>
          )}
        </article>
      </section>

      <PerTicket report={report} />
      <Decisions report={report} />

      {report.proposes_next.length > 0 && (
        <section className="cr-opts">
          <h3>What the EM proposes next</h3>
          <ul data-testid="review-proposes">
            {report.proposes_next.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
