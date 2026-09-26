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
import { useUnreadReplies } from '../lib/use-unread';
import { openCommandPalette, paletteKeyLabel } from './CommandPalette';
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
  replies = 0,
}: {
  item: NavItem;
  count?: number;
  /** T429: replies not read yet: a dot beside the count. */
  replies?: number;
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
      {replies > 0 && (
        <span
          className="cr-sb-replies"
          data-testid="replies-dot"
          title={`${replies} ${replies === 1 ? 'reply' : 'replies'} to read`}
          role="img"
          aria-label={`${replies} ${replies === 1 ? 'reply' : 'replies'} to read`}
        />
      )}
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
      {/* T368: no ⌘K on a phone: the palette is one tap away. */}
      <IconButton icon="search" label="Search" onClick={openCommandPalette} />
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
  const replies = useUnreadReplies();
  const [viewsOpen, setViewsOpen] = useState(loadViewsOpen);
  // A line under the pinned block once the list has scrolled under it.
  const [scrolled, setScrolled] = useState(false);

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
        {/* T368: the command palette (⌘K / Ctrl K). */}
        <IconButton
          icon="search"
          size="sm"
          label={`Search (${paletteKeyLabel()})`}
          data-testid="palette-open"
          onClick={openCommandPalette}
        />
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
      {/* Audit r5 #4: Needs me and its count stay in sight however far the tree scrolls. */}
      <nav className="cr-sb-nav cr-sb-primary" aria-label="Main">
        <NavButton item={PRIMARY[0] as NavItem} count={inboxCount} replies={replies.length} />
        {PRIMARY.slice(1).map((item) => (
          <NavButton key={item.view} item={item} />
        ))}
      </nav>
      <div
        className="cr-sb-scroll"
        data-scrolled={scrolled ? 'true' : undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <nav className="cr-sb-nav" aria-label="Views">
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
