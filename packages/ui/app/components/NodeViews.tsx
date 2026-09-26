/**
 * T363: a node's other tabs — Plan (who owns what, the contracts, and a
 * draft's Approve), Activity (what woke this node and why, as a timeline),
 * Knowledge (exactly what is in scope) and Docs.
 */

import {
  type KnowledgeItem as Rule,
  type SessionRef,
  formatKnowledgeScope,
} from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { approvePlan, getStreamActivity, getStreamPlan } from '../lib/api';
import type { ActivityEntry, StreamDoc } from '../lib/feed-types';
import { ROUTE_REASON, eventTitle } from '../lib/lenses';
import { DEFAULT_RULES_FILTER } from '../lib/rules';
import { useShell } from '../lib/shell';
import { activityDelivery, eventTime } from '../lib/streams';
import { Icon } from './Icon';
import { Linked, Markdown } from './Markdown';
import { Badge, Button, EmptyState } from './ui';

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

/** T338: a node by its title, as a link that opens its page (never the raw id). */
export function NodeLink({
  id,
  titleOf,
}: {
  id: string;
  titleOf: (id: string) => string;
}): JSX.Element {
  const { select } = useShell();
  return (
    <a
      href={`#${id}`}
      className="cr-ref"
      data-node={id}
      title={id}
      onClick={(e) => {
        e.preventDefault();
        select(id);
      }}
    >
      {titleOf(id)}
    </a>
  );
}

/** T281 (§9.1): who owns what, the contracts between the children, and the draft's Approve. */
export function PlanView({
  id,
  tick,
  onChanged,
  titleOf,
}: {
  id: string;
  tick: unknown;
  onChanged: () => void;
  titleOf: (id: string) => string;
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
        <EmptyState icon="list" title="No plan yet">
          The coordinator writes one when it splits the work into parts: who owns which files, and
          the contracts between them.
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

/** T245: what woke this node and why — every routed event, its reason, and what carried it. */
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
      <div className="cr-empty-inline">
        <Icon name="activity" size={16} />
        <p data-testid="activity-empty">No events routed here yet.</p>
      </div>
    );
  return (
    <ol className="cr-timeline" data-testid="activity">
      {rows.map((row) => (
        <li
          key={row.event.id}
          className="cr-timeline-row"
          data-testid="activity-row"
          data-event={row.event.id}
          data-delivery={row.status}
        >
          <span className="cr-timeline-dot" aria-hidden="true" />
          <div className="cr-timeline-main">
            <span className="cr-timeline-type" data-testid="activity-type">
              {eventTitle(row.event)}
            </span>
            {row.event.repo ? <span className="cr-dim"> · {row.event.repo}</span> : null}
            <span className="cr-dim"> · </span>
            <span
              className="cr-dim"
              data-testid="activity-because"
              title={ROUTE_REASON[row.because]?.hint}
            >
              {ROUTE_REASON[row.because]?.label ?? row.because.replace(/_/g, ' ')}
            </span>
            <span
              className="cr-dim"
              data-testid="activity-status"
              title={[row.session, row.digest].filter(Boolean).join(' · ') || undefined}
            >
              {' '}
              · {activityDelivery(row, sessions)}
            </span>
          </div>
          <time className="cr-timeline-time" dateTime={row.event.at} title={row.event.at}>
            {' '}
            · {eventTime(row.event.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export function KnowledgeView({ rules }: { rules: readonly Rule[] }): JSX.Element {
  const { openRules } = useShell();
  return (
    <ul className="cr-kn" data-testid="rules">
      {rules.length === 0 && <li className="cr-dim">No accepted knowledge in scope.</li>}
      {rules.map((rule) => (
        <li key={rule.id} className="cr-kn-item" data-testid="rule" data-rule={rule.id}>
          <div className="cr-kn-meta">
            {rule.name !== undefined && <span className="cr-kn-name">{rule.name}</span>}
            <span className="cr-dim">
              {rule.name !== undefined ? ' · ' : ''}
              <Linked text={formatKnowledgeScope(rule.scope)} /> · {rule.kind} · {rule.enforcement}
            </span>
            {rule.critical ? (
              <Badge tone="red" icon="alert-triangle">
                critical
              </Badge>
            ) : null}
            <button
              type="button"
              className="cr-link cr-kn-open"
              onClick={() => openRules({ ...DEFAULT_RULES_FILTER, rule: rule.id })}
            >
              Open
            </button>
          </div>
          <Markdown text={rule.text} />
        </li>
      ))}
    </ul>
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
