/**
 * T363: a node's other tabs — Plan (who owns what, the contracts, and a
 * draft's Approve), Activity (what woke this node and why, as a timeline),
 * Knowledge (exactly what is in scope) and Docs.
 *
 * T413: they read as the Events view and the Knowledge screen do, with
 * those screens' own rows, so this file loads on demand (`StreamPage`),
 * like them, rather than pulling them into the first screen.
 */

import { DIRECTOR_NODE, type KnowledgeItem as Rule, type SessionRef } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { approvePlan, getStreamActivity, getStreamPlan } from '../lib/api';
import { clockTime } from '../lib/chat';
import { useOptionalFeed } from '../lib/feed-context';
import type { ActivityEntry, StreamDoc } from '../lib/feed-types';
import { ROUTE_REASON, eventDetail, eventTitle, groupByDay, sortNewestFirst } from '../lib/lenses';
import { DEFAULT_RULES_FILTER, sectionOf } from '../lib/rules';
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { activityDelivery, eventTime } from '../lib/streams';
import { Icon } from './Icon';
import { KnowledgeRow } from './KnowledgeList';
import { EventGlyph } from './Lenses';
import { Markdown } from './Markdown';
import { NodeLink } from './NodeDetails';
import { Button, EmptyState } from './ui';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Loading(): JSX.Element {
  return (
    <div className="cr-skel-stack" aria-busy="true">
      <div className="cr-skel" style={{ width: '35%' }} />
      <div className="cr-skel" />
      <div className="cr-skel" style={{ width: '70%' }} />
    </div>
  );
}

