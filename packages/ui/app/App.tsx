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

import { Suspense, useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary, PageLoading, lazyNamed } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { Inbox } from './components/Inbox';
import { NewStream } from './components/NewStream';
import { Shortcuts } from './components/Shortcuts';
import { MobileBar, Sidebar } from './components/Sidebar';
import { StreamPage } from './components/StreamPage';
import { useFeed } from './lib/feed-context';
import { type ShellView, useShell } from './lib/shell';
import { useNeedsMeNotifications } from './lib/use-notify';

// T394: loaded on demand; each `load*` is also called early to warm the chunk.
const loadSettings = () => import('./components/Settings');
const loadRules = () => import('./components/Rules');
const loadLenses = () => import('./components/Lenses');
const loadDirector = () => import('./components/Director');
const loadNewProject = () => import('./components/NewProject');
const Settings = lazyNamed(loadSettings, 'Settings');
const Rules = lazyNamed(loadRules, 'Rules');
const RepoView = lazyNamed(loadLenses, 'RepoView');
const RunningLens = lazyNamed(loadLenses, 'RunningLens');
const DependenciesLens = lazyNamed(loadLenses, 'DependenciesLens');
const EventLog = lazyNamed(loadLenses, 'EventLog');
const DirectorPage = lazyNamed(loadDirector, 'DirectorPage');
const NewProject = lazyNamed(loadNewProject, 'NewProject');

/**
 * Every chunk the first screen doesn't need, fetched once the page is idle
 * so a later click opens at once (and an open page keeps working after a
 * rebuild replaces the files). The node page's Changes and Overview tabs
 * load on demand too (`StreamPage`).
 */
const WARM: ReadonlyArray<() => Promise<unknown>> = [
  loadSettings,
  loadRules,
  loadLenses,
  loadDirector,
  loadNewProject,
  () => import('./components/DiffView'),
  () => import('./components/ProjectOverview'),
];

function useWarmChunks(): void {
  useEffect(() => {
    // A failed warm-up is said, in words, when that view is opened.
    const warm = (): void => {
      for (const load of WARM) load().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, 2000);
    return () => clearTimeout(timer);
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

/** True once the socket has been down for a moment (not the first connect, not a blip). */
function useLostConnection(connected: boolean): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (connected) {
      setLost(false);
      return;
    }
    const timer = setTimeout(() => setLost(true), 2000);
    return () => clearTimeout(timer);
  }, [connected]);
  return lost;
}

export function App(): JSX.Element {
  const { snapshot, connected, cockpit, refresh } = useFeed();
  const { view, selected, railOpen, toggleRail, newProjectOpen, setNewProjectOpen } = useShell();
  const rows = cockpit?.streams ?? [];
  const items = cockpit?.inbox ?? [];
  const projects = cockpit?.projects ?? [];
  const repos = cockpit?.repos ?? [];
  const lost = useLostConnection(connected);

  const nodeTitle = selected !== undefined ? rows.find((r) => r.id === selected)?.title : undefined;
  const pageTitle = view === 'stream' && nodeTitle !== undefined ? nodeTitle : VIEW_TITLE[view];
  const waiting = items.length > 0 ? `(${items.length}) ` : '';
  useEffect(() => {
    document.title = `${waiting}${pageTitle} · agile`;
  }, [waiting, pageTitle]);
  // T388: a browser notification when something new needs you while you're away (opt-in, Settings).
  useNeedsMeNotifications();
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
        {lost && (
          <output className="cr-offline" data-testid="offline-banner">
            <Icon name="alert-circle" size={14} />
            Lost the daemon — reconnecting. Is <code>agiled</code> running?
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
