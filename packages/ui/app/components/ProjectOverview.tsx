/**
 * T387: a project's Overview — the first tab on its root node's page, like
 * Linear's project page: what the project is doing at a glance.
 *
 *  - The counts by status, your move first ("1 needs you · 1 blocked ·
 *    1 ready to merge · 3 working · 2 not started"); a count filters the
 *    list. T424: each count is one status, with that status's own dot and
 *    word, and the counts are the list's own grouping, so they agree.
 *  - Its nodes as rows (status, where it sits, repo, agent, age): your move,
 *    in progress, not running; done, merged and closed fold under
 *    "Finished".
 *  - Its repos: icon, kind and what Merge does there.
 *  - Its recent events, with a link to Events.
 *
 * The grouping, counts and event filter live in `lib/overview.ts`.
 */

import type { RoutedEvent } from '@agile-agents/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getEvents } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import {
  childStatusPhrase,
  deliveryHint,
  deliveryWords,
  eventDetail,
  eventTitle,
  runningAgent,
} from '../lib/lenses';
import {
  OVERVIEW_FOLD_AT,
  type OverviewStatus,
  RECENT_EVENTS,
  createdAt,
  lastChange,
  openNodesOn,
  overviewCounts,
  overviewSections,
  overviewStatus,
  pathUnder,
  projectNodes,
  projectRepoNames,
  recentProjectEvents,
} from '../lib/overview';
import { isShortcut, useShell } from '../lib/shell';
import { ago, nodeStatus } from '../lib/status';
import { eventTime } from '../lib/streams';
import { Icon } from './Icon';
import { EventGlyph } from './Lenses';
import {
  Button,
  EmptyState,
  Kbd,
  RepoIcon,
  Spinner,
  StatusDot,
  StatusPill,
  repoKindLabel,
} from './ui';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- recent activity

/** How many events one read asks for, and how many reads the first look may take. */
const EVENT_PAGE = 200;
const EVENT_PAGES = 3;
/** After a push only the newest events are new: a smaller read. */
const PUSH_PAGE = 50;
/** How often, at most, the events are re-read while frames keep arriving. */
const PUSH_REREAD_MS = 400;

/** A count that goes up once after the feed pushes a frame, at most every `PUSH_REREAD_MS`. */
function usePushTick(): number {
  const { cockpit } = useFeed();
  const [tick, setTick] = useState(0);
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` (the pushed frame) is the trigger.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setTick((n) => n + 1);
    }, PUSH_REREAD_MS);
  }, [cockpit]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return tick;
}

/**
 * The project's newest events. The daemon filters the log by repo, not by
 * project, and a project's conversations have no repo, so this reads the
 * whole log's newest page and keeps the events about the project's nodes:
 * one read, and up to two older pages only while fewer than
 * `RECENT_EVENTS` turned up. After each push, the newest page again.
 */
function useProjectEvents(
  project: string,
  nodes: ReadonlySet<string>,
): { events: readonly RoutedEvent[] | undefined; error: string | undefined } {
  const tick = usePushTick();
  const [events, setEvents] = useState<readonly RoutedEvent[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef(nodes);
  latest.current = nodes;
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setEvents(undefined);
    setError(undefined);
    void (async () => {
      let shown: readonly RoutedEvent[] = [];
      let before: string | undefined;
      try {
        for (let read = 0; read < EVENT_PAGES; read++) {
          const page = await getEvents({
            limit: EVENT_PAGE,
            ...(before !== undefined ? { before } : {}),
          });
          if (generation.current !== mine) return;
          shown = recentProjectEvents(shown, page.events, project, latest.current);
          before = page.events.at(-1)?.id;
          if (shown.length >= RECENT_EVENTS || !page.more || before === undefined) break;
        }
        setEvents(shown);
      } catch (err) {
        if (generation.current === mine) setError(message(err));
      }
    })();
  }, [project]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` (a pushed frame) is the re-read trigger.
  useEffect(() => {
    if (tick === 0) return;
    const mine = generation.current;
    getEvents({ limit: PUSH_PAGE })
      .then((page) => {
        if (generation.current !== mine) return;
        setEvents((current) =>
          current === undefined
            ? current
            : recentProjectEvents(current, page.events, project, latest.current),
        );
        setError(undefined);
      })
      .catch(() => {
        // What is shown stays; the next push reads again.
      });
  }, [tick]);

  return { events, error };
}

