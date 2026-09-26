/**
 * The cockpit shell (design/cockpit-design.md §9, T160): the top bar, the
 * stream tree on the left rail, and the inbox as the default main view.
 * Everything live arrives on the one `/ws` (`FeedProvider`): the daemon
 * pushes a fresh inbox + tree after every batch of events, so a question
 * raised on any stream appears here with no reload.
 *
 * T161: a stream picked in the tree (or opened from an inbox card) shows
 * its stream page (§9.3) in the main column. T163: the rules screen.
 * T360: the top bar is gone; the sidebar (views, projects, Settings) is the
 * one navigation, a drawer below 900px (design/cockpit-ui.md §3).
 *
 * T394: the views not on the first screen (Knowledge, Settings, the lenses,
 * the Director, New project) load on demand, and are warmed once the first
 * screen is idle. The main view and each overlay sit in an error boundary:
 * a throw shows a card in words while the sidebar stays usable, and
 * navigating resets it.
 */

import { Suspense, useEffect } from 'react';
import { Ask } from './components/Ask';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary, PageLoading, lazyNamed } from './components/ErrorBoundary';
import { Inbox } from './components/Inbox';
import { NewStream } from './components/NewStream';
import { Shortcuts } from './components/Shortcuts';
import { MobileBar, Sidebar } from './components/Sidebar';
import { StreamPage } from './components/StreamPage';
import { Spinner, useToast } from './components/ui';
import { unarchiveStream } from './lib/api';
import { useFeed } from './lib/feed-context';
import { type ShellView, useShell } from './lib/shell';
import { useNeedsMeNotifications } from './lib/use-notify';
import { useReadOpenNode, useReplyNotifications } from './lib/use-unread';

// T394: loaded on demand (`preload()` fetches one ahead: the warm-up, a deep link).
const loadLenses = () => import('./components/Lenses');
const Settings = lazyNamed(() => import('./components/Settings'), 'Settings');
const Rules = lazyNamed(() => import('./components/Rules'), 'Rules');
const RepoView = lazyNamed(loadLenses, 'RepoView');
const RunningLens = lazyNamed(loadLenses, 'RunningLens');
const DependenciesLens = lazyNamed(loadLenses, 'DependenciesLens');
const EventLog = lazyNamed(loadLenses, 'EventLog');
const DirectorPage = lazyNamed(() => import('./components/Director'), 'DirectorPage');
const NewProject = lazyNamed(() => import('./components/NewProject'), 'NewProject');

const LAZY_VIEWS: Partial<Record<ShellView, { preload(): Promise<unknown> }>> = {
  settings: Settings,
  rules: Rules,
  repos: RepoView,
  running: RunningLens,
  deps: DependenciesLens,
  events: EventLog,
  director: DirectorPage,
};

/**
 * T394: fetches a view's code when it loads on demand (nothing to do for
 * Needs me or a node). `main.tsx` waits for it on a deep link, so the view
 * is there in the first frame and reads its own part of the URL (Settings'
 * `section`) before the shell rewrites the query.
 */
export function preloadView(view: ShellView): Promise<unknown> {
  return LAZY_VIEWS[view]?.preload() ?? Promise.resolve();
}

/**
 * Every chunk the first screen doesn't need, fetched once the page is idle
 * so a later click opens at once (and an open page keeps working after a
 * rebuild replaces the files). The node page's Changes and Overview tabs
 * load on demand too (`StreamPage`); this only fetches their code.
 */
const WARM: ReadonlyArray<() => Promise<unknown>> = [
  ...Object.values(LAZY_VIEWS).map((view) => () => view.preload()),
  () => NewProject.preload(),
  () => import('./components/DiffView'),
  () => import('./components/AddRepo'),
  () => import('./components/ProjectOverview'),
];

/** How long after the first screen the warm-up waits, so it never competes with that screen's own reads. */
const WARM_AFTER_MS = 1500;

function useWarmChunks(): void {
  useEffect(() => {
    // A failed warm-up is said, in words, when that view is opened.
    const warm = (): void => {
      for (const load of WARM) load().catch(() => {});
    };
    let idle: number | undefined;
    const timer = setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(warm, { timeout: 5000 });
      } else warm();
    }, WARM_AFTER_MS);
    return () => {
      clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, []);
}

/** T360: the browser tab says where you are and how much waits on you. */
const VIEW_TITLE: Record<ShellView, string> = {
  inbox: 'Needs me',
  repos: 'Repos',
  running: 'Running',
  deps: 'Dependencies',
  rules: 'Knowledge',
  director: 'Director',
  events: 'Events',
  settings: 'Settings',
  stream: 'Node',
};

/**
 * T416 (finding 24): a `?node=` link to a node that is gone lands on Needs
 * me and says so — deleted (with Restore, since that's what you'd want
 * next) or never there (a wrong link).
 */
