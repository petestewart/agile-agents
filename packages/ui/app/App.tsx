/**
 * The cockpit shell (design/cockpit-design.md §9, T160): the top bar, the
 * stream tree on the left rail, and the inbox as the default main view.
 * Everything live arrives on the one `/ws` (`FeedProvider`): the daemon
 * pushes a fresh inbox + tree after every batch of events, so a question
 * raised on any stream appears here with no reload.
 */

import { Inbox } from './components/Inbox';
import { Settings } from './components/Settings';
import { StreamTree } from './components/StreamTree';
import { TopBar } from './components/TopBar';
import { useFeed } from './lib/feed-context';
import { useShell } from './lib/shell';
import { subtreeIds } from './lib/streams';

export function App(): JSX.Element {
  const { snapshot, connected, cockpit, refresh } = useFeed();
  const { view, selected, railOpen } = useShell();
  const rows = cockpit?.streams ?? [];
  const allItems = cockpit?.inbox ?? [];
  const scope = selected !== undefined ? subtreeIds(rows, selected) : undefined;
  const items = scope
    ? allItems.filter((item) => item.stream !== undefined && scope.has(item.stream))
    : allItems;

  return (
    <div className="cr-root" data-rail={railOpen ? 'open' : 'closed'}>
      <TopBar snapshot={snapshot} inboxCount={allItems.length} connected={connected} />
      <div className="cr-frame">
        <StreamTree rows={rows} />
        <main className="cr-main">
          {view === 'settings' ? <Settings /> : <Inbox items={items} onChanged={refresh} />}
        </main>
      </div>
    </div>
  );
}
