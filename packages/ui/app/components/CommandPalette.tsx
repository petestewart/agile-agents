/**
 * T368 (design/cockpit-ui.md §1.7): the command palette. ⌘K / Ctrl K from
 * anywhere opens a search over nodes (title and path), projects, the views
 * and a few actions; ↑↓ move, Enter runs, Esc closes. With nothing typed it
 * lists the nodes you opened last. Matching and ranking are `lib/palette.ts`.
 *
 * It is not bound to `/`: that key filters the node tree (T162).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
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
} from '../lib/palette';
import { type ShellView, useShell } from '../lib/shell';
import { nodeStatus } from '../lib/status';
import { ancestorTitles } from '../lib/streams';
import { readTheme, saveTheme } from '../lib/theme';
import { Icon, type IconName } from './Icon';
import { openShortcuts } from './Shortcuts';
import { Dialog, Kbd, StatusDot } from './ui';

const openers = new Set<() => void>();

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
  const { select, selected, setView, setNewStreamOpen, setNewProjectOpen } = useShell();
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
    () => ({ select, setView, setNewStreamOpen, setNewProjectOpen }),
    [select, setView, setNewStreamOpen, setNewProjectOpen],
  );
  const close = useCallback(() => setOpen(false), []);
  // The node already open is where you are, not somewhere to go.
  const others = useMemo(() => recent.filter((id) => id !== selected), [recent, selected]);

  if (!open) return null;
  return (
    <PaletteDialog
      rows={rows}
      projects={projects}
      recent={others}
      onClose={close}
      actions={actions}
    />
  );
}

function PaletteDialog({
  rows,
  projects,
  recent,
  onClose,
  actions,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
  recent: readonly string[];
  onClose: () => void;
  actions: {
    select: (id: string) => void;
    setView: (view: ShellView) => void;
    setNewStreamOpen: (open: boolean) => void;
    setNewProjectOpen: (open: boolean) => void;
  };
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const mod = modKeyLabel(typeof navigator === 'undefined' ? '' : navigator.platform);

  const commands = useMemo(() => {
    const out: Command[] = [];
    for (const row of rows) {
      if (row.role === 'project') continue;
      out.push({
        entry: {
          key: `node:${row.id}`,
          group: 'nodes',
          title: row.title,
          subtitle: ancestorTitles(row, rows).join(' › '),
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
  }, [rows, projects, actions]);

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