/** T281 (§9.1): who owns what, the contracts between the children, and the draft's Approve. */
export function PlanView({
  id,
  tick,
  onChanged,
  titleOf,
  start,
  running = false,
}: {
  id: string;
  tick: unknown;
  onChanged: () => void;
  titleOf: (id: string) => string;
  /** T445 (audit r7 #21): with no plan and no agent running, what gets one written. */
  start?: { label: string; busy: boolean; onStart: () => void };
  /** Its agent is running: the plan is on its way. */
  running?: boolean;
}): JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof getStreamPlan>> | undefined>();
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` and `seq` are re-read triggers.
  useEffect(() => {
    let live = true;
    getStreamPlan(id)
      .then((r) => live && setData(r))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [id, tick, seq]);
  if (error && !data) return <p className="cr-error">{error}</p>;
  if (!data) return <Loading />;
  const { plan, contracts } = data;
  if (!plan && contracts.length === 0) {
    return (
      <div data-testid="plan-empty">
        <EmptyState
          icon="list"
          title="No plan yet"
          {...(start
            ? {
                actions: (
                  <Button
                    variant="primary"
                    icon="play"
                    data-testid="plan-empty-start"
                    busy={start.busy}
                    onClick={start.onStart}
                  >
                    {start.label}
                  </Button>
                ),
              }
            : {})}
        >
          {running
            ? 'Its agent is running: the plan shows here once it writes one — who owns which files, and the contracts between them.'
            : 'The coordinator writes one when it splits the work into parts: who owns which files, and the contracts between them.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <section className="cr-plan" data-testid="plan">
      {plan && (
        <div className="cr-plan-hd">
          <p data-testid="plan-status" data-status={plan.status}>
            {/* T341: a draft reads as the version it becomes (the first plan is v1, never v0). */}
            Plan v{plan.status === 'draft' ? plan.version + 1 : plan.version} · {plan.status}
            {plan.approved_by ? ` by ${plan.approved_by}` : ''}
          </p>
          {plan.status === 'draft' && (
            <Button
              variant="primary"
              size="sm"
              icon="check"
              data-testid="plan-tab-approve"
              busy={busy}
              onClick={() => {
                setBusy(true);
                approvePlan(id)
                  .catch((err: unknown) => setError(errorText(err)))
                  .finally(() => {
                    setBusy(false);
                    setSeq((n) => n + 1);
                    onChanged();
                  });
              }}
            >
              Approve
            </Button>
          )}
        </div>
      )}
      {error && <p className="cr-error">{error}</p>}
      {plan && (
        <>
          <h3>Owners</h3>
          <ul className="cr-plan-owners" data-testid="plan-owners">
            {plan.owners.map((o) => (
              <li key={o.child} data-testid="plan-owner" data-child={o.child}>
                <NodeLink id={o.child} titleOf={titleOf} />
                {': '}
                {o.owns.length === 0 ? (
                  'nothing'
                ) : (
                  <code data-testid="plan-owner-paths">{o.owns.join(', ')}</code>
                )}
                {plan.status === 'draft' && plan.approved
                  ? (() => {
                      const before = plan.approved.owners.find((a) => a.child === o.child);
                      const same = before?.owns.join(', ') === o.owns.join(', ');
                      return same ? null : (
                        <span className="cr-dim" data-testid="plan-owner-was">
                          {' '}
                          (approved v{plan.approved.version}:{' '}
                          {before ? before.owns.join(', ') || 'nothing' : 'not in the plan'})
                        </span>
                      );
                    })()
                  : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="cr-plan-contracts" data-testid="contracts">
        {contracts.map((c) => (
          <li key={c.id} data-testid="contract" data-contract={c.id}>
            <h3>
              Contract: <span data-testid="contract-title">{c.title}</span>{' '}
              <span className="cr-dim">v{c.version}</span>
            </h3>
            <p className="cr-dim" data-testid="contract-parties">
              Parties:{' '}
              {c.parties.length === 0
                ? 'none'
                : c.parties.map((p, i) => (
                    <span key={p}>
                      {i > 0 ? ', ' : ''}
                      <NodeLink id={p} titleOf={titleOf} />
                    </span>
                  ))}
            </p>
            <Markdown text={c.body} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A node's title for a row, the Director by name; a node the cockpit no longer knows reads as deleted. */
function useTitleOf(): (id: string) => string {
  const rows = useOptionalFeed()?.cockpit?.streams;
  return (id: string) =>
    id === DIRECTOR_NODE ? 'Director' : (rows?.find((r) => r.id === id)?.title ?? 'a deleted node');
}

/**
 * T245, redesigned in T413: what reached this node and why, read as the
 * Events view reads (`cr-lens-log-*`, `EventGlyph`, `eventTitle`,
 * `eventDetail`): when, what happened, which node it is about — then why it
 * came here (a small chip, `ROUTE_REASON`) and whether the agent has seen it.
 * Newest first, under day headings.
 */
export function ActivityView({
  id,
  tick,
  sessions,
}: {
  id: string;
  tick: unknown;
  sessions: readonly SessionRef[];
}): JSX.Element {
  const [rows, setRows] = useState<ActivityEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const titleOf = useTitleOf();
  const streams = useOptionalFeed()?.cockpit?.streams;
  const rowOf = (node: string) => streams?.find((r) => r.id === node);
  const { select, setView } = useShell();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` (the pushed frame) is the re-read trigger.
  useEffect(() => {
    let live = true;
    getStreamActivity(id)
      .then((r) => live && setRows(r))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [id, tick]);
  if (error && !rows) return <p className="cr-error">{error}</p>;
  if (!rows) return <Loading />;
  if (rows.length === 0)
    return (
      <div data-testid="activity-empty">
        <EmptyState icon="activity" title="Nothing has reached this node yet">
          Events about it, the nodes under it and its repo show here: merges, questions, changes on
          main, new knowledge.
        </EmptyState>
      </div>
    );
  const days = groupByDay(sortNewestFirst(rows.map((row) => ({ at: row.event.at, row }))));
  const open = (node: string): void =>
    node === DIRECTOR_NODE ? setView('director') : select(node);
  return (
    <div className="cr-lens-log cr-activity" data-testid="activity">
      {days.map((day) => (
        <section key={day.day} className="cr-lens-day" aria-label={day.day}>
          <h3 className="cr-lens-day-hd">{day.day}</h3>
          <ul className="cr-lens-rows">
            {day.events.map(({ row }) => {
              const { event } = row;
              const detail = eventDetail(event, titleOf, rowOf);
              const why = ROUTE_REASON[row.because];
              return (
                <li
                  key={event.id}
                  className="cr-lens-log-row cr-activity-row"
                  data-testid="activity-row"
                  data-event={event.id}
                  data-delivery={row.status}
                >
                  <time
                    className="cr-lens-log-time"
                    dateTime={event.at}
                    title={eventTime(event.at)}
                  >
                    {day.day === 'Today' ? ago(event.at) : clockTime(event.at)}
                  </time>
                  <div className="cr-lens-log-what">
                    <EventGlyph type={event.type} />
                    <div className="cr-lens-log-text">
                      <span className="cr-lens-ev-label" data-testid="activity-type">
                        {eventTitle(event)}
                      </span>
                      {detail !== undefined && (
                        <span className="cr-lens-log-detail" title={detail}>
                          {detail}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="cr-lens-log-node"
                    data-empty={event.subject === undefined || undefined}
                  >
                    {event.subject === undefined ? (
                      <span className="cr-faint">—</span>
                    ) : event.subject === id ? (
                      <span className="cr-activity-self">This node</span>
                    ) : (
                      <button
                        type="button"
                        className="cr-lens-link"
                        onClick={() => event.subject && open(event.subject)}
                      >
                        {titleOf(event.subject)}
                      </button>
                    )}
                    {event.repo !== undefined && (
                      <span className="cr-lens-log-repo">{event.repo}</span>
                    )}
                  </div>
                  <div className="cr-lens-log-routing cr-activity-why">
                    <span
                      className="cr-activity-chip"
                      data-testid="activity-because"
                      title={why?.hint}
                    >
                      {why?.label ?? row.because.replace(/_/g, ' ')}
                    </span>
                    <span
                      className="cr-activity-seen"
                      data-testid="activity-status"
                      data-delivery={row.status}
                      title={[row.session, row.digest].filter(Boolean).join(' · ') || undefined}
                    >
                      {activityDelivery(row, sessions)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The knowledge in scope here. T413: each item as the Knowledge screen's
 * row (its scope and enforcement in words, a critical rule's lock and
 * word); a click opens it there.
 */
export function KnowledgeView({ rules }: { rules: readonly Rule[] }): JSX.Element {
  const { openRules } = useShell();
  const names = useOptionalFeed()?.cockpit;
  if (rules.length === 0) {
    return (
      <div data-testid="rules">
        <EmptyState icon="book-open" title="No knowledge applies here">
          Accepted rules, standards, architecture and decisions in this node’s scope show here.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="cr-kn-rows cr-node-kn" data-testid="rules">
      {rules.map((rule) => (
        <KnowledgeRow
          key={rule.id}
          item={rule}
          section={sectionOf(rule)}
          row={undefined}
          days={0}
          names={names}
          open={false}
          onOpen={() => openRules({ ...DEFAULT_RULES_FILTER, rule: rule.id })}
          onDecide={async () => {}}
          checked={undefined}
          onToggle={undefined}
          mixed
          testid="rule"
        />
      ))}
    </div>
  );
}

export function DocsView({ docs }: { docs: readonly StreamDoc[] }): JSX.Element {
  return (
    <ul className="cr-docs-list" data-testid="docs">
      {docs.length === 0 && (
        <li className="cr-dim">No docs — repo docs and this node’s docs appear here.</li>
      )}
      {docs.map((doc) => (
        <li key={doc.path} data-testid="doc">
          <details>
            <summary>
              <Icon name="file-text" size={14} />
              <span className="cr-docs-name">{doc.name}</span>
              <span className="cr-dim">{doc.source === 'repo' ? 'repo doc' : 'node doc'}</span>
            </summary>
            <Markdown text={doc.body} />
          </details>
        </li>
      ))}
    </ul>
  );
}
