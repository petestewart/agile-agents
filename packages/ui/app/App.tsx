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
 */

import { useEffect, useState } from 'react';
import { DirectorPage } from './components/Director';
import { Icon } from './components/Icon';
import { Inbox } from './components/Inbox';
import { DependenciesLens, EventLog, RepoView, RunningLens } from './components/Lenses';
import { NewStream } from './components/NewStream';
import { Rules } from './components/Rules';
import { Settings } from './components/Settings';
import { MobileBar, Sidebar } from './components/Sidebar';
import { StreamPage } from './components/StreamPage';
import { useFeed } from './lib/feed-context';
import { type ShellView, useShell } from './lib/shell';

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
  const { view, selected, railOpen, toggleRail } = useShell();
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
      </main>
      <NewStream rows={rows} projects={projects} />
    </div>
  );
}