/**
 * What a Recent activity row says after its label. T447 (audit r7 #19): a
 * child's status in the Events words ("Schedule posts is ready to merge",
 * `childStatusPhrase`); otherwise the node it is about, else what it says
 * (a standard's text), else its repo.
 */
function recentEventText(
  e: RoutedEvent,
  titleOf: (id: string) => string,
  rowOf: (id: string) => CockpitStreamRow | undefined,
): string | undefined {
  if (e.type === 'child_status') {
    const child = typeof e.payload.child === 'string' ? e.payload.child : undefined;
    const title =
      typeof e.payload.title === 'string' && e.payload.title !== ''
        ? e.payload.title
        : titleOf(child ?? e.subject ?? '');
    const status = typeof e.payload.status === 'string' ? e.payload.status : '';
    return `${title} ${childStatusPhrase(status, child !== undefined ? rowOf(child) : undefined)}`;
  }
  return e.subject !== undefined ? titleOf(e.subject) : (eventDetail(e, titleOf) ?? e.repo);
}

function RecentActivity({
  project,
  root,
  nodes,
  titleOf,
  onOpenChat,
}: {
  project: string;
  root: string;
  nodes: ReadonlySet<string>;
  titleOf: (id: string) => string;
  onOpenChat: () => void;
}): JSX.Element {
  const { select, setView } = useShell();
  const { cockpit } = useFeed();
  const { events, error } = useProjectEvents(project, nodes);
  const rowOf = (id: string) => cockpit?.streams.find((r) => r.id === id);
  // An event about the root is on this page already: its chat.
  const open = (id: string): void => (id === root ? onOpenChat() : select(id));
  return (
    <section
      className="cr-ov-section"
      aria-labelledby="ov-activity"
      data-testid="overview-activity"
    >
      <div className="cr-ov-section-hd">
        <h2 id="ov-activity" className="cr-ov-h">
          Recent activity
        </h2>
        <button
          type="button"
          className="cr-ov-link"
          data-testid="overview-events"
          title="Every event, in Events"
          onClick={() => setView('events')}
        >
          All events
          <Icon name="arrow-right" size={12} />
        </button>
      </div>
      {error !== undefined && events === undefined ? (
        <p className="cr-ov-quiet" role="alert">
          Could not read the events: {error}
        </p>
      ) : events === undefined ? (
        <p className="cr-ov-quiet">
          <Spinner size={12} /> Loading…
        </p>
      ) : events.length === 0 ? (
        <p className="cr-ov-quiet" data-testid="overview-activity-empty">
          Nothing has happened here yet. Messages, merges and reviews on this project’s nodes show
          here.
        </p>
      ) : (
        <ul className="cr-ov-events">
          {events.map((e) => {
            const about = recentEventText(e, titleOf, rowOf);
            const body = (
              <>
                <EventGlyph event={e} />
                <span className="cr-ov-ev-text">
                  <span className="cr-ov-ev-label">{eventTitle(e)}</span>
                  {about !== undefined && <span className="cr-ov-ev-node"> · {about}</span>}
                </span>
                <time className="cr-ov-ev-ago" dateTime={e.at}>
                  {ago(e.at)}
                </time>
              </>
            );
            return (
              <li key={e.id} data-testid="overview-event" data-event={e.id} title={eventTime(e.at)}>
                {e.subject !== undefined ? (
                  <button
                    type="button"
                    className="cr-ov-ev"
                    onClick={() => e.subject !== undefined && open(e.subject)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="cr-ov-ev">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- nodes

function NodeRow({
  row,
  rows,
  root,
  repo,
  summary,
  nested,
  fold,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
  /** Where its path starts: the project's root, or (nested under a branch) its top-level node. */
  root: string;
  repo: CockpitRepoRow | undefined;
  /** T447: a top-level node's counts over its branch. */
  summary?: string;
  /** T447: a row under its top-level node. */
  nested?: boolean;
  /** T447: a branch's fold toggle, before its status; `null` keeps its room (a branch of one). */
  fold?: { open: boolean; toggle: () => void; count: number } | null;
}): JSX.Element {
  const { select } = useShell();
  const status = nodeStatus(row);
  const agent = runningAgent(row);
  const born = createdAt(row.id);
  const bornAt = born !== undefined ? new Date(born).toISOString() : undefined;
  // T395: the row says when it last changed; the tooltip adds when it was made.
  const changedAt = lastChange(row);
  const path = pathUnder(row, rows, root);
  return (
    <li className="cr-ov-li" data-nested={nested ? 'true' : undefined}>
      {fold === null && <span className="cr-ov-branch-fold" aria-hidden="true" />}
      {fold !== undefined && fold !== null && (
        <button
          type="button"
          className="cr-ov-branch-fold"
          data-testid="overview-branch-toggle"
          aria-expanded={fold.open}
          aria-label={`${fold.open ? 'Fold' : 'Unfold'} ${row.title} (${fold.count} under it)`}
          title={fold.open ? 'Fold' : `Show the ${fold.count} under it`}
          onClick={fold.toggle}
        >
          <Icon name={fold.open ? 'chevron-down' : 'chevron-right'} size={13} />
        </button>
      )}
      <button
        type="button"
        className="cr-ov-row"
        data-testid="overview-node"
        data-stream={row.id}
        data-status={overviewStatus(row)}
        data-agent={agent !== undefined ? 'true' : undefined}
        onClick={() => select(row.id)}
        title={`${row.title} — ${status.hint}`}
      >
        <span className="cr-ov-status">
          <StatusPill row={row} status={status} />
        </span>
        <span className="cr-ov-path" data-testid="overview-node-path">
          {path.map((title, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ancestors are positional
            <span key={i} className="anc">
              {title} ›{' '}
            </span>
          ))}
          <span className="title">{row.title}</span>
          {summary !== undefined && (
            <span className="cr-ov-branch-sum" data-testid="overview-branch-summary">
              {summary}
            </span>
          )}
        </span>
        <span className="cr-ov-meta">
          <span className="cr-ov-repo">
            {row.repo !== undefined && (
              <>
                <RepoIcon remote={repo?.remote} size={13} />
                <span>{row.repo}</span>
              </>
            )}
          </span>
          <span className="cr-ov-agent" data-testid="overview-node-agent" title={agent?.title}>
            {agent !== undefined && (
              <>
                <Icon name="bot" size={13} />
                <span>{agent.text}</span>
              </>
            )}
          </span>
        </span>
        <time
          className="cr-ov-age"
          data-testid="overview-node-age"
          dateTime={changedAt}
          title={[
            changedAt !== undefined ? `Updated ${eventTime(changedAt)}` : undefined,
            bornAt !== undefined ? `created ${eventTime(bornAt)}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {changedAt !== undefined ? ago(changedAt) : ''}
        </time>
      </button>
    </li>
  );
}

/**
 * T447 (audit r7 #19): the list, one branch per top-level node under the
 * group its top-level node reads as. A branch folds (its chevron); one in
 * Finished starts folded, as Finished itself does, and in a project past
 * `OVERVIEW_FOLD_AT` nodes every branch does. A search unfolds all.
 */
function NodeList({
  nodes,
  rows,
  root,
  repos,
  filter,
  query,
}: {
  nodes: readonly CockpitStreamRow[];
  rows: readonly CockpitStreamRow[];
  root: string;
  repos: ReadonlyMap<string, CockpitRepoRow>;
  filter: OverviewStatus | undefined;
  query: string;
}): JSX.Element {
  const [doneOpen, setDoneOpen] = useState(false);
  // What was folded or unfolded by hand; the rest follows its group (Finished folds).
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const sections = useMemo(
    () => overviewSections(nodes, root, { ...(filter ? { only: filter } : {}), query }),
    [nodes, root, filter, query],
  );
  const searching = query.trim() !== '';
  // A big project's branches start folded: each head says what is under it.
  const big = nodes.length > OVERVIEW_FOLD_AT;
  if (sections.length === 0) {
    return (
      <p className="cr-ov-quiet" data-testid="overview-no-match">
        No node matches “{query.trim()}”.
      </p>
    );
  }
  const repoOf = (row: CockpitStreamRow) =>
    row.repo !== undefined ? repos.get(row.repo) : undefined;
  return (
    <div className="cr-ov-groups" data-testid="overview-nodes">
      {sections.map((section) => {
        // Finished folds, unless one of its counts was clicked or you are searching.
        const foldsHere = section.key === 'finished' && filter === undefined && !searching;
        const open = !foldsHere || doneOpen;
        return (
          <section
            key={section.key}
            className="cr-ov-group"
            data-group={section.key}
            data-testid="overview-group"
            aria-label={section.title}
          >
            {foldsHere ? (
              <button
                type="button"
                className="cr-ov-group-hd cr-ov-fold"
                data-testid="overview-done-toggle"
                aria-expanded={doneOpen}
                onClick={() => setDoneOpen((v) => !v)}
              >
                <Icon name={doneOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                {section.title}
                <span className="cr-ov-group-n">{section.count}</span>
              </button>
            ) : (
              <h3 className="cr-ov-group-hd">
                {section.title}
                <span className="cr-ov-group-n">{section.count}</span>
              </h3>
            )}
            {open && (
              <ul className="cr-ov-rows">
                {section.branches.map((branch) => {
                  const id = branch.row.id;
                  const has = branch.children.length > 0;
                  const unfolded =
                    searching || (folds.get(id) ?? (section.key !== 'finished' && !big));
                  return (
                    <li
                      key={id}
                      className="cr-ov-branch"
                      data-testid="overview-branch"
                      data-stream={id}
                      data-open={has ? String(unfolded) : undefined}
                    >
                      <ul className="cr-ov-branch-rows">
                        <NodeRow
                          row={branch.row}
                          rows={rows}
                          root={root}
                          repo={repoOf(branch.row)}
                          {...(branch.summary !== undefined ? { summary: branch.summary } : {})}
                          fold={
                            filter !== undefined
                              ? undefined
                              : has
                                ? {
                                    open: unfolded,
                                    count: branch.children.length,
                                    toggle: () => setFolds((m) => new Map(m).set(id, !unfolded)),
                                  }
                                : null
                          }
                        />
                        {has &&
                          unfolded &&
                          branch.children.map((row) => (
                            <NodeRow
                              key={row.id}
                              row={row}
                              rows={rows}
                              root={id}
                              repo={repoOf(row)}
                              nested
                            />
                          ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- repos

function RepoList({
  names,
  repos,
  nodes,
  onEdit,
}: {
  names: readonly string[];
  repos: ReadonlyMap<string, CockpitRepoRow>;
  nodes: readonly CockpitStreamRow[];
  onEdit: () => void;
}): JSX.Element {
  return (
    <section className="cr-ov-section" aria-labelledby="ov-repos" data-testid="overview-repos">
      <div className="cr-ov-section-hd">
        <h2 id="ov-repos" className="cr-ov-h">
          Repositories
        </h2>
        {names.length > 0 && (
          <button
            type="button"
            className="cr-ov-link"
            data-testid="overview-repos-edit"
            title="Choose the project’s repositories, in the details panel"
            onClick={onEdit}
          >
            Edit
          </button>
        )}
      </div>
      {names.length === 0 ? (
        <div className="cr-ov-quiet cr-ov-quiet-row">
          <span>No repositories yet. Its nodes can talk and research, but not change code.</span>
          <Button size="sm" icon="folder-git" data-testid="overview-repos-edit" onClick={onEdit}>
            Choose repositories
          </Button>
        </div>
      ) : (
        <ul className="cr-ov-repos">
          {names.map((name) => {
            const repo = repos.get(name);
            const open = openNodesOn(nodes, name);
            const delivery = repo?.delivery ?? 'direct';
            return (
              <li
                key={name}
                className="cr-ov-repo-row"
                data-testid="overview-repo"
                data-repo={name}
              >
                <span className="cr-ov-repo-icon">
                  <RepoIcon remote={repo?.remote} size={16} />
                </span>
                <span className="cr-ov-repo-id">
                  <span className="cr-ov-repo-name">{name}</span>
                  <span className="cr-ov-repo-kind">
                    {repo === undefined ? 'Not registered' : repoKindLabel(repo.remote)}
                    {' · '}
                    <span data-testid="overview-repo-delivery" title={deliveryHint(delivery)}>
                      {deliveryWords(delivery)}
                    </span>
                  </span>
                </span>
                <span className="cr-ov-repo-open" data-open={open > 0 ? 'true' : undefined}>
                  {open === 0 ? 'No open nodes' : `${open} open ${open === 1 ? 'node' : 'nodes'}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the page

export function ProjectOverview({
  project,
  root,
  waiting,
  onOpenChat,
  onEditRepos,
}: {
  /** The project's id (the root node's `project`). */
  project: string;
  /** The root node's id. */
  root: string;
  /** Decision cards on the root's own chat. */
  waiting: number;
  onOpenChat: () => void;
  onEditRepos: () => void;
}): JSX.Element {
  const { cockpit } = useFeed();
  const { openNewStream } = useShell();
  const [filter, setFilter] = useState<OverviewStatus | undefined>(undefined);
  // T447 (audit r7 #19): a filter box over the nodes' titles; `/` in the Overview focuses it.
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  const rows = cockpit?.streams ?? [];
  const nodes = useMemo(() => projectNodes(rows, root), [rows, root]);
  const ids = nodes.map((n) => n.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` is the set's identity.
  const nodeIds = useMemo(() => new Set([root, ...nodes.map((n) => n.id)]), [root, ids]);
  const repos = useMemo(
    () => new Map((cockpit?.repos ?? []).map((r) => [r.name, r])),
    [cockpit?.repos],
  );
  const titleOf = (id: string): string => rows.find((r) => r.id === id)?.title ?? 'a deleted node';

  if (cockpit === undefined) {
    return (
      <div className="cr-skel-stack" aria-busy="true">
        <div className="cr-skel" style={{ width: '40%' }} />
        <div className="cr-skel" />
        <div className="cr-skel" style={{ width: '70%' }} />
      </div>
    );
  }

  const counts = overviewCounts(nodes);
  // A filter whose nodes all moved on shows everything again.
  const shown =
    filter !== undefined && counts.some((c) => c.status === filter) ? filter : undefined;
  const projectRow = cockpit.projects.find((p) => p.id === project);
  const repoNames = projectRepoNames(projectRow?.repos, nodes);

  // The list sits right under the counts, so a count filters it in place.
  const pick = (status: OverviewStatus): void => setFilter(shown === status ? undefined : status);

  return (
    <div
      className="cr-ov"
      data-testid="project-overview"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!isShortcut(e.nativeEvent, '/') || search.current === null) return;
        // The Overview's own filter, not the rail's (the shell's `/`).
        e.preventDefault();
        e.stopPropagation();
        search.current.focus();
        search.current.select();
      }}
    >
      {waiting > 0 && (
        <div className="cr-ov-callout" role="note" data-testid="overview-root-waiting">
          <span className="cr-ov-callout-dot" aria-hidden="true" />
          <span className="cr-ov-callout-text">
            {waiting === 1
              ? 'Something in the project’s chat waits on you.'
              : `${waiting} things in the project’s chat wait on you.`}
          </span>
          <Button
            size="sm"
            icon="message-square"
            data-testid="overview-open-chat"
            onClick={onOpenChat}
          >
            Open chat
          </Button>
        </div>
      )}

      <section className="cr-ov-section" aria-labelledby="ov-nodes">
        <div className="cr-ov-section-hd">
          <h2 id="ov-nodes" className="cr-ov-h">
            Nodes
          </h2>
          {nodes.length > 0 && (
            <div className="cr-ov-nodes-tools">
              <label className="cr-ov-search">
                <Icon name="search" size={13} />
                <input
                  ref={search}
                  type="search"
                  data-testid="overview-filter"
                  placeholder="Filter nodes"
                  aria-label="Filter the nodes by title"
                  aria-keyshortcuts="/"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape' || query === '') return;
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery('');
                  }}
                />
                {query === '' && <Kbd>/</Kbd>}
              </label>
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                data-testid="overview-new-node"
                onClick={() => openNewStream({ project })}
              >
                New node
              </Button>
            </div>
          )}
        </div>
        {nodes.length === 0 ? (
          <EmptyState
            icon="layers"
            title="No nodes yet"
            testid="overview-empty"
            actions={
              <Button
                icon="plus"
                data-testid="overview-new-node"
                onClick={() => openNewStream({ project })}
              >
                New node
              </Button>
            }
          >
            A node is one piece of this project’s work: a conversation, or a change on one of its
            repositories. Its agent starts when you create it.
          </EmptyState>
        ) : (
          <>
            <div
              className="cr-ov-summary"
              // biome-ignore lint/a11y/useSemanticElements: a row of toggle chips; a fieldset's legend and box don't fit it.
              role="group"
              aria-label="Filter the nodes by status"
              data-testid="overview-summary"
            >
              {counts.map((c, i) => (
                <button
                  key={c.status}
                  type="button"
                  className="cr-ov-count"
                  data-testid="overview-count"
                  data-status={c.status}
                  data-group={c.group}
                  // A little more room where the list's next group starts.
                  data-group-start={i > 0 && counts[i - 1]?.group !== c.group ? 'true' : undefined}
                  aria-pressed={shown === c.status}
                  title={
                    shown === c.status
                      ? 'Show every node'
                      : c.count === 1
                        ? 'Show only this one'
                        : `Show only these ${c.count}`
                  }
                  onClick={() => pick(c.status)}
                >
                  {/* The dot its rows show: the same status, the same shape. */}
                  <span className="cr-ov-count-dot" aria-hidden="true">
                    {c.rows[0] !== undefined && <StatusDot row={c.rows[0]} />}
                  </span>
                  {c.text}
                </button>
              ))}
              {shown !== undefined && (
                <button
                  type="button"
                  className="cr-ov-link cr-ov-clear"
                  data-testid="overview-filter-clear"
                  onClick={() => setFilter(undefined)}
                >
                  <Icon name="x" size={12} />
                  Show all
                </button>
              )}
            </div>
            <NodeList
              nodes={nodes}
              rows={rows}
              root={root}
              repos={repos}
              filter={shown}
              query={query}
            />
          </>
        )}
      </section>

      <div className="cr-ov-pair">
        <RepoList names={repoNames} repos={repos} nodes={nodes} onEdit={onEditRepos} />
        <RecentActivity
          project={project}
          root={root}
          nodes={nodeIds}
          titleOf={titleOf}
          onOpenChat={onOpenChat}
        />
      </div>
    </div>
  );
}
