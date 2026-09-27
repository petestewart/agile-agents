/**
 * T368 (design/cockpit-ui.md §1.7): the command palette. ⌘K / Ctrl K from
 * anywhere opens a search over nodes (title and path), projects, the views
 * and a few actions; ↑↓ move, Enter runs, Esc closes. With nothing typed it
 * lists the nodes you opened last. Matching and ranking are `lib/palette.ts`.
 *
 * T416: on a node's page, "This node" lists what its header and ⋯ menu
 * offer (Merge, Start/Stop agent, Open Changes, Close, Copy branch name…),
 * handed over by the page itself (`useNodeCommands`), so the palette runs the
 * page's own handlers; "Needs me" lists what waits on you ("Answer: …"); and
 * with nothing typed the recent nodes fill up with the ones that changed last.
 *
 * It is not bound to `/`: that key filters the node tree (T162).
 */

import type { InboxItem } from '@agile-agents/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { itemCommand, nodePath, replyCommand } from '../lib/inbox';
import {
  type PaletteEntry,
  RECENT_MAX,
  flatResults,
  isPaletteKey,
  modKeyLabel,
  moveActive,
  paletteResults,
  parseRecent,
  pushRecent,
  recentNodes,
} from '../lib/palette';
import type { RulesFilter } from '../lib/rules';
import { type ShellView, useShell } from '../lib/shell';
import { nodeStatus } from '../lib/status';
import { ancestorTitles } from '../lib/streams';
import { readTheme, saveTheme } from '../lib/theme';
import { useDirectorUnread, useUnreadReplies } from '../lib/use-unread';
import { inboxIcon } from './DecisionCard';
import { Icon, type IconName } from './Icon';
import { openShortcuts } from './Shortcuts';
import { Dialog, Kbd, type MenuItem, StatusDot } from './ui';

const openers = new Set<() => void>();

/** T416: what the open node's page offers, as its header and ⋯ menu build it. */
export interface NodeCommands {
  node: string;
  title: string;
  items: ReadonlyArray<MenuItem>;
}

/** The node page that is open now hands its commands over through this (read when ⌘K opens). */
let nodeSource: (() => NodeCommands | undefined) | undefined;

/**
 * T416: a node's page registers what it can do; the palette reads it when it
 * opens. `source` returns the page's latest items (a ref it fills on each
 * render), so the palette runs the same handlers as the header and ⋯ menu.
 */
export function useNodeCommands(source: () => NodeCommands | undefined): void {
  useEffect(() => {
    nodeSource = source;
    return () => {
      if (nodeSource === source) nodeSource = undefined;
    };
  }, [source]);
}

