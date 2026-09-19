import type { TicketId } from '@agile-agents/shared';
import { useState } from 'react';
import { PaneClose } from './PaneClose';
import { type PlanTicket, createTicket, editTicket } from './plan-api';

/**
 * Tickets pane — `tickets/TKT-*.yaml` (§17 v2; mockup `#p-tix`): "the whole
 * goal, in dependency order". Every edit posts to the daemon, which applies
 * the living-plan rules and says which one fired; this pane reports that
 * back ("sent the engineer the new contract" / "opened a follow-up"), so an
 * in-flight edit is never silently a rewrite in the operator's mind either.
 *
 * T049 fixed three things an operator hit on the first pass:
 *  1. Edit opened a bare, unlabelled form at the top of the pane, with no
 *     way out — the editor now renders **in place on that ticket's card**,
 *     headed by its id and current title, with a Cancel.
 *  2. Add ticket had no Cancel either.
 *  8. Editing a *done* ticket silently minted a follow-up stub on every
 *     save (TKT-2004/2005, both carrying the parent's own title). The
 *     daemon rule is right and stays — a done ticket is terminal — but the
 *     UI now says so and asks first, and the follow-up it then requests
 *     carries a title that is distinct from its parent's.
 */

/** What the follow-up is called when the operator did not retitle it. `plan/living.ts` uses `patch.title` verbatim, so an unchanged title is what produced the duplicates. */
export function followUpTitle(parentTitle: string, edited: string): string {
  const wanted = edited.trim().length > 0 ? edited.trim() : parentTitle;
  if (wanted !== parentTitle.trim()) return wanted;
  return `Follow-up: ${parentTitle}`;
}

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
  /** The done ticket whose edit is waiting on "save as a follow-up?" (defect 8). */
  const [confirmFollowUp, setConfirmFollowUp] = useState<TicketId | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  function reset() {
    setEditingId(undefined);
    setAdding(false);
    setConfirmFollowUp(undefined);
    setTitle('');
    setDescription('');
  }

  function startEdit(ticket: PlanTicket) {
    setEditingId(ticket.id);
    setAdding(false);
    setConfirmFollowUp(undefined);
    setError(undefined);
    setStatus(undefined);
    setTitle(ticket.title);
    setDescription(ticket.description ?? '');
  }

  async function save(ticket?: PlanTicket) {
    setError(undefined);
    // Defect 8: a done ticket cannot be rewritten, so ask before the edit
    // becomes a new piece of work rather than quietly minting one.
    if (ticket && ticket.status === 'done' && confirmFollowUp !== ticket.id) {
      setConfirmFollowUp(ticket.id);
      return;
    }
    try {
      if (adding) {
        await createTicket({ title, ...(description ? { description } : {}) });
        setStatus('Added as a stub — the architect refines it when its layer is next.');
      } else if (editingId && ticket) {
        const patch =
          ticket.status === 'done'
            ? { title: followUpTitle(ticket.title, title), description }
            : { title, description };
        const result = await editTicket(editingId, patch);
        setStatus(
          result.mode === 'contract_change'
            ? `${editingId} is in flight — its engineer has been sent the contract change.`
            : result.mode === 'follow_up'
              ? `${editingId} is done — opened ${result.followUp?.id} (“${result.followUp?.title}”) as a follow-up instead of rewriting it.`
              : `${editingId} updated.`,
        );
      }
      reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** The two fields + the actions, shared by the Add form and every in-place editor. */
  function fields(ticket: PlanTicket | undefined) {
    const done = ticket?.status === 'done';
    const awaitingConfirm = ticket !== undefined && confirmFollowUp === ticket.id;
    return (
      <>
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
        {awaitingConfirm && (
          <p className="cr-confirm" data-testid="ticket-followup-confirm">
            {ticket.id} is done; save as a follow-up ticket?
          </p>
        )}
        <div className="cr-editor-actions">
          <button
            type="button"
            className="cr-icon-btn"
            data-testid={awaitingConfirm ? 'ticket-followup-confirm-save' : 'ticket-save'}
            onClick={() => save(ticket)}
          >
            {awaitingConfirm ? 'Confirm' : done ? 'Save as a follow-up…' : 'Save'}
          </button>
          <button type="button" className="cr-icon-btn" data-testid="ticket-cancel" onClick={reset}>
            Cancel
          </button>
        </div>
      </>
    );
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
            setConfirmFollowUp(undefined);
            setTitle('');
            setDescription('');
          }}
        >
          Add ticket
        </button>
        <PaneClose />
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {status && (
        <p style={{ color: 'var(--ok)' }} data-testid="ticket-status">
          {status}
        </p>
      )}
      {adding && (
        <div className="plan-t">
          <div className="cr-ticket-editor" data-testid="ticket-editor">
            <span className="title">New ticket</span>
            {fields(undefined)}
          </div>
        </div>
      )}
      {tickets.map((ticket) => (
        <div
          className="plan-t"
          key={ticket.id}
          data-testid={`plan-ticket-${ticket.id}`}
          style={ticket.stub ? { opacity: 0.75 } : undefined}
        >
          {editingId === ticket.id ? (
            // Defect 1: the editor is on the card, headed by the ticket it
            // edits, so "which ticket is this?" is never a question.
            <div className="cr-ticket-editor" data-testid="ticket-editor">
              <span className="title" data-testid={`ticket-editor-for-${ticket.id}`}>
                Editing {ticket.id} · {ticket.title}
              </span>
              {fields(ticket)}
            </div>
          ) : (
            <>
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
                onClick={() => startEdit(ticket)}
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
                {ticket.oracle_refs.length > 0
                  ? ` · must follow ${ticket.oracle_refs.join(', ')}`
                  : ''}
                {ticket.sprint ? ` · ${ticket.sprint}` : ''}
                {ticket.external?.jira ? ` · Jira ${ticket.external.jira}` : ''}
              </span>
            </>
          )}
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
