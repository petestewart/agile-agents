import type { Event, TicketId } from '@agile-agents/shared';
import { useCallback, useEffect, useState } from 'react';
import { connectFeedSocket } from '../../lib/ws';
import { BriefPane } from './BriefPane';
import { DecisionsPane } from './DecisionsPane';
import { KnowledgePane } from './KnowledgePane';
import { PolicyPane } from './PolicyPane';
import { QuestionsPane } from './QuestionsPane';
import { RulesPane } from './RulesPane';
import { SprintsPane } from './SprintsPane';
import { TicketsPane } from './TicketsPane';
import { type PlanOverview, getPlanOverview, startSprint } from './plan-api';

/**
 * The Plan screen (T042 — design §17 "Control room v2": "Plan screen = the
 * documents + the EM chat. Left rail, one entry per artifact family, each
 * opening a pane that renders the files and edits them ... Any pane can be
 * closed (X) and the chat widens; the rail collapses to icons.").
 *
 * Everything it renders comes from `GET /api/plan` (one round trip, the
 * panes are small and always shown together) and every edit goes back
 * through a daemon verb — the panes never write a file. A live `/ws` event
 * that changes any of it refetches, the same debounce-on-event pattern the
 * Ops view already uses.
 *
 * Top-bar ownership: T043 owns the shell (`App.tsx`, `TopBar`, rail-collapse
 * state, chat). Until that lands this component carries its own **Start
 * Sprint N** button — the one top-bar action — so the screen is usable and
 * testable standalone; `onStarted` lets the shell take it over later.
 */

export type PaneId =
  | 'brief'
  | 'rules'
  | 'questions'
  | 'decisions'
  | 'tickets'
  | 'sprints'
  | 'knowledge'
  | 'policy';

const RAIL: Array<{ id: PaneId; label: string }> = [
  { id: 'brief', label: 'Brief' },
  { id: 'rules', label: 'Rules' },
  { id: 'questions', label: 'Questions' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'policy', label: 'Who decides' },
];

/** Event kinds that change something a pane renders (`store.ts` mints all of them). */
const PLAN_REFRESH_KINDS = new Set<Event['kind']>([
  'ticket_put',
  'ticket_reexamined',
  'state_transition',
  'oracle_put',
  'kb_put',
  'entity_put',
  'sprint_put',
  'policy_put',
  'question_raised',
  'question_answered',
]);

const REFRESH_DEBOUNCE_MS = 150;