function useMissingNodeToast(): void {
  const { missingNode, clearMissingNode, select } = useShell();
  const toast = useToast();
  useEffect(() => {
    if (missingNode === undefined) return;
    clearMissingNode();
    const { id, archived, title } = missingNode;
    if (!archived) {
      toast({
        title: 'That node no longer exists',
        body: 'It was deleted, or the link is wrong.',
        tone: 'info',
        duration: 8000,
      });
      return;
    }
    toast({
      title: title !== undefined ? `“${title}” was deleted` : 'That node was deleted',
      body: 'It’s under Deleted at the foot of the sidebar. Restore brings it back.',
      tone: 'info',
      duration: 10000,
      action: {
        label: 'Restore',
        onClick: () => {
          unarchiveStream(id)
            .then(() => select(id))
            .catch((err: unknown) =>
              toast({
                title: 'Could not restore it',
                body: err instanceof Error ? err.message : String(err),
                tone: 'error',
              }),
            );
        },
      },
    });
  }, [missingNode, clearMissingNode, select, toast]);
}

export function App(): JSX.Element {
  const { snapshot, connected, offline, cockpit, refresh } = useFeed();
  const { view, selected, railOpen, toggleRail, newProjectOpen, setNewProjectOpen } = useShell();
  const rows = cockpit?.streams ?? [];
  const items = cockpit?.inbox ?? [];
  const projects = cockpit?.projects ?? [];
  const repos = cockpit?.repos ?? [];
  useMissingNodeToast();

  const nodeTitle = selected !== undefined ? rows.find((r) => r.id === selected)?.title : undefined;
  const pageTitle = view === 'stream' && nodeTitle !== undefined ? nodeTitle : VIEW_TITLE[view];
  const waiting = items.length > 0 ? `(${items.length}) ` : '';
  useEffect(() => {
    document.title = `${waiting}${pageTitle} · agile`;
  }, [waiting, pageTitle]);
  // T388: a browser notification when something new needs you while you're away (opt-in, Settings).
  useNeedsMeNotifications();
  // T429: the open node is read as it changes; a reply while you're away notifies.
  useReadOpenNode();
  useReplyNotifications();
  useWarmChunks();
  // T394: a caught error resets when you go somewhere else.
  const place = `${view}:${selected ?? ''}`;

  return (
    <div className="cr-root" data-rail={railOpen ? 'open' : 'closed'}>
      <Sidebar
        snapshot={snapshot}
        inboxCount={items.length}
        connected={connected}
        rows={rows}
        projects={projects}
      />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the drawer closes with its own toggle and Escape too. */}
      <div className="cr-scrim" onClick={toggleRail} />
      <main className="cr-main">
        <MobileBar connected={connected} name={snapshot?.project?.name ?? 'agile'} />
        {/* T416 (finding 7): in the column's flow, above the page — never over its controls. */}
        {offline && (
          <output className="cr-offline" data-testid="offline-banner">
            <Spinner size={13} />
            <span>
              <strong>Reconnecting to the daemon…</strong> Nothing you do is sent until it’s back.
              Is <code>agiled</code> running?
            </span>
          </output>
        )}
        <ErrorBoundary area="page" resetKey={place}>
          <Suspense fallback={<PageLoading />}>
            {view === 'settings' ? (
              <Settings />
            ) : view === 'repos' ? (
              <RepoView rows={rows} repos={repos} overlaps={cockpit?.overlaps ?? []} />
            ) : view === 'running' ? (
              <RunningLens rows={rows} />
            ) : view === 'deps' ? (
              <DependenciesLens rows={rows} />
            ) : view === 'rules' ? (
              <Rules />
            ) : view === 'director' ? (
              <DirectorPage />
            ) : view === 'events' ? (
              <EventLog />
            ) : view === 'stream' && selected !== undefined ? (
              <StreamPage id={selected} />
            ) : (
              <Inbox items={items} onChanged={refresh} />
            )}
          </Suspense>
        </ErrorBoundary>
      </main>
      <ErrorBoundary area="overlay" resetKey={place}>
        <NewStream rows={rows} projects={projects} />
      </ErrorBoundary>
      <ErrorBoundary area="overlay" resetKey={place}>
        <Ask rows={rows} projects={projects} />
      </ErrorBoundary>
      <ErrorBoundary area="overlay" resetKey={place}>
        <CommandPalette rows={rows} projects={projects} />
      </ErrorBoundary>
      <ErrorBoundary area="overlay" resetKey={place}>
        <Shortcuts />
      </ErrorBoundary>
      {newProjectOpen && (
        <ErrorBoundary area="overlay" resetKey={place}>
          <Suspense fallback={null}>
            <NewProject onClose={() => setNewProjectOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}
