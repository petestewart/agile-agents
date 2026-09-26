/**
 * T360 (design/cockpit-ui.md §3): the left sidebar replaces T160's top bar.
 * Top to bottom: the brand and the live dot, New node (`n`), the views
 * (Needs me with its count, Director, Knowledge, and the lenses), the
 * project tree (`StreamTree`), and Settings. Below 900px it is a drawer
 * opened from the `MobileBar`.
 *
 * The view buttons keep `data-view` (the e2e suites click them by it), and
 * the Needs me count keeps `data-testid="inbox-badge"`. T162's quick
 * capture is gone: New node is the one way to make a node.
 *
 * T365: below the tree, "Deleted (n)" (folded) restores what Delete
 * archived.
 */

import { useState } from 'react';
import type { CockpitProjectRow, CockpitStreamRow, FeedSnapshot } from '../lib/feed-types';
import { type ShellView, useShell } from '../lib/shell';
import { Icon, type IconName } from './Icon';
import { DeletedNodes, StreamTree } from './StreamTree';
import { Button, IconButton, Kbd } from './ui';

interface NavItem {
  view: ShellView;
  label: string;
  icon: IconName;
  hint?: string;
}

const PRIMARY: readonly NavItem[] = [
  {
    view: 'inbox',
    label: 'Needs me',
    icon: 'inbox',
    hint: 'Questions, decisions and merges waiting on you',
  },
  {
    view: 'director',
    label: 'Director',
    icon: 'sparkles',
    hint: 'An agent that sees across every project',
  },
  {
    view: 'rules',
    label: 'Knowledge',
    icon: 'book-open',
    hint: 'Rules, standards, architecture and decisions your agents follow',
  },
];

const VIEWS: readonly NavItem[] = [
  { view: 'running', label: 'Running', icon: 'zap', hint: 'Nodes with a live agent' },
  { view: 'repos', label: 'Repos', icon: 'folder-git', hint: 'Live work by repository' },
  { view: 'deps', label: 'Dependencies', icon: 'link', hint: 'Every "waits on" link' },
  {
    view: 'events',
    label: 'Events',
    icon: 'activity',
    hint: 'Everything that happened, newest first',
  },
];

const VIEWS_OPEN_KEY = 'agile.sidebar.views';

function loadViewsOpen(): boolean {
  try {
    return window.localStorage.getItem(VIEWS_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function NavButton({
  item,
  count,
}: {
  item: NavItem;
  count?: number;
}): JSX.Element {
  const { view, setView } = useShell();
  const on = view === item.view;
  return (
    <button
      type="button"
      className={`cr-sb-item${on ? ' on' : ''}`}
      data-view={item.view}
      aria-current={on ? 'page' : undefined}
      title={item.hint}
      onClick={() => setView(item.view)}
    >
      <Icon name={item.icon} size={16} />
      <span className="cr-sb-item-label">{item.label}</span>
      {count !== undefined && count > 0 && (
        <span className="badge" data-testid="inbox-badge">
          {count}
        </span>
      )}
    </button>
  );
}

export function Brand({ name }: { name: string }): JSX.Element {
  return (
    <div className="cr-brand" data-testid="topbar-project" title={name}>
      <span className="cr-brand-mark" aria-hidden="true">
        <Icon name="git-fork" size={14} strokeWidth={2.25} />
      </span>
      <span className="cr-brand-name">{name}</span>
    </div>
  );
}

export function Connection({ connected }: { connected: boolean }): JSX.Element {
  return (
    <span
      className="cr-conn"
      data-testid="conn"
      data-status={connected ? 'open' : 'closed'}
      title={connected ? 'Connected to the daemon' : 'Lost the daemon; reconnecting'}
    >
      <span className="cr-conn-dot" data-status={connected ? 'open' : 'closed'} />
      <span className="cr-conn-text">{connected ? 'live' : 'reconnecting…'}</span>
    </span>
  );
}

/** Phone width only: the bar that opens the sidebar drawer. */
export function MobileBar({ connected, name }: { connected: boolean; name: string }): JSX.Element {
  const { railOpen, toggleRail, setNewStreamOpen } = useShell();
  return (
    <div className="cr-mobilebar">
      <IconButton
        icon="menu"
        label="Open the sidebar"
        data-testid="rail-toggle"
        aria-expanded={railOpen}
        aria-controls="cr-rail"
        onClick={toggleRail}
      />
      <Brand name={name} />
      <Connection connected={connected} />
      <IconButton icon="plus" label="New node" onClick={() => setNewStreamOpen(true)} />
    </div>
  );
}

export function Sidebar({
  snapshot,
  inboxCount,
  connected,
  rows,
  projects,
}: {
  snapshot: FeedSnapshot | undefined;
  inboxCount: number;
  connected: boolean;
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const { setNewStreamOpen } = useShell();
  const [viewsOpen, setViewsOpen] = useState(loadViewsOpen);

  const toggleViews = (): void => {
    setViewsOpen((open) => {
      try {
        window.localStorage.setItem(VIEWS_OPEN_KEY, open ? 'closed' : 'open');
      } catch {
        // Storage blocked: the fold just won't survive a reload.
      }
      return !open;
    });
  };

  return (
    <aside className="cr-sidebar" id="cr-rail" data-testid="sidebar" aria-label="Sidebar">
      <div className="cr-sb-top">
        <Brand name={snapshot?.project?.name ?? 'agile'} />
        <Connection connected={connected} />
      </div>
      <div className="cr-sb-new">
        <Button
          icon="plus"
          data-testid="new-stream-open"
          title="New node (n)"
          onClick={() => setNewStreamOpen(true)}
        >
          New node
          <Kbd>N</Kbd>
        </Button>
      </div>
      <div className="cr-sb-scroll">
        <nav className="cr-sb-nav" aria-label="Views">
          <NavButton item={PRIMARY[0] as NavItem} count={inboxCount} />
          {PRIMARY.slice(1).map((item) => (
            <NavButton key={item.view} item={item} />
          ))}
          <div className="cr-sb-section">
            <button
              type="button"
              className="cr-sb-section-toggle"
              aria-expanded={viewsOpen}
              onClick={toggleViews}
            >
              Views
              <Icon name={viewsOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          </div>
          {viewsOpen && VIEWS.map((item) => <NavButton key={item.view} item={item} />)}
        </nav>
        <StreamTree rows={rows} projects={projects} />
        <DeletedNodes projects={projects} />
      </div>
      <div className="cr-sb-bottom">
        <nav aria-label="Settings">
          <NavButton item={{ view: 'settings', label: 'Settings', icon: 'settings' }} />
        </nav>
      </div>
    </aside>
  );
}