/** The runnable items of a menu: no separators, nothing hidden or disabled, labels in words. */
function runnable(items: ReadonlyArray<MenuItem>): Array<Exclude<MenuItem, 'separator'>> {
  const seen = new Set<string>();
  return items.filter((item): item is Exclude<MenuItem, 'separator'> => {
    if (item === 'separator' || item.hidden || item.disabled) return false;
    if (typeof item.label !== 'string' || seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
}

/** Words a Needs me item answers to besides its title ("merge" finds a Ready to merge card). */
const NEEDS_WORDS: Record<InboxItem['kind'], string[]> = {
  question: ['question', 'answer', 'reply'],
  gate: ['allow', 'deny', 'approve', 'gate'],
  rule_accept: ['knowledge', 'accept', 'retire', 'rule'],
  rule_batch: ['knowledge', 'review', 'import'],
  plan_approve: ['plan', 'approve'],
  plan_waiting: ['plan', 'wake', 'coordinator'],
  proposal: ['proposal', 'apply', 'dismiss'],
  done: ['merge', 'ready', 'finished'],
  blocked: ['blocked', 'stuck', 'reply', 'unblock'],
};

/** "⌘K" on a Mac, "Ctrl K" elsewhere: for tooltips that name the shortcut. */
export function paletteKeyLabel(): string {
  const mod = modKeyLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  return mod === '⌘' ? '⌘K' : `${mod} K`;
}

/** Opens the palette from anywhere (the sidebar's search button). */
export function openCommandPalette(): void {
  for (const open of openers) open();
}

const RECENT_KEY = 'agile.palette.recent';

function loadRecent(): string[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function saveRecent(recent: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
  } catch {
    // Storage blocked: recent nodes last until the page reloads.
  }
}

const VIEWS: ReadonlyArray<{
  view: ShellView;
  title: string;
  icon: IconName;
  subtitle: string;
  keywords: string[];
  hint?: string;
}> = [
  {
    view: 'inbox',
    title: 'Needs me',
    icon: 'inbox',
    subtitle: 'Questions, decisions and merges waiting on you',
    keywords: ['inbox', 'questions', 'decisions'],
    hint: 'G I',
  },
  {
    view: 'director',
    title: 'Director',
    icon: 'sparkles',
    subtitle: 'The agent that sees across every project',
    keywords: ['chat'],
    hint: 'G D',
  },
  {
    view: 'rules',
    title: 'Knowledge',
    icon: 'book-open',
    subtitle: 'Rules, standards, architecture and decisions',
    keywords: ['rules', 'standards', 'architecture', 'decisions'],
    hint: 'G K',
  },
  {
    view: 'running',
    title: 'Running',
    icon: 'zap',
    subtitle: 'Nodes with a live agent',
    keywords: ['agents', 'live'],
    hint: 'G R',
  },
  {
    view: 'repos',
    title: 'Repos',
    icon: 'folder-git',
    subtitle: 'Live work by repository',
    keywords: ['repositories', 'overlaps', 'norms'],
  },
  {
    view: 'deps',
    title: 'Dependencies',
    icon: 'link',
    subtitle: 'Every "waits on" link',
    keywords: ['waits on', 'blocked'],
  },
  {
    view: 'events',
    title: 'Events',
    icon: 'activity',
    subtitle: 'Everything that happened, newest first',
    keywords: ['log', 'history', 'activity'],
    hint: 'G E',
  },
  {
    view: 'settings',
    title: 'Settings',
    icon: 'settings',
    subtitle: 'Repos, defaults, keys and trackers',
    keywords: ['preferences', 'config', 'api key'],
    hint: 'G S',
  },
];

/** What a row shows and does, beside the entry the matcher ranks. */
interface Command {
  entry: PaletteEntry;
  run: () => void;
  icon?: IconName;
  row?: CockpitStreamRow;
  hint?: string;
}

/** The theme the page shows now: the forced one, or the system's. */
function shownTheme(): 'light' | 'dark' {
  const forced = readTheme();
  if (forced !== 'system') return forced;
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function CommandPalette({
  rows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element | null {
  const {
    select,
    selected,
    setView,
    setNewStreamOpen,
    setNewProjectOpen,
    setAddRepoOpen,
    openRules,
    openAsk,
  } = useShell();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  useEffect(() => {
    const show = (): void => setOpen(true);
    openers.add(show);
    return () => {
      openers.delete(show);
    };
  }, []);

  // ⌘K / Ctrl K toggles it — but not over another open dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isPaletteKey(event)) return;
      if (!open && document.querySelector('.cr-modal')) return;
      event.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Every node opened (from anywhere) goes to the front of the recent list.
  useEffect(() => {
    if (selected === undefined) return;
    setRecent((list) => {
      if (list[0] === selected) return list;
      const next = pushRecent(list, selected);
      saveRecent(next);
      return next;
    });
  }, [selected]);

  const actions = useMemo(
    () => ({
      select,
      setView,
      setNewStreamOpen,
      setNewProjectOpen,
      setAddRepoOpen,
      openRules,
      openAsk,
    }),
    [select, setView, setNewStreamOpen, setNewProjectOpen, setAddRepoOpen, openRules, openAsk],
  );
  const close = useCallback(() => setOpen(false), []);
  // The node already open is where you are, not somewhere to go; the rest fills from what changed.
  const others = useMemo(() => recentNodes(recent, rows, selected), [recent, rows, selected]);

  if (!open) return null;
  // Read once, as it opens: the page open now and what it offers.
  const here = selected !== undefined ? nodeSource?.() : undefined;
  return (
    <PaletteDialog
      rows={rows}
      projects={projects}
      recent={others}
      onClose={close}
      actions={actions}
      {...(here !== undefined && here.node === selected ? { here } : {})}
    />
  );
}

function PaletteDialog({
  rows,
  projects,
  recent,
  onClose,
  actions,
  here,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
  recent: readonly string[];
  onClose: () => void;
  actions: {
    select: (id: string, options?: { tab?: 'thread' }) => void;
    setView: (view: ShellView) => void;
    setNewStreamOpen: (open: boolean) => void;
    setNewProjectOpen: (open: boolean) => void;
    /** T445 (audit r7 #10): Add repository… where you are. */
    setAddRepoOpen: (open: boolean) => void;
    openRules: (filter?: RulesFilter) => void;
    /** T425: Ask (T419), aimed at the open node, else the Director. */
    openAsk: () => void;
  };
  /** T416: the node open now, and what its page offers. */
  here?: NodeCommands;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const mod = modKeyLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  const inbox = useOptionalFeed()?.cockpit?.inbox;
  // T436 (audit r6 #29): the replies you haven't read are Needs me's too, first, as there.
  const replies = useUnreadReplies();
  const directorReplied = useDirectorUnread();

  const commands = useMemo(() => {
    const out: Command[] = [];
    // T416: "This node" — the page's own items, first when nothing is typed.
    for (const [i, item] of runnable(here?.items ?? []).entries()) {
      out.push({
        entry: {
          key: `this:${i}`,
          group: 'node',
          title: item.label as string,
          ...(item.title !== undefined ? { keywords: [item.title] } : {}),
        },
        ...(item.icon !== undefined ? { icon: item.icon } : {}),
        run: item.onSelect,
      });
    }
    // T436: "Read reply: …" opens the chat, where the reply is (reading it there marks it read).
    if (directorReplied !== undefined) {
      out.push({
        entry: {
          key: 'reply:director',
          group: 'needs',
          title: replyCommand('The Director'),
          keywords: ['reply', 'replied', 'unread', 'director'],
        },
        icon: 'sparkles',
        run: () => actions.setView('director'),
      });
    }
    for (const row of replies) {
      out.push({
        entry: {
          key: `reply:${row.id}`,
          group: 'needs',
          title: replyCommand(row.title),
          subtitle: nodePath(ancestorTitles(row, rows)),
          keywords: ['reply', 'replied', 'unread', 'answer'],
        },
        icon: 'message-square',
        run: () => actions.select(row.id, { tab: 'thread' }),
      });
    }
    // T416: what waits on you, as what you'd do: "Answer: …", "Merge: Add CSV import".
    for (const item of inbox ?? []) {
      const row = item.stream !== undefined ? rows.find((r) => r.id === item.stream) : undefined;
      out.push({
        entry: {
          key: `needs:${item.id}`,
          group: 'needs',
          title: itemCommand(item, row),
          ...(item.stream_path.length > 0 ? { subtitle: nodePath(item.stream_path) } : {}),
          keywords: NEEDS_WORDS[item.kind],
        },
        icon: inboxIcon(item),
        run: () => {
          if (item.stream !== undefined) actions.select(item.stream, { tab: 'thread' });
          else if (item.kind === 'rule_batch')
            actions.openRules({ status: 'proposed', scope: 'all', source: item.id });
          else if (item.kind === 'rule_accept')
            actions.openRules({ status: 'proposed', scope: 'all', rule: item.id });
          else actions.setView('inbox');
        },
      });
    }
    for (const row of rows) {
      if (row.role === 'project') continue;
      out.push({
        entry: {
          key: `node:${row.id}`,
          group: 'nodes',
          title: row.title,
          subtitle: nodePath(ancestorTitles(row, rows)),
        },
        row,
        run: () => actions.select(row.id),
      });
    }
    for (const project of projects) {
      out.push({
        entry: {
          key: `project:${project.id}`,
          group: 'projects',
          title: project.name,
          subtitle: 'Project',
        },
        icon: 'layers',
        run: () => actions.select(project.root),
      });
    }
    for (const view of VIEWS) {
      out.push({
        entry: {
          key: `view:${view.view}`,
          group: 'views',
          title: view.title,
          subtitle: view.subtitle,
          keywords: view.keywords,
        },
        icon: view.icon,
        ...(view.hint !== undefined ? { hint: view.hint } : {}),
        run: () => actions.setView(view.view),
      });
    }
    const theme = shownTheme();
    const next = theme === 'dark' ? 'light' : 'dark';
    out.push(
      {
        entry: {
          key: 'action:new-node',
          group: 'actions',
          title: 'New node',
          subtitle: 'A conversation, or work on a repo',
          keywords: ['create', 'add', 'stream'],
        },
        icon: 'plus',
        hint: 'N',
        run: () => actions.setNewStreamOpen(true),
      },
      {
        entry: {
          key: 'action:ask',
          group: 'actions',
          title: 'Ask a question…',
          subtitle: here ? 'About the open node, in its own thread' : 'The Director, or any node',
          keywords: ['question', 'conversation', 'director', 'talk'],
        },
        icon: 'message-square',
        hint: 'A',
        run: () => actions.openAsk(),
      },
      {
        entry: {
          key: 'action:new-project',
          group: 'actions',
          title: 'New project',
          keywords: ['create', 'add'],
        },
        icon: 'folder',
        run: () => actions.setNewProjectOpen(true),
      },
      {
        entry: {
          key: 'action:add-repo',
          group: 'actions',
          title: 'Add repository…',
          subtitle: 'A git repository on this machine, or one to clone',
          keywords: ['repo', 'clone', 'git', 'folder', 'create'],
        },
        icon: 'folder-git',
        run: () => actions.setAddRepoOpen(true),
      },
      {
        entry: {
          key: 'action:theme',
          group: 'actions',
          title: `Switch to ${next} theme`,
          keywords: ['toggle theme', 'dark mode', 'light mode', 'appearance'],
        },
        icon: next === 'dark' ? 'moon' : 'sun',
        run: () => saveTheme(next),
      },
    );
    if (readTheme() !== 'system') {
      out.push({
        entry: {
          key: 'action:theme-system',
          group: 'actions',
          title: 'Follow the system theme',
          keywords: ['theme', 'appearance', 'auto'],
        },
        icon: 'monitor',
        run: () => saveTheme('system'),
      });
    }
    out.push({
      entry: {
        key: 'action:shortcuts',
        group: 'actions',
        title: 'Keyboard shortcuts',
        keywords: ['keys', 'help', 'hotkeys'],
      },
      icon: 'help-circle',
      hint: '?',
      run: openShortcuts,
    });
    return out;
  }, [rows, projects, actions, here, inbox, replies, directorReplied]);

  const byKey = useMemo(() => new Map(commands.map((c) => [c.entry.key, c])), [commands]);
  const groups = useMemo(
    () =>
      paletteResults(
        query,
        commands.map((c) => c.entry),
        recent,
      ),
    [query, commands, recent],
  );
  const flat = flatResults(groups);
  const current = Math.min(active, Math.max(0, flat.length - 1));
  const optionId = (i: number): string => `${listId}-o${i}`;

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const run = useCallback(
    (entry: PaletteEntry | undefined) => {
      const command = entry ? byKey.get(entry.key) : undefined;
      if (!command) return;
      onClose();
      command.run();
    },
    [byKey, onClose],
  );

  let index = -1;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Command palette"
      size="lg"
      testid="command-palette"
      className="cr-palette"
    >
      <div className="cr-palette-search">
        <Icon name="search" size={16} />
        <input
          data-autofocus
          data-testid="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
          aria-label="Search nodes, views and actions"
          placeholder="Search nodes, views and actions…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(moveActive(current, e.key === 'ArrowDown' ? 1 : -1, flat.length));
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              run(flat[current]);
            }
          }}
        />
        <span className="cr-palette-esc">
          <Kbd>Esc</Kbd>
        </span>
      </div>
      <div
        className="cr-palette-list"
        id={listId}
        // biome-ignore lint/a11y/useSemanticElements: a combobox's popup listbox; focus stays in the input (aria-activedescendant), which a native <select> can't do.
        role="listbox"
        aria-label="Results"
        tabIndex={-1}
        ref={list}
      >
        {flat.length === 0 ? (
          <div className="cr-palette-empty" data-testid="palette-empty">
            Nothing matches “{query.trim()}”.
          </div>
        ) : (
          groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a listbox's option groups are role="group"; a <fieldset> is for form controls.
            <div key={group.id} role="group" aria-label={group.label} className="cr-palette-group">
              <div className="cr-palette-group-hd" aria-hidden="true">
                {group.label}
                {group.id === 'node' && here !== undefined ? (
                  <span className="cr-palette-group-sub"> · {here.title}</span>
                ) : null}
              </div>
              {group.items.map((entry) => {
                index += 1;
                const i = index;
                const command = byKey.get(entry.key);
                const row = command?.row;
                const status = row ? nodeStatus(row) : undefined;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keys (arrows, Enter); options take the mouse.
                  <div
                    key={entry.key}
                    id={optionId(i)}
                    // biome-ignore lint/a11y/useSemanticElements: an option of the listbox above; a native <option> can't hold the icon and the hint.
                    role="option"
                    aria-selected={i === current}
                    tabIndex={-1}
                    className="cr-palette-item"
                    data-testid="palette-item"
                    data-key={entry.key}
                    data-index={i}
                    onMouseMove={() => {
                      if (i !== current) setActive(i);
                    }}
                    onClick={() => run(entry)}
                  >
                    <span className="cr-palette-icon">
                      {row ? (
                        <StatusDot row={row} status={status} />
                      ) : (
                        <Icon name={command?.icon ?? 'arrow-right'} size={16} />
                      )}
                    </span>
                    <span className="cr-palette-text">
                      <span className="cr-palette-title">{entry.title}</span>
                      {entry.subtitle ? (
                        <span className="cr-palette-sub">{entry.subtitle}</span>
                      ) : null}
                    </span>
                    {status ? (
                      <span className="cr-palette-meta" data-tone={status.tone}>
                        {status.label}
                      </span>
                    ) : command?.hint ? (
                      <span className="cr-palette-keys">
                        {command.hint.split(' ').map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    ) : null}
                    <Icon name="corner-down-left" size={14} className="cr-palette-enter" />
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="cr-palette-ft" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>Esc</Kbd> close
        </span>
        <span className="cr-palette-ft-end">
          <Kbd>{mod}</Kbd>
          <Kbd>K</Kbd> anywhere
        </span>
      </div>
    </Dialog>
  );
}
