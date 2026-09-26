/**
 * The cockpit chrome's own state (T043's shell, cut down to the cockpit in
 * T160): which view the main column shows, which stream's page is open
 * (T161), and — at phone width — whether the stream-tree drawer is open.
 *
 * It lives in a context rather than in `App`'s props because the top bar
 * (the view switch and the drawer toggle) and the stream tree (the
 * selection) are siblings, and the inbox cards open a stream too.
 */

import {
  type PropsWithChildren,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { NodeTab } from './chat';
import { useOptionalFeed } from './feed-context';
import { DEFAULT_RULES_FILTER, type RulesFilter } from './rules';

/** `stream` is the stream page (T161) — the stream is `selected`. `rules` is T163's rules screen. */
export type ShellView =
  | 'inbox'
  | 'repos'
  | 'running'
  | 'deps'
  | 'rules'
  | 'director'
  | 'events'
  | 'settings'
  | 'stream';
/** The views a `?view=` deep link may name; `stream` needs an id, so it is not one. */
export const SHELL_VIEWS: readonly ShellView[] = [
  'inbox',
  'repos',
  'running',
  'deps',
  'rules',
  'director',
  'events',
  'settings',
];

export function isShellView(value: string | null): value is ShellView {
  return value !== null && (SHELL_VIEWS as readonly string[]).includes(value);
}

/**
 * T348 (D36 D2): the part of the shell a URL carries, so a reload or a
 * shared link reopens the same view. `?node=<id>` is a node's page,
 * `?view=<view>` any other view, `&project=<id>` the rail's project filter.
 */
export interface ShellLocation {
  view: ShellView;
  node: string | undefined;
  project: string | undefined;
}

/** Reads a `location.search`; anything unknown or missing is the inbox, "All" projects. */
export function parseShellUrl(search: string): ShellLocation {
  const params = new URLSearchParams(search);
  const node = params.get('node') || undefined;
  const project = params.get('project') || undefined;
  if (node !== undefined) return { view: 'stream', node, project };
  // Knowledge is the `rules` view inside; its link says `knowledge` (`rules` still opens it).
  const raw = params.get('view');
  const view = raw === 'knowledge' ? 'rules' : raw;
  return { view: isShellView(view) ? view : 'inbox', node: undefined, project };
}

/** The `location.search` for a shell location: `''` for the plain inbox. */
export function shellSearch({ view, node, project }: ShellLocation): string {
  const params = new URLSearchParams();
  if (view === 'stream' && node !== undefined) params.set('node', node);
  else if (view !== 'inbox' && view !== 'stream')
    params.set('view', view === 'rules' ? 'knowledge' : view);
  if (project !== undefined) params.set('project', project);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export interface ShellValue {
  view: ShellView;
  setView(view: ShellView): void;
  /** The stream whose page is open (T161), or `undefined`. */
  selected: string | undefined;
  /**
   * Opens a stream's page; `undefined` goes back to the whole inbox. T403:
   * `tab` opens it on that tab instead of its first (a Needs me card opens a
   * project root on its chat, where the card is, not its Overview).
   */
  select(id: string | undefined, options?: { tab?: NodeTab }): void;
  /** T403: the tab the last `select` asked for, with its node; read when the page opens. */
  openOn: { id: string; tab: NodeTab } | undefined;
  /** Phone width only: the stream tree is a drawer. Ignored on a wide screen, where the rail is always shown. */
  railOpen: boolean;
  toggleRail(): void;
  /** T163: what the rules screen shows. Kept here so the inbox's seed card can open it filtered. */
  rulesFilter: RulesFilter;
  setRulesFilter(filter: RulesFilter): void;
  /** T163: the rules screen, with `filter` (the default when absent). */
  openRules(filter?: RulesFilter): void;
  /** T162: the "New stream" dialog — opened by the top bar's button or `n`. */
  newStreamOpen: boolean;
  setNewStreamOpen(open: boolean): void;
  /** T365: where New node starts when a row's `+` opened it (a parent, or a project's top level). */
  newStreamPreset: NewStreamPreset | undefined;
  /** T365: opens New node, under `preset` when given (a row's `+`, a project's menu). */
  openNewStream(preset?: NewStreamPreset): void;
  /** T360: the "New project" dialog — from the sidebar, or Needs me's first-run steps. */
  newProjectOpen: boolean;
  setNewProjectOpen(open: boolean): void;
  /**
   * T208: the rail's project filter; `undefined` is "All". T365: only the
   * human sets it (a project's "Show only this project", the chip's ×, a
   * `&project=` link); nothing switches it on its own.
   */
  project: string | undefined;
  setProject(id: string | undefined): void;
}

/** T365: New node's starting point from a row's `+` or a project's menu. */
export interface NewStreamPreset {
  parent?: string;
  project?: string;
}

const ShellContext = createContext<ShellValue | undefined>(undefined);

export function ShellProvider({
  initial = { view: 'inbox', node: undefined, project: undefined },
  children,
}: PropsWithChildren<{ initial?: ShellLocation }>): JSX.Element {
  const [view, setView] = useState<ShellView>(initial.view);
  const [selected, setSelected] = useState<string | undefined>(initial.node);
  const [openOn, setOpenOn] = useState<ShellValue['openOn']>(undefined);
  const [railOpen, setRailOpen] = useState(false);
  const [newStreamOpen, setNewStreamOpen] = useState(false);
  const [newStreamPreset, setNewStreamPreset] = useState<NewStreamPreset | undefined>(undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [project, setProject] = useState<string | undefined>(initial.project);
  const [rulesFilter, setRulesFilter] = useState<RulesFilter>(DEFAULT_RULES_FILTER);
  // T348: ids read from the URL (on load, or on back/forward) are checked
  // against the next cockpit frame; a stale one falls back quietly. Ids set
  // by a click are never checked — a node just created may not be in the
  // frame yet.
  const [unchecked, setUnchecked] = useState(
    initial.node !== undefined || initial.project !== undefined,
  );
  // The fallback replaces the bad URL rather than stacking a history entry on it.
  const replaceNext = useRef(false);
  const cockpit = useOptionalFeed()?.cockpit;

  useEffect(() => {
    if (!unchecked || !cockpit) return;
    setUnchecked(false);
    if (selected !== undefined && !cockpit.streams.some((row) => row.id === selected)) {
      replaceNext.current = true;
      setSelected(undefined);
      setView((current) => (current === 'stream' ? 'inbox' : current));
    }
    if (project !== undefined && !cockpit.projects.some((p) => p.id === project)) {
      replaceNext.current = true;
      setProject(undefined);
    }
  }, [unchecked, cockpit, selected, project]);

  // State → URL. Opening another node or view is a new history entry (so
  // back returns to it); the project filter alone only rewrites the current one.
  useEffect(() => {
    const next = shellSearch({ view, node: selected, project });
    if (next === location.search) return;
    const current = parseShellUrl(location.search);
    const target = parseShellUrl(next);
    const moved = current.view !== target.view || current.node !== target.node;
    const url = `${location.pathname}${next}${location.hash}`;
    if (moved && !replaceNext.current) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    replaceNext.current = false;
  }, [view, selected, project]);

  // URL → state, on back/forward.
  useEffect(() => {
    const onPop = (): void => {
      const next = parseShellUrl(location.search);
      setView(next.view);
      setSelected(next.node);
      setProject(next.project);
      setUnchecked(next.node !== undefined || next.project !== undefined);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const value = useMemo<ShellValue>(
    () => ({
      view,
      // T360: a view from the sidebar closes the phone drawer; any view but a
      // node's page leaves no node open (so New node doesn't default to it).
      setView: (next: ShellView) => {
        setView(next);
        if (next !== 'stream') setSelected(undefined);
        setRailOpen(false);
      },
      selected,
      openOn,
      // T161: picking a stream opens its page (§9.3); "All streams" is the
      // inbox. On a phone the drawer gets out of the way either way.
      select: (id, options) => {
        setSelected(id);
        setOpenOn(id !== undefined && options?.tab ? { id, tab: options.tab } : undefined);
        setView(id === undefined ? 'inbox' : 'stream');
        setRailOpen(false);
      },
      railOpen,
      toggleRail: () => setRailOpen((open) => !open),
      rulesFilter,
      setRulesFilter,
      openRules: (filter = DEFAULT_RULES_FILTER) => {
        setRulesFilter(filter);
        setView('rules');
        setSelected(undefined);
      },
      newStreamOpen,
      setNewStreamOpen: (open: boolean) => {
        setNewStreamPreset(undefined);
        setNewStreamOpen(open);
        // The dialog, not the phone drawer behind it.
        if (open) setRailOpen(false);
      },
      newStreamPreset,
      openNewStream: (preset?: NewStreamPreset) => {
        setNewStreamPreset(preset);
        setNewStreamOpen(true);
        setRailOpen(false);
      },
      newProjectOpen,
      setNewProjectOpen,
      project,
      setProject,
    }),
    [
      view,
      selected,
      openOn,
      railOpen,
      newStreamOpen,
      newStreamPreset,
      newProjectOpen,
      rulesFilter,
      project,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside a <ShellProvider>');
  return value;
}

/** T338: the shell, or `undefined` outside a provider (text rendered on its own). */
export function useOptionalShell(): ShellValue | undefined {
  return useContext(ShellContext);
}

/**
 * T162: the cockpit's single-key shortcuts (`n`, `/`) never fire while the
 * operator is typing — in an input, a textarea, a select or anything
 * contenteditable — nor with a modifier held.
 */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
  if (event.key !== key || event.metaKey || event.ctrlKey || event.altKey) return false;
  // T373: an open dialog owns the keyboard, wherever its focus is.
  if (typeof document !== 'undefined' && document.querySelector?.('[aria-modal="true"]')) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.tagName !== 'string') return true;
  const tag = target.tagName.toLowerCase();
  return !(tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable);
}
