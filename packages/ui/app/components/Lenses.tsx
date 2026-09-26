/**
 * T209, redesigned in T368 (design/cockpit-ui.md): the lenses over the
 * rows the rail shows, and the event log.
 *
 * - Repos: one card per repo — its kind and delivery mode in words, its
 *   live work nodes (ancestors muted), overlaps as a warning that names
 *   both nodes and the files (T227), its recent events (T245) and its
 *   norms (T265: accepted standards and architecture).
 * - Running: nodes with a live agent, your move first, with Stop in a row menu.
 * - Dependencies: every open "waits on" link, grouped by the node that waits.
 * - Events (T338): every routed event as a timeline — what happened, to
 *   which node, and which nodes were told and why — with a type filter,
 *   a search and "Show more".
 *
 * (Needs me is the inbox, already grouped by node.)
 */

import {
  DIRECTOR_NODE,
  type KnowledgeItem,
  type RoutedEvent,
  type RoutedEventType,
  formatKnowledgeScope,
} from '@agile-agents/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type RepoRow,
  getEvents,
  getRepoKnowledge,
  listRepos,
  stopSessions,
  waitOnStream,
} from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { CockpitOverlap, CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import {
  EVENT_FAMILIES,
  type EventFamily,
  ROUTE_REASON,
  clockTime,
  deliveryHint,
  deliveryWords,
  dependencyGroups,
  eventDetail,
  eventFamily,
  eventTitle,
  filterEvents,
  groupByDay,
  isSatisfied,
  runningSummary,
  sortNewestFirst,
  sortRunning,
} from '../lib/lenses';
import { namesOf } from '../lib/names';
import { KIND_LABEL, statsWords } from '../lib/rules';
import { useShell } from '../lib/shell';
import { ROLE_HINT, ROLE_LABEL, ago, nodeStatus } from '../lib/status';
import { ancestorTitles, eventTime, groupByRepo, runningRows } from '../lib/streams';
import { Icon, type IconName } from './Icon';
import { EnforcementBadge } from './KnowledgeList';
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  PageHeader,
  RepoIcon,
  Segmented,
  Spinner,
  StatusDot,
  StatusPill,
  repoKindLabel,
  useToast,
} from './ui';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A node's title, or the Director's; an id the cockpit no longer knows reads as a deleted node. */
function useTitleOf(): (id: string) => string {
  const { cockpit } = useFeed();
  const names = useMemo(() => namesOf(cockpit), [cockpit]);
  return useCallback(
    (id: string) =>
      id === DIRECTOR_NODE ? 'Director' : (names.get(id)?.title ?? 'a deleted node'),
    [names],
  );
}

/** Opens a routed-event recipient: a node's page, or the Director. */
function useOpenNode(): (id: string) => void {
  const { select, setView } = useShell();
  return useCallback(
    (id: string) => (id === DIRECTOR_NODE ? setView('director') : select(id)),
    [select, setView],
  );
}

/** "Shop › Show sale prices › " muted, then the title: what a node is, wherever it sits. */
function NodePath({
  row,
  rows,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
}): JSX.Element {
  return (
    <span className="cr-lens-path" data-testid="node-path">
      {ancestorTitles(row, rows).map((title, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ancestors are positional
        <span key={i} className="anc">
          {title} ›{' '}
        </span>
      ))}
      <span className="title">{row.title}</span>
    </span>
  );
}

