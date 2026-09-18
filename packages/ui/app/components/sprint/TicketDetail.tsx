/**
 * Ticket detail (T044 — the T025 gap the ticket names: "Ticket detail
 * panel: blocked-by/blocks, contract, worktree diff, review and QA
 * verdicts").
 *
 * Three reads, all daemon-side and read-only: `GET /api/tickets/:id`
 * (ticket + board stanzas, T025), `GET /api/tickets/:id/diff` (`git diff
 * integration...HEAD` in the ticket's worktree, path-guarded and capped) and
 * `GET /api/tickets/:id/thread` (the bus thread, where the reviewer's and
 * QA's verdict messages are). "blocks" is not a stored field — it is the
 * inverse of every other ticket's `depends`, computed here from the board
 * the Sprint view already has.
 */

import type { Message, Stanza, Ticket } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { getTicketDetail, getTicketDiff, getTicketThread } from '../../lib/api';
import type { TicketDiff } from '../../lib/feed-types';

const VERDICT_KINDS = new Set(['review_verdict', 'qa_verdict', 'escalate']);

export function TicketDetail({
  ticketId,
  tickets,
  onClose,
}: {
  ticketId: string;
  tickets: Ticket[];
  onClose: () => void;
}): JSX.Element {
  const [ticket, setTicket] = useState<Ticket | undefined>(undefined);
  const [stanzas, setStanzas] = useState<Stanza[]>([]);
  const [thread, setThread] = useState<Message[]>([]);
  const [diff, setDiff] = useState<TicketDiff | undefined>(undefined);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [detail, messages] = await Promise.all([
          getTicketDetail(ticketId as never),
          getTicketThread(ticketId as never),
        ]);
        if (cancelled) return;
        setTicket(detail.ticket);
        setStanzas(detail.stanzas);
        setThread(messages);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const patch = await getTicketDiff(ticketId as never);
        if (!cancelled) setDiff(patch);
      } catch (err) {
        // A ticket with no worktree yet is the normal case, not a failure —
        // the panel says so instead of showing an error banner.
        if (!cancelled) setDiffError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const blocks = tickets.filter((t) => t.depends.includes(ticketId as never)).map((t) => t.id);
  const verdicts = thread.filter((m) => VERDICT_KINDS.has(m.kind));

  return (
    <div
      className="cr-modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="presentation"
    >
      <div
        className="cr-modal cr-ticket-detail"
        data-testid="ticket-detail"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <h2>
          {ticketId} · {ticket?.title ?? '…'}
        </h2>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

        <dl className="cr-kv">
          <dt>Status</dt>
          <dd>{ticket?.status ?? '…'}</dd>
          <dt>Blocked by</dt>
          <dd data-testid="ticket-blocked-by">
            {ticket && ticket.depends.length > 0 ? ticket.depends.join(', ') : 'nothing'}
          </dd>
          <dt>Blocks</dt>
          <dd data-testid="ticket-blocks">{blocks.length > 0 ? blocks.join(', ') : 'nothing'}</dd>
          <dt>Worktree</dt>
          <dd className="mono">{ticket?.worktree ?? 'not created yet'}</dd>
        </dl>

        <h3>Contract</h3>
        {ticket ? (
          <dl className="cr-kv" data-testid="ticket-contract">
            <dt>Inputs</dt>
            <dd>{ticket.contract.inputs.join(', ') || '—'}</dd>
            <dt>Outputs</dt>
            <dd>{ticket.contract.outputs.join(', ') || '—'}</dd>
            <dt>Acceptance</dt>
            <dd>
              <ul>
                {ticket.contract.acceptance.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {ticket.contract.acceptance.length === 0 && <li>—</li>}
              </ul>
            </dd>
            <dt>Definition of done</dt>
            <dd>{ticket.contract.done.join(', ') || '—'}</dd>
            <dt>Environment</dt>
            <dd>{ticket.contract.env}</dd>
          </dl>
        ) : (
          <p style={{ color: 'var(--text-dim)' }}>Loading…</p>
        )}

        <h3>Review and QA verdicts</h3>
        {verdicts.length === 0 ? (
          <p style={{ color: 'var(--text-dim)' }} data-testid="ticket-verdicts-empty">
            No verdicts on this ticket yet.
          </p>
        ) : (
          <div data-testid="ticket-verdicts">
            {verdicts.map((message) => (
              <div key={message.id} className="cr-verdict">
                <div className="meta">
                  {message.kind} · {message.from} · {new Date(message.ts).toLocaleTimeString()}
                </div>
                <div className="body">{message.body}</div>
              </div>
            ))}
          </div>
        )}

        <h3>Worktree diff</h3>
        {diff ? (
          <>
            <p className="cr-section-note">
              {diff.range} in {diff.worktree}
              {diff.branch ? ` (${diff.branch})` : ''} ·{' '}
              {diff.stat.split('\n').pop() || 'no changes'}
            </p>
            <pre className="cr-diff" data-testid="ticket-diff">
              {diff.patch || '(no changes on this ticket’s branch yet)'}
            </pre>
            {diff.truncated && (
              <p className="cr-section-note">
                Truncated — the full patch is at <span className="mono">{diff.ref}</span> under the
                daemon cache.
              </p>
            )}
          </>
        ) : (
          <p style={{ color: 'var(--text-dim)' }} data-testid="ticket-diff-empty">
            {diffError ?? 'Loading…'}
          </p>
        )}

        {stanzas.length > 0 && (
          <>
            <h3>Board stanzas</h3>
            <ul>
              {stanzas.slice(-6).map((stanza, index) => (
                <li key={`${stanza.ts}-${index}`}>
                  <span className="mono">{stanza.kind}</span> · {stanza.agent}: {stanza.summary}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="cr-modal-actions">
          <button
            type="button"
            className="cr-btn"
            data-testid="ticket-detail-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