export function PlanScreen({
  collapsed = false,
  onOpenSettings,
  onStarted,
}: {
  /** Rail collapsed to icons (T043's tool row drives this once it lands). */
  collapsed?: boolean;
  onOpenSettings?: () => void;
  onStarted?: () => void;
}) {
  const [overview, setOverview] = useState<PlanOverview | undefined>(undefined);
  const [pane, setPane] = useState<PaneId | undefined>('tickets');
  const [selected, setSelected] = useState<TicketId | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setOverview(await getPlanOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = connectFeedSocket({
      onEvent: (event) => {
        if (!PLAN_REFRESH_KINDS.has(event.kind)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
      },
    });
    return () => {
      handle.close();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  async function start() {
    setError(undefined);
    try {
      const result = await startSprint();
      setStatus(
        `${result.sprint.id} started with ${result.sprint.tickets.length} ticket(s) — approve_plan ${result.gate.status}${result.gate.decision ? ` (${result.gate.decision})` : ''}.`,
      );
      await refresh();
      onStarted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const counts: Record<PaneId, string> = {
    brief: overview?.brief.stub ? '—' : '1',
    rules: String(overview?.rules.length ?? 0),
    questions: String(overview?.questions.filter((q) => q.status === 'open').length ?? 0),
    decisions: String(overview?.decisions.length ?? 0),
    tickets: String(overview?.tickets.length ?? 0),
    sprints: String(overview?.sprints.rows.length ?? 0),
    knowledge: String(overview?.knowledge.length ?? 0),
    policy: 'policy',
  };

  // The detail panel's blocked-by/blocks come from the sprint projection,
  // which carries them per row ticket. A ticket in no projected row (a done
  // one, or one already claimed by the running sprint) is rebuilt from the
  // ticket list so clicking it still opens a detail panel.
  const detail = (() => {
    if (selected === undefined || !overview) return undefined;
    const fromRows = overview.sprints.rows.flatMap((r) => r.tickets).find((t) => t.id === selected);
    if (fromRows) return fromRows;
    const ticket = overview.tickets.find((t) => t.id === selected);
    if (!ticket) return undefined;
    const done = new Set(overview.tickets.filter((t) => t.status === 'done').map((t) => t.id));
    return {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      blocked_by: ticket.depends.filter((dep) => !done.has(dep)),
      blocks: overview.tickets
        .filter((t) => t.status !== 'done' && t.depends.includes(ticket.id))
        .map((t) => t.id),
      stub: ticket.stub,
    };
  })();
  const nextSprint = overview?.sprints.next;

  return (
    <div className="cr-plan" data-testid="plan-screen">
      <div className="cr-plan-actions">
        <span className="eyebrow">
          {overview?.sprints.running ? `${overview.sprints.running} running` : 'No sprint running'}
        </span>
        <button
          type="button"
          className="cr-icon-btn"
          data-testid="start-sprint"
          disabled={!nextSprint || overview?.sprints.running !== undefined}
          onClick={start}
        >
          {nextSprint ? `Start Sprint ${nextSprint.id.replace('S-', '')}` : 'Start Sprint'}
        </button>
        {status && (
          <span style={{ color: 'var(--ok)' }} data-testid="plan-status">
            {status}
          </span>
        )}
        {error && (
          <span style={{ color: 'var(--danger)' }} data-testid="plan-error">
            {error}
          </span>
        )}
      </div>

      <div className={`plan${collapsed ? ' mini' : ''}${pane === undefined ? ' nopane' : ''}`}>
        <nav className="rail" aria-label="Plan documents">
          {RAIL.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.label}
              className={pane === entry.id ? 'on' : undefined}
              aria-pressed={pane === entry.id}
              data-testid={`rail-${entry.id}`}
              onClick={() => setPane(entry.id)}
            >
              <span className="lbl">{entry.label}</span>
              <span className="n">{counts[entry.id]}</span>
            </button>
          ))}
          <div className="path">
            Everything here is a file under .agile/ on the agile-state branch. Edit in the UI,
            through the EM, or in your editor; all three write the same file.
          </div>
        </nav>

        {pane !== undefined && overview && (
          <div>
            <div className="cr-plan-paneclose">
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="pane-close"
                title="Close this pane and widen the chat"
                onClick={() => setPane(undefined)}
              >
                ✕
              </button>
            </div>
            {pane === 'brief' && <BriefPane brief={overview.brief} onChanged={refresh} />}
            {pane === 'rules' && <RulesPane rules={overview.rules} onChanged={refresh} />}
            {pane === 'questions' && (
              <QuestionsPane questions={overview.questions} onChanged={refresh} />
            )}
            {pane === 'decisions' && (
              <DecisionsPane decisions={overview.decisions} onChanged={refresh} />
            )}
            {pane === 'tickets' && (
              <TicketsPane
                tickets={overview.tickets}
                onChanged={refresh}
                onSelect={(id) => setSelected(id)}
              />
            )}
            {pane === 'sprints' && (
              <SprintsPane
                board={overview.sprints}
                onChanged={refresh}
                onSelect={(id) => setSelected(id)}
              />
            )}
            {pane === 'knowledge' && (
              <KnowledgePane facts={overview.knowledge} onChanged={refresh} />
            )}
            {pane === 'policy' && (
              <PolicyPane
                {...(overview.policy ? { policy: overview.policy } : {})}
                {...(onOpenSettings ? { onOpenSettings } : {})}
              />
            )}

            {detail && (
              <div className="rule" data-testid={`ticket-detail-${detail.id}`}>
                <span className="id">Ticket detail · {detail.id}</span> <b>{detail.title}</b>
                <dl className="kv">
                  <dt>Blocked by</dt>
                  <dd className="mono" data-testid="detail-blocked-by">
                    {detail.blocked_by.length > 0 ? detail.blocked_by.join(', ') : 'nothing'}
                  </dd>
                  <dt>Blocks</dt>
                  <dd className="mono" data-testid="detail-blocks">
                    {detail.blocks.length > 0 ? detail.blocks.join(', ') : 'nothing'}
                  </dd>
                  <dt>Contract</dt>
                  <dd>{detail.stub ? 'stub, expanded when blockers land' : 'refined'}</dd>
                </dl>
                <button type="button" className="cr-link" onClick={() => setSelected(undefined)}>
                  close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
