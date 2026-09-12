import type { TicketId } from '@agile-agents/shared';
import { useState } from 'react';
import { type PlanTicket, createTicket, editTicket } from './plan-api';

/**
 * Tickets pane — `tickets/TKT-*.yaml` (§17 v2; mockup `#p-tix`): "the whole
 * goal, in dependency order". Every edit posts to the daemon, which applies
 * the living-plan rules and says which one fired; this pane reports that
 * back ("sent the engineer the new contract" / "opened a follow-up"), so an
 * in-flight edit is never silently a rewrite in the operator's mind either.
 */
export function TicketsPane({
  tickets,
  onChanged,
  onSelect,
}: {
  tickets: PlanTicket[];
  onChanged: () => void;
  onSelect: (id: TicketId) => void;
}) {
  const [editingId, setEditingId] = useState<TicketId | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function save() {
    setError(undefined);
    try {
      if (adding) {
        await createTicket({ title, ...(description ? { description } : {}) });
        setStatus('Added as a stub — the architect refines it when its layer is next.');
      } else if (editingId) {
        const result = await editTicket(editingId, { title, description });
        setStatus(
          result.mode === 'contract_change'
            ? `${editingId} is in flight — its engineer has been sent the contract change.`
            : result.mode === 'follow_up'
              ? `${editingId} is done — opened ${result.followUp?.id} as a follow-up instead of rewriting it.`
              : `${editingId} updated.`,
        );
      }
      setEditingId(undefined);
      setAdding(false);
      setTitle('');
      setDescription('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="pane" data-testid="pane-tickets">
      <div className="dochd">
        <span className="eyebrow">
          Tickets ({tickets.length}) · the whole goal, in dependency order
        </span>
        <span className="file">tickets/TKT-*.yaml</span>
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="ticket-add"
          onClick={() => {
            setAdding(true);
            setEditingId(undefined);
            setTitle('');
            setDescription('');
          }}
        >
          Add ticket
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {status && (
        <p style={{ color: 'var(--ok)' }} data-testid="ticket-status">
          {status}
        </p>
      )}
      {(adding || editingId) && (
        <div className="plan-t" data-testid="ticket-editor">
          <input
            className="cr-textarea"
            data-testid="ticket-title"
            style={{ minHeight: 0 }}
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="cr-textarea"
            data-testid="ticket-description"
            style={{ minHeight: 0 }}
            placeholder="One-line summary"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button type="button" className="cr-icon-btn" data-testid="ticket-save" onClick={save}>
            Save
          </button>
        </div>
      )}
      {tickets.map((ticket) => (
        <div
          className="plan-t"
          key={ticket.id}
          data-testid={`plan-ticket-${ticket.id}`}
          style={ticket.stub ? { opacity: 0.75 } : undefined}
        >
          <button
            type="button"
            className="title cr-link"
            data-testid={`plan-ticket-open-${ticket.id}`}
            onClick={() => onSelect(ticket.id)}
          >
            {ticket.id} · {ticket.title}
          </button>
          <button
            type="button"
            className="cr-icon-btn edit"
            data-testid={`plan-ticket-edit-${ticket.id}`}
            onClick={() => {
              setEditingId(ticket.id);
              setAdding(false);
              setTitle(ticket.title);
              setDescription(ticket.description ?? '');
            }}
          >
            Edit
          </button>
          <span className="meta">
            {ticket.description ?? 'No summary yet.'}
            {ticket.stub
              ? ' — stub; the architect fills in the contract when its layer is next.'
              : ''}
          </span>
          <span className="touch">
            {ticket.status}
            {ticket.depends.length > 0 ? ` · depends: ${ticket.depends.join(', ')}` : ''}
            {ticket.oracle_refs.length > 0 ? ` · must follow ${ticket.oracle_refs.join(', ')}` : ''}
            {ticket.sprint ? ` · ${ticket.sprint}` : ''}
            {ticket.external?.jira ? ` · Jira ${ticket.external.jira}` : ''}
          </span>
        </div>
      ))}
      {tickets.length === 0 && (
        <p style={{ color: 'var(--text-dim)' }} data-testid="tickets-empty">
          No tickets yet — type the goal in the chat and the architect writes them.
        </p>
      )}
    </div>
  );
}