/** One node as a row: its status, where it sits, and a click to open it. */
function NodeLine({
  row,
  rows,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
}): JSX.Element {
  const { select } = useShell();
  const status = nodeStatus(row);
  return (
    <li>
      <button
        type="button"
        className="cr-lens-row"
        data-stream={row.id}
        onClick={() => select(row.id)}
        title={`${row.title} — ${status.label}`}
      >
        <StatusDot row={row} status={status} />
        <NodePath row={row} rows={rows} />
        <span className="cr-lens-status" data-tone={status.tone}>
          {status.label}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- Repos

/** The Events page opens on this repo when a repo card's "All events" sent it there. */
let pendingEventRepo: string | undefined;

/** The repos' extra facts (auto-merge, main branch, path) from Settings' list; empty until read. */
function useRepoDetails(repos: readonly CockpitRepoRow[]): ReadonlyMap<string, RepoRow> {
  const [details, setDetails] = useState<ReadonlyMap<string, RepoRow>>(new Map());
  const names = repos.map((r) => `${r.name}:${r.delivery}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `names` (the repos and their delivery) is the re-read trigger.
  useEffect(() => {
    let live = true;
    listRepos()
      .then((all) => live && setDetails(new Map(all.map((r) => [r.name, r]))))
      .catch(() => {
        // The cards still read without them: no auto-merge badge, "main".
      });
    return () => {
      live = false;
    };
  }, [names]);
  return details;
}

/** Every routed event, re-read on each pushed frame; `undefined` until the first read. */
function useEvents(): { events: RoutedEvent[] | undefined; error: string | undefined } {
  const { cockpit } = useFeed();
  const [events, setEvents] = useState<RoutedEvent[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` (the pushed frame) is the re-read trigger.
  useEffect(() => {
    let live = true;
    getEvents()
      .then((e) => {
        if (!live) return;
        setEvents(sortNewestFirst(e));
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(message(err)));
    return () => {
      live = false;
    };
  }, [cockpit]);
  return { events, error };
}

const REPO_EVENTS_SHOWN = 5;

/** T245: the repo's recent events (main moved, merges, PRs), newest first. */
function RepoEvents({
  repo,
  events,
}: {
  repo: string;
  events: readonly RoutedEvent[];
}): JSX.Element | null {
  const { setView } = useShell();
  const titleOf = useTitleOf();
  const open = useOpenNode();
  if (events.length === 0) return null;
  return (
    <div className="cr-lens-section">
      {/* T341: labelled, so the events never read as more work nodes. */}
      <div className="cr-lens-section-hd">
        <h3 className="cr-lens-sub">Recent events</h3>
        {events.length > REPO_EVENTS_SHOWN && (
          <button
            type="button"
            className="cr-lens-more"
            onClick={() => {
              pendingEventRepo = repo;
              setView('events');
            }}
          >
            All {events.length} events
            <Icon name="arrow-right" size={12} />
          </button>
        )}
      </div>
      <ul className="cr-lens-evlist" data-testid="repo-events">
        {events.slice(0, REPO_EVENTS_SHOWN).map((e) => {
          const text = (
            <span className="cr-lens-ev-text" data-testid="repo-event-text">
              <span className="cr-lens-ev-label">{eventTitle(e)}</span>
              {e.subject ? ` · ${titleOf(e.subject)}` : ''}
            </span>
          );
          const when = (
            <time className="cr-lens-ev-ago" dateTime={e.at}>
              {ago(e.at)}
            </time>
          );
          return (
            <li key={e.id} data-testid="repo-event" data-event={e.id} title={eventTime(e.at)}>
              {e.subject ? (
                <button
                  type="button"
                  className="cr-lens-ev"
                  onClick={() => e.subject && open(e.subject)}
                >
                  <EventGlyph type={e.type} />
                  {text}
                  {when}
                </button>
              ) : (
                <div className="cr-lens-ev">
                  <EventGlyph type={e.type} />
                  {text}
                  {when}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const KIND_ICON: Record<KnowledgeItem['kind'], IconName> = {
  standard: 'ruler',
  architecture: 'layers',
  decision: 'signpost',
};

/** T265: the repo's accepted standards and architecture, with enforcement and stats. */
function RepoNorms({ repo }: { repo: string }): JSX.Element | null {
  const { openRules } = useShell();
  const [items, setItems] = useState<KnowledgeItem[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getRepoKnowledge(repo)
      .then((k) => live && setItems(k))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [repo]);
  if (items === undefined) return null;
  const scope = formatKnowledgeScope({ kind: 'repo', repo });
  return (
    <div className="cr-lens-section">
      <div className="cr-lens-section-hd">
        <h3
          className="cr-lens-sub"
          title="Accepted standards and architecture for this repo. Its agents are told them."
        >
          Norms
        </h3>
        {items.length > 0 && (
          <button
            type="button"
            className="cr-lens-more"
            onClick={() => openRules({ status: 'all', scope })}
          >
            In Knowledge
            <Icon name="arrow-right" size={12} />
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="cr-lens-empty" data-testid="repo-norms">
          No standards or architecture for this repo yet.
        </p>
      ) : (
        <ul className="cr-lens-norms" data-testid="repo-norms">
          {items.map((k) => {
            const counted = k.enforcement === 'action' || k.enforcement === 'ship';
            return (
              <li key={k.id} data-testid="repo-norm" data-knowledge={k.id}>
                <button
                  type="button"
                  className="cr-lens-norm"
                  title={k.text}
                  onClick={() => openRules({ status: 'all', scope: 'all', rule: k.id })}
                >
                  <Icon name={KIND_ICON[k.kind]} size={14} className="cr-lens-norm-icon" />
                  <span className="cr-lens-norm-main">
                    <span className="cr-lens-norm-name">{k.name ?? k.text}</span>
                    {k.name !== undefined && <span className="cr-lens-norm-text"> {k.text}</span>}
                  </span>{' '}
                  <span className="cr-lens-norm-kind" data-testid="norm-kind">
                    {KIND_LABEL[k.kind]}
                  </span>{' '}
                  <EnforcementBadge item={k} testid="norm-enforcement" />
                  {counted && (
                    <>
                      {' '}
                      <span className="cr-lens-norm-stats" data-testid="norm-stats">
                        {statsWords(k.stats)}
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function OverlapCallout({
  overlap,
  rows,
}: {
  overlap: CockpitOverlap;
  rows: readonly CockpitStreamRow[];
}): JSX.Element {
  const { select } = useShell();
  const titleOf = (id: string): string => rows.find((r) => r.id === id)?.title ?? 'a deleted node';
  const [a, b] = overlap.nodes;
  return (
    <div className="cr-lens-overlap" role="note">
      <Icon name="alert-triangle" size={16} className="cr-lens-overlap-icon" />
      <div>
        <p data-testid="repo-overlap">
          <button type="button" className="cr-lens-link" onClick={() => select(a)}>
            {titleOf(a)}
          </button>{' '}
          and{' '}
          <button type="button" className="cr-lens-link" onClick={() => select(b)}>
            {titleOf(b)}
          </button>{' '}
          both changed{' '}
          {overlap.files.map((f, i) => (
            <span key={f}>
              {i > 0 ? ', ' : ''}
              <code>{f}</code>
            </span>
          ))}
        </p>
        <p className="cr-lens-overlap-hint">
          Whichever merges second may conflict. Merge one first, or make one wait on the other.
        </p>
      </div>
    </div>
  );
}

function RepoCard({
  repo,
  detail,
  live,
  rows,
  overlaps,
  events,
}: {
  repo: CockpitRepoRow;
  detail: RepoRow | undefined;
  live: readonly CockpitStreamRow[];
  rows: readonly CockpitStreamRow[];
  overlaps: readonly CockpitOverlap[];
  events: readonly RoutedEvent[];
}): JSX.Element {
  const pr = repo.delivery === 'pr';
  const autoMerge = pr && detail?.auto_merge === true;
  const main = detail?.main_branch;
  return (
    <article
      className="cr-group cr-lens-repo"
      data-repo={repo.name}
      data-live={live.length > 0 ? 'true' : undefined}
    >
      <header className="cr-lens-repo-hd">
        <span className="cr-lens-repo-icon">
          <RepoIcon remote={repo.remote} size={18} />
        </span>
        <div className="cr-lens-repo-id">
          <h2 title={detail?.path}>{repo.name}</h2>
          <span className="cr-lens-repo-kind">
            {repoKindLabel(repo.remote)}
            {main !== undefined && main !== 'main' ? ` · ${main}` : ''}
          </span>
        </div>
        <div className="cr-lens-repo-badges">
          <Badge
            testid="repo-delivery"
            icon={pr ? 'git-pull-request' : 'git-merge'}
            title={deliveryHint(repo.delivery, { autoMerge, ...(main ? { main } : {}) })}
          >
            {deliveryWords(repo.delivery)}
          </Badge>
          {autoMerge && (
            <Badge tone="green" icon="check" title="Pull requests merge once their checks pass.">
              Auto-merge
            </Badge>
          )}
        </div>
      </header>
      <div className="cr-lens-section">
        <div className="cr-lens-section-hd">
          <h3 className="cr-lens-sub">Live work</h3>
          {live.length > 0 && <span className="cr-count">{live.length}</span>}
        </div>
        {live.length === 0 ? (
          <p className="cr-lens-empty">Nothing live on this repo.</p>
        ) : (
          <ul className="cr-lens-rows">
            {live.map((row) => (
              <NodeLine key={row.id} row={row} rows={rows} />
            ))}
          </ul>
        )}
        {overlaps.map((o) => (
          <OverlapCallout key={o.nodes.join('-')} overlap={o} rows={rows} />
        ))}
      </div>
      <RepoEvents repo={repo.name} events={events} />
      <RepoNorms repo={repo.name} />
    </article>
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
  const { setView } = useShell();
  const details = useRepoDetails(repos);
  const { events } = useEvents();
  const groups = groupByRepo(rows, repos);
  // Repos with work in flight first; the quiet ones after, each alphabetical.
  const ordered = [...groups].sort((a, b) => Number(b.rows.length > 0) - Number(a.rows.length > 0));
  const byName = new Map(repos.map((r) => [r.name, r]));
  const liveCount = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <section className="cr-page cr-lens" data-testid="repo-view">
      <PageHeader title="Repos" icon="folder-git">
        <p className="cr-lens-lede">
          Live work by repository
          {groups.length > 0
            ? ` · ${liveCount} live ${liveCount === 1 ? 'node' : 'nodes'} across ${groups.length} ${
                groups.length === 1 ? 'repo' : 'repos'
              }`
            : ''}
        </p>
      </PageHeader>
      {groups.length === 0 ? (
        <EmptyState
          icon="folder-git"
          title="No repos yet"
          actions={
            <Button icon="settings" onClick={() => setView('settings')}>
              Open Settings
            </Button>
          }
        >
          Add a repo in Settings. Its live work, overlaps, events and norms show here.
        </EmptyState>
      ) : (
        <div className="cr-lens-repos">
          {ordered.map((group) => (
            <RepoCard
              key={group.repo}
              repo={byName.get(group.repo) ?? { name: group.repo, delivery: group.delivery }}
              detail={details.get(group.repo)}
              live={group.rows}
              rows={rows}
              overlaps={overlaps.filter((o) => o.repo === group.repo)}
              events={(events ?? []).filter((e) => e.repo === group.repo)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Running

function RunningRow({
  row,
  rows,
  repo,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
  repo: CockpitRepoRow | undefined;
}): JSX.Element {
  const { select } = useShell();
  const { refresh } = useFeed();
  const toast = useToast();
  const status = nodeStatus(row);
  const stop = (): void => {
    stopSessions(row.id)
      .then(() => {
        toast({ tone: 'success', title: 'Agent stopped', body: row.title, duration: 3000 });
        refresh();
      })
      .catch((err: unknown) =>
        toast({ tone: 'error', title: `Could not stop “${row.title}”`, body: message(err) }),
      );
  };
  return (
    <li className="cr-lens-run">
      <button
        type="button"
        className="cr-lens-row"
        data-stream={row.id}
        onClick={() => select(row.id)}
        title={status.hint}
      >
        <span className="cr-lens-run-status">
          <StatusPill row={row} status={status} />
        </span>
        <NodePath row={row} rows={rows} />
        <span className="cr-lens-run-role" title={ROLE_HINT[row.role]}>
          {ROLE_LABEL[row.role]}
        </span>
        <span className="cr-lens-run-repo">
          {row.repo !== undefined ? (
            <>
              <RepoIcon remote={repo?.remote} size={13} />
              <span>{row.repo}</span>
            </>
          ) : (
            <span className="cr-faint">No repo</span>
          )}
        </span>
      </button>
      <span className="cr-lens-run-menu">
        <Menu
          label={`Options for ${row.title}`}
          testid="running-menu"
          items={[
            { label: 'Open', icon: 'arrow-right', onSelect: () => select(row.id) },
            'separator',
            {
              label: 'Stop agent',
              icon: 'square',
              danger: true,
              title: 'Stops its agent; send a message or press Start to resume.',
              onSelect: stop,
              testid: 'running-stop',
            },
          ]}
        />
      </span>
    </li>
  );
}

export function RunningLens({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element {
  const { setNewStreamOpen } = useShell();
  const { cockpit } = useFeed();
  const running = sortRunning(runningRows(rows));
  const repos = new Map((cockpit?.repos ?? []).map((r) => [r.name, r]));
  return (
    <section className="cr-page cr-lens" data-testid="running-lens">
      <PageHeader title="Running" icon="zap">
        <p className="cr-lens-lede">
          {running.length > 0 ? runningSummary(running) : 'Nodes with a live agent'}
        </p>
      </PageHeader>
      {running.length === 0 ? (
        <EmptyState
          icon="zap"
          title="No agents running"
          actions={
            <Button icon="plus" onClick={() => setNewStreamOpen(true)}>
              New node
            </Button>
          }
        >
          An agent runs while it works or waits for you. Create a node and its agent starts on its
          own, or open a node and send it a message.
        </EmptyState>
      ) : (
        <div className="cr-lens-table">
          <div className="cr-lens-table-hd" aria-hidden="true">
            <span>Status</span>
            <span>Node</span>
            <span>Role</span>
            <span>Repo</span>
          </div>
          <ul className="cr-lens-rows">
            {running.map((row) => (
              <RunningRow
                key={row.id}
                row={row}
                rows={rows}
                repo={row.repo !== undefined ? repos.get(row.repo) : undefined}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Dependencies

function DependencyEdgeRow({
  from,
  on,
  rows,
}: {
  from: CockpitStreamRow;
  on: CockpitStreamRow | string;
  rows: readonly CockpitStreamRow[];
}): JSX.Element {
  const { select } = useShell();
  const { refresh } = useFeed();
  const toast = useToast();
  const target = typeof on === 'string' ? undefined : on;
  const onId = typeof on === 'string' ? on : on.id;
  const satisfied = isSatisfied(on);
  const where = target ? ancestorTitles(target, rows).join(' › ') : '';
  const relink = (): void => {
    waitOnStream(from.id, onId)
      .then(refresh)
      .catch((err: unknown) =>
        toast({ tone: 'error', title: 'Could not add the link back', body: message(err) }),
      );
  };
  const remove = (): void => {
    waitOnStream(from.id, onId, true)
      .then(() => {
        refresh();
        toast({
          tone: 'success',
          title: 'Link removed',
          body: `${from.title} no longer waits on ${target?.title ?? 'that node'}.`,
          action: { label: 'Undo', onClick: relink },
        });
      })
      .catch((err: unknown) =>
        toast({ tone: 'error', title: 'Could not remove the link', body: message(err) }),
      );
  };
  return (
    <li className="cr-lens-dep-edge" data-testid="dep-edge" data-satisfied={satisfied || undefined}>
      <span className="cr-lens-dep-text" data-testid="dep-edge-text">
        {/* The sentence reads whole to a screen reader; the group heading already shows it. */}
        <span className="cr-lens-sr">{from.title} </span>
        <span className="cr-lens-dep-verb">waits on</span>{' '}
        {target ? (
          <button type="button" className="cr-lens-link" onClick={() => select(target.id)}>
            {target.title}
          </button>
        ) : (
          <span className="cr-faint" title={onId}>
            a deleted node
          </span>
        )}
      </span>
      {where !== '' && <span className="cr-lens-dep-where">{where}</span>}
      <span className="cr-lens-dep-state">
        {target ? (
          satisfied ? (
            <Badge tone="green" icon="check" title="It merged; nothing is held any more.">
              Done
            </Badge>
          ) : (
            <StatusPill row={target} />
          )
        ) : null}
      </span>
      <Menu
        label="Options for this link"
        testid="dep-menu"
        items={[
          ...(target
            ? [
                {
                  label: `Open ${target.title}`,
                  icon: 'arrow-right' as const,
                  onSelect: () => select(target.id),
                },
              ]
            : []),
          {
            label: 'Remove link',
            icon: 'x',
            danger: true,
            title: `${from.title} will no longer wait before it merges.`,
            onSelect: remove,
            testid: 'dep-remove',
          },
        ]}
      />
    </li>
  );
}

export function DependenciesLens({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element {
  const { select } = useShell();
  const groups = dependencyGroups(rows);
  const edges = groups.reduce((n, g) => n + g.on.length, 0);
  return (
    <section className="cr-page cr-lens" data-testid="deps-lens">
      <PageHeader title="Dependencies" icon="link">
        <p className="cr-lens-lede">
          {edges > 0
            ? `${edges} "waits on" ${edges === 1 ? 'link' : 'links'}. A node that waits on another holds its merge until that one merges.`
            : 'What waits on what, across projects'}
        </p>
      </PageHeader>
      {groups.length === 0 ? (
        <EmptyState icon="link" title="Nothing waits on anything">
          A “waits on” link holds a node's merge until another node merges — for when one change
          needs another in first. Add one from a node's page: its ⋯ menu → Waits on…
        </EmptyState>
      ) : (
        <div className="cr-lens-deps">
          {groups.map(({ from, on }) => {
            const status = nodeStatus(from);
            return (
              <article key={from.id} className="cr-lens-dep" data-node={from.id}>
                <button
                  type="button"
                  className="cr-lens-row cr-lens-dep-hd"
                  onClick={() => select(from.id)}
                  title={`${from.title} — ${status.label}`}
                >
                  <StatusDot row={from} status={status} />
                  <NodePath row={from} rows={rows} />
                  <span className="cr-lens-status" data-tone={status.tone}>
                    {status.label}
                  </span>
                </button>
                <ul className="cr-lens-dep-list">
                  {on.map((o) => (
                    <DependencyEdgeRow
                      key={typeof o === 'string' ? o : o.id}
                      from={from}
                      on={o}
                      rows={rows}
                    />
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Events

const EVENT_ICON: Partial<Record<RoutedEventType, IconName>> = {
  human_line: 'user',
  answer: 'corner-down-left',
  director_request: 'sparkles',
  child_question: 'help-circle',
  tangent_summary: 'git-fork',
  pr_review: 'eye',
  ci_failed: 'x-circle',
  pr_behind: 'git-pull-request',
  pr_merged: 'git-merge',
  pr_closed: 'x-circle',
  main_changed: 'git-branch',
  sync_conflict: 'alert-triangle',
  ship_findings: 'shield-check',
  child_delivered: 'git-merge',
  child_status: 'layers',
  overlap: 'alert-triangle',
  symbol_changed: 'code',
  contract_changed: 'file-text',
  contract_proposal: 'file-text',
  dependency_satisfied: 'link',
  plan_changed: 'list',
  external_changed: 'ticket',
  knowledge_accepted: 'book-open',
};

const FAMILY_ICON: Record<EventFamily, IconName> = {
  messages: 'message-square',
  delivery: 'git-merge',
  coordination: 'network',
  knowledge: 'book-open',
};

/** Events that are news in colour: a failure red, a warning amber, a merge purple. */
const EVENT_TONE: Partial<Record<RoutedEventType, 'red' | 'amber' | 'purple' | 'green'>> = {
  ci_failed: 'red',
  sync_conflict: 'red',
  pr_closed: 'red',
  overlap: 'amber',
  pr_behind: 'amber',
  ship_findings: 'amber',
  pr_merged: 'purple',
  child_delivered: 'purple',
  dependency_satisfied: 'green',
  knowledge_accepted: 'green',
};

function EventGlyph({ type }: { type: RoutedEventType }): JSX.Element {
  return (
    <span className="cr-lens-ev-glyph" data-tone={EVENT_TONE[type]} aria-hidden="true">
      <Icon name={EVENT_ICON[type] ?? FAMILY_ICON[eventFamily(type)]} size={13} />
    </span>
  );
}

function EventRow({
  event,
  today,
  titleOf,
}: {
  event: RoutedEvent;
  today: boolean;
  titleOf: (id: string) => string;
}): JSX.Element {
  const open = useOpenNode();
  const detail = eventDetail(event, titleOf);
  return (
    <li
      className="cr-lens-log-row"
      data-testid="event-log-row"
      data-event={event.id}
      data-type={event.type}
    >
      <time className="cr-lens-log-time" dateTime={event.at} title={eventTime(event.at)}>
        {today ? ago(event.at) : clockTime(event.at)}
      </time>
      <div className="cr-lens-log-what">
        <EventGlyph type={event.type} />
        <div className="cr-lens-log-text">
          <span className="cr-lens-ev-label" data-testid="event-log-type">
            {eventTitle(event)}
          </span>
          {detail !== undefined && <span className="cr-lens-log-detail">{detail}</span>}
        </div>
      </div>
      <div className="cr-lens-log-node" data-empty={event.subject === undefined || undefined}>
        {event.subject !== undefined ? (
          <button
            type="button"
            className="cr-lens-link"
            data-testid="event-log-node"
            onClick={() => event.subject && open(event.subject)}
          >
            {titleOf(event.subject)}
          </button>
        ) : (
          <span className="cr-faint">—</span>
        )}
        {event.repo !== undefined && (
          <span className="cr-lens-log-repo" data-testid="event-log-repo">
            {event.repo}
          </span>
        )}
      </div>
      <div className="cr-lens-log-routing">
        {event.routing.length > 0 ? (
          <span className="cr-lens-chips" data-testid="event-log-routing">
            <span className="cr-lens-sr">Routed to </span>
            {event.routing.map((r) => (
              <button
                key={r.node}
                type="button"
                className="cr-lens-chip"
                title={`${titleOf(r.node)}: ${ROUTE_REASON[r.because].hint}`}
                onClick={() => open(r.node)}
              >
                <span className="cr-lens-chip-name">{titleOf(r.node)}</span>
                <span className="cr-lens-chip-why">· {ROUTE_REASON[r.because].label}</span>
              </button>
            ))}
          </span>
        ) : (
          <span className="cr-faint" title="No node was told about it.">
            Nobody
          </span>
        )}
      </div>
    </li>
  );
}

const EVENTS_PAGE = 50;

/**
 * T338, redesigned in T368: the event log — every routed event, newest
 * first: what happened, to which node, and who it was routed to and why.
 * Re-read on every pushed frame.
 */
export function EventLog(): JSX.Element {
  const { cockpit } = useFeed();
  const { events, error } = useEvents();
  const titleOf = useTitleOf();
  const [family, setFamily] = useState<EventFamily | 'all'>('all');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<string | undefined>(() => {
    const pending = pendingEventRepo;
    pendingEventRepo = undefined;
    return pending;
  });
  const [shown, setShown] = useState(EVENTS_PAGE);

  const all = events ?? [];
  const filtered = filterEvents(all, { family, query, repo }, titleOf, eventTitle);
  const days = groupByDay(filtered.slice(0, shown));
  const repoNames = [
    ...new Set([...(cockpit?.repos ?? []).map((r) => r.name), ...(repo ? [repo] : [])]),
  ].sort();
  const narrowed = family !== 'all' || query.trim() !== '' || repo !== undefined;
  const clear = (): void => {
    setFamily('all');
    setQuery('');
    setRepo(undefined);
  };

  return (
    <section className="cr-page cr-lens" data-testid="event-log">
      <PageHeader title="Events" icon="activity">
        <p className="cr-lens-lede">
          Everything that happened, newest first, and which nodes were told.
        </p>
      </PageHeader>
      <div className="cr-lens-toolbar">
        <label className="cr-lens-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            data-testid="event-log-search"
            aria-label="Search events"
            placeholder="Search events"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(EVENTS_PAGE);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
        </label>
        <div className="cr-lens-seg">
          <Segmented
            label="Event type"
            testid="event-log-family"
            value={family}
            onChange={(next) => {
              setFamily(next);
              setShown(EVENTS_PAGE);
            }}
            items={EVENT_FAMILIES}
          />
        </div>
        {repoNames.length > 1 && (
          <select
            className="cr-lens-select"
            data-testid="event-log-repo-filter"
            aria-label="Repo"
            data-active={repo !== undefined ? 'true' : undefined}
            value={repo ?? ''}
            onChange={(e) => {
              setRepo(e.target.value || undefined);
              setShown(EVENTS_PAGE);
            }}
          >
            <option value="">All repos</option>
            {repoNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {events !== undefined && (
          <span className="cr-lens-count" data-testid="event-log-count">
            {narrowed ? `${filtered.length} of ${all.length}` : all.length}{' '}
            {all.length === 1 ? 'event' : 'events'}
          </span>
        )}
      </div>
      {error !== undefined ? (
        <p className="cr-error" role="alert">
          Could not read the events: {error}
        </p>
      ) : events === undefined ? (
        <p className="cr-lens-loading">
          <Spinner /> Loading events…
        </p>
      ) : all.length === 0 ? (
        <EmptyState icon="activity" title="No events yet">
          When something happens — a message, a merge, a review, an overlap — it shows here with the
          nodes it was routed to.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title="No events match"
          actions={
            <Button size="sm" onClick={clear}>
              Clear filters
            </Button>
          }
        >
          Nothing in the last {all.length} events matches these filters.
        </EmptyState>
      ) : (
        <div className="cr-lens-log">
          <div className="cr-lens-log-hd" aria-hidden="true">
            <span>When</span>
            <span>Event</span>
            <span>Node</span>
            <span>Routed to</span>
          </div>
          {days.map((day) => (
            <section key={day.day} className="cr-lens-day" aria-label={day.day}>
              <h3 className="cr-lens-day-hd">{day.day}</h3>
              <ul className="cr-lens-rows">
                {day.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    today={day.day === 'Today'}
                    titleOf={titleOf}
                  />
                ))}
              </ul>
            </section>
          ))}
          {filtered.length > shown && (
            <div className="cr-lens-showmore">
              <Button
                variant="ghost"
                size="sm"
                data-testid="event-log-more"
                onClick={() => setShown((n) => n + EVENTS_PAGE)}
              >
                Show {Math.min(EVENTS_PAGE, filtered.length - shown)} more
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
