/**
 * T209 (projects-design §3): the repo view and the lenses over the same
 * rows the rail shows. By repo: live work nodes grouped by repo across
 * projects, ancestors in grey, the repo's delivery mode in the heading.
 * Running: nodes with a live session. Dependencies: the `waits_on` graph
 * as a list. (Needs me is the inbox, already grouped by node.)
 * Overlaps (T227) show per repo, and so do its norms (T265): the accepted
 * standards and architecture scoped to it, with enforcement and stats.
 */

import type { KnowledgeItem, RoutedEvent } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { getRepoEvents, getRepoKnowledge } from '../lib/api';
import type { CockpitOverlap, CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import { useShell } from '../lib/shell';
import {
  DOT_LABEL,
  ancestorTitles,
  dependencyEdges,
  groupByRepo,
  runningRows,
  streamDot,
} from '../lib/streams';

/** T245: the repo's recent events (main moved, PRs), newest first. */
function RepoEvents({
  repo,
  titleOf,
}: { repo: string; titleOf: (id: string) => string }): JSX.Element | null {
  const [events, setEvents] = useState<RoutedEvent[]>([]);
  useEffect(() => {
    let live = true;
    getRepoEvents(repo)
      .then((e) => live && setEvents(e.slice(0, 10)))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [repo]);
  if (events.length === 0) return null;
  return (
    <ul className="cr-lens-list" data-testid="repo-events">
      {events.map((e) => (
        <li key={e.id} className="cr-dim" data-testid="repo-event" data-event={e.id} title={e.at}>
          {e.type.replace(/_/g, ' ')}
          {e.subject ? ` · ${titleOf(e.subject)}` : ''}
        </li>
      ))}
    </ul>
  );
}

/** T265: the repo's accepted standards and architecture, with enforcement and stats. */
function RepoNorms({ repo }: { repo: string }): JSX.Element {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  useEffect(() => {
    let live = true;
    getRepoKnowledge(repo)
      .then((k) => live && setItems(k))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [repo]);
  if (items.length === 0) {
    return (
      <p className="cr-lens-empty" data-testid="repo-norms">
        No norms.
      </p>
    );
  }
  return (
    <ul className="cr-lens-list" data-testid="repo-norms">
      {items.map((k) => (
        <li key={k.id} className="cr-dim" data-testid="repo-norm" data-knowledge={k.id}>
          <span data-testid="norm-kind">{k.kind}</span> · {k.name ?? k.text}{' '}
          <span data-testid="norm-enforcement">({k.enforcement})</span>{' '}
          <span data-testid="norm-stats">
            fired {k.stats.fired}, violated {k.stats.violated}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NodeLine({
  row,
  rows,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
}): JSX.Element {
  const { select } = useShell();
  const dot = streamDot(row);
  return (
    <li>
      <button
        type="button"
        className="cr-lens-row"
        data-stream={row.id}
        onClick={() => select(row.id)}
        title={DOT_LABEL[dot]}
      >
        <span className="cr-dot" data-dot={dot} aria-label={DOT_LABEL[dot]} />
        <span className="cr-lens-path" data-testid="node-path">
          {ancestorTitles(row, rows).map((title, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ancestors are positional
            <span key={i} className="anc">
              {title} ›{' '}
            </span>
          ))}
          <span className="title">{row.title}</span>
        </span>
      </button>
    </li>
  );
}

export function RepoView({
  rows,
  repos,
  overlaps = [],
}: {
  rows: readonly CockpitStreamRow[];
  repos: readonly CockpitRepoRow[];
  overlaps?: readonly CockpitOverlap[];
}): JSX.Element {
  const groups = groupByRepo(rows, repos);
  const titleOf = (id: string): string => rows.find((r) => r.id === id)?.title ?? id;
  return (
    <section className="cr-inbox" data-testid="repo-view">
      <div className="cr-inbox-hd">
        <h1>By repo</h1>
      </div>
      {groups.length === 0 && <p className="cr-calm">No repos registered.</p>}
      {groups.map((group) => (
        <div key={group.repo} className="cr-group" data-repo={group.repo}>
          <h2>
            {group.repo}{' '}
            <span className="cr-lens-mode" data-testid="repo-delivery">
              ({group.delivery})
            </span>
          </h2>
          {group.rows.length === 0 ? (
            <p className="cr-lens-empty">No live work.</p>
          ) : (
            <ul className="cr-lens-list">
              {group.rows.map((row) => (
                <NodeLine key={row.id} row={row} rows={rows} />
              ))}
            </ul>
          )}
          {overlaps
            .filter((o) => o.repo === group.repo)
            .map((o) => (
              <p key={o.nodes.join('-')} className="cr-overlap" data-testid="repo-overlap">
                ⚠ {titleOf(o.nodes[0])} and {titleOf(o.nodes[1])} both changed {o.files.join(', ')}
              </p>
            ))}
          <RepoEvents repo={group.repo} titleOf={titleOf} />
          <RepoNorms repo={group.repo} />
        </div>
      ))}
    </section>
  );
}

export function RunningLens({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element {
  const running = runningRows(rows);
  return (
    <section className="cr-inbox" data-testid="running-lens">
      <div className="cr-inbox-hd">
        <h1>Running</h1>
      </div>
      {running.length === 0 ? (
        <p className="cr-calm">Nothing running.</p>
      ) : (
        <ul className="cr-lens-list">
          {running.map((row) => (
            <NodeLine key={row.id} row={row} rows={rows} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DependenciesLens({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element {
  const { select } = useShell();
  const edges = dependencyEdges(rows);
  return (
    <section className="cr-inbox" data-testid="deps-lens">
      <div className="cr-inbox-hd">
        <h1>Dependencies</h1>
      </div>
      {edges.length === 0 ? (
        <p className="cr-calm">Nothing waits on anything.</p>
      ) : (
        <ul className="cr-lens-list">
          {edges.map((edge) => {
            const on = typeof edge.on === 'string' ? undefined : edge.on;
            return (
              <li key={`${edge.from.id}-${on?.id ?? edge.on}`} data-testid="dep-edge">
                <button type="button" className="cr-lens-link" onClick={() => select(edge.from.id)}>
                  {edge.from.title}
                </button>{' '}
                <span className="anc">waits on</span>{' '}
                {on ? (
                  <button type="button" className="cr-lens-link" onClick={() => select(on.id)}>
                    {on.title}
                  </button>
                ) : (
                  <span className="anc">{String(edge.on)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
