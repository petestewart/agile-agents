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
 * T436 (audit r6 #21): `&tab=<tab>` a node's tab other than its first
 * (Changes, Plan…), so a reload, Back/Forward and a link keep it.
 */
export interface ShellLocation {
  view: ShellView;
  node: string | undefined;
  project: string | undefined;
  /** T436: the node's tab; absent is its first (a root's Overview, else the chat). */
  tab?: NodeTab;
}

/** T436: the tabs a `&tab=` may name (a node that lacks the one named opens on its first). */
export const NODE_TABS: readonly NodeTab[] = [
  'overview',
  'thread',
  'diff',
  'plan',
  'activity',
  'rules',
  'docs',
];

export function isNodeTab(value: string | null): value is NodeTab {
  return value !== null && (NODE_TABS as readonly string[]).includes(value);
}

/** Reads a `location.search`; anything unknown or missing is the inbox, "All" projects. */
export function parseShellUrl(search: string): ShellLocation {
  const params = new URLSearchParams(search);
  const node = params.get('node') || undefined;
  const project = params.get('project') || undefined;
  if (node !== undefined) {
    const tab = params.get('tab');
    return { view: 'stream', node, project, ...(isNodeTab(tab) ? { tab } : {}) };
  }
  // Knowledge is the `rules` view inside; its link says `knowledge` (`rules` still opens it).
  const raw = params.get('view');
  const view = raw === 'knowledge' ? 'rules' : raw;
  return { view: isShellView(view) ? view : 'inbox', node: undefined, project };
}

/** The query params the shell owns; any other belongs to the screen showing (Settings' `section`). */
const SHELL_PARAMS: ReadonlySet<string> = new Set(['node', 'view', 'project', 'tab']);

/**
 * T409: `next` (the shell's own query) plus the screen's params from
 * `current`, for a rewrite that stays on the same view and node (the project
 * filter moved, or the first sync after load). Moving to another view drops
 * them: they were that screen's.
 */
export function keepScreenParams(next: string, current: string): string {
  const params = new URLSearchParams(next);
  for (const [key, value] of new URLSearchParams(current)) {
    if (!SHELL_PARAMS.has(key) && !params.has(key)) params.append(key, value);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** The `location.search` for a shell location: `''` for the plain inbox. */
export function shellSearch({ view, node, project, tab }: ShellLocation): string {
  const params = new URLSearchParams();
  if (view === 'stream' && node !== undefined) {
    params.set('node', node);
    if (tab !== undefined) params.set('tab', tab);
  } else if (view !== 'inbox' && view !== 'stream')
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
  /**
   * T436 (audit r6 #21): the open node's tab, `undefined` for its first; in
   * the URL (`&tab=`). `select` sets it (T403: a Needs me card asks for the
   * chat), and so does the page's tab bar.
   */
  tab: NodeTab | undefined;
  setTab(tab: NodeTab | undefined): void;
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
   * T419 (D42): the Ask box, and what it asks about: a node's id, or
   * `'director'`; `undefined` when closed.
   */
  askAbout: string | undefined;
  /** Opens Ask about `target` (default: the open node, else the Director); `null` closes it. */
  openAsk(target?: string | null): void;
  /**
   * T208: the rail's project filter; `undefined` is "All". T365: only the
   * human sets it (a project's "Show only this project", the chip's ×, a
   * `&project=` link); nothing switches it on its own.
   */
  project: string | undefined;
  setProject(id: string | undefined): void;
  /**
   * T416 (finding 24): a `?node=` link to a node that isn't there any more
   * fell back to Needs me; this says so once (the shell renders no toast
   * itself — `App` does, then clears it). `archived` when it was deleted.
   */
  missingNode: MissingNode | undefined;
  clearMissingNode(): void;
}

/** T416: the node a stale link named: deleted (`archived`, with its title), or unknown. */
export interface MissingNode {
  id: string;
  archived: boolean;
  title?: string;
}

/** T365: New node's starting point from a row's `+` or a project's menu. */
export interface NewStreamPreset {
  parent?: string;
  project?: string;
  /** T427: a proposed node's words (an agent's `propose_next`), yours to edit. */
  title?: string;
  goal?: string;
}

const ShellContext = createContext<ShellValue | undefined>(undefined);

export function ShellProvider({
  initial = { view: 'inbox', node: undefined, project: undefined },
  children,
}: PropsWithChildren<{ initial?: ShellLocation }>): JSX.Element {
  const [view, setView] = useState<ShellView>(initial.view);
  const [selected, setSelected] = useState<string | undefined>(initial.node);
  const [tab, setTab] = useState<NodeTab | undefined>(initial.tab);
  const [railOpen, setRailOpen] = useState(false);
  const [newStreamOpen, setNewStreamOpen] = useState(false);
  const [newStreamPreset, setNewStreamPreset] = useState<NewStreamPreset | undefined>(undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [askAbout, setAskAbout] = useState<string | undefined>(undefined);
  const [project, setProject] = useState<string | undefined>(initial.project);
  const [rulesFilter, setRulesFilter] = useState<RulesFilter>(DEFAULT_RULES_FILTER);
  // T348: ids read from the URL (on load, or on back/forward) are checked
  // against the next cockpit frame; a stale one falls back to Needs me, and
  // (T416) `missingNode` says why. Ids set
  // by a click are never checked — a node just created may not be in the
  // frame yet.
  const [unchecked, setUnchecked] = useState(
    initial.node !== undefined || initial.project !== undefined,
  );
  // The fallback replaces the bad URL rather than stacking a history entry on it.
  const replaceNext = useRef(false);
  const cockpit = useOptionalFeed()?.cockpit;
  const [missingNode, setMissingNode] = useState<MissingNode | undefined>(undefined);

  useEffect(() => {
    if (!unchecked || !cockpit) return;
    setUnchecked(false);
    if (selected !== undefined && !cockpit.streams.some((row) => row.id === selected)) {
      replaceNext.current = true;
      // T416: not quietly — `App` says the node is gone (and offers it back when deleted).
      const archived = cockpit.archived?.find((row) => row.id === selected);
      setMissingNode({
        id: selected,
        archived: archived !== undefined,
        ...(archived !== undefined ? { title: archived.title } : {}),
      });
      setSelected(undefined);
      setTab(undefined);
      setView((current) => (current === 'stream' ? 'inbox' : current));
    }
    if (project !== undefined && !cockpit.projects.some((p) => p.id === project)) {
      replaceNext.current = true;
      setProject(undefined);
    }
  }, [unchecked, cockpit, selected, project]);

  // State → URL. Opening another node or view is a new history entry (so
  // back returns to it); the project filter or a node's tab alone only
  // rewrites the current one (so Back returns to the tab you left it on).
  useEffect(() => {
    const own = shellSearch({ view, node: selected, project, ...(tab ? { tab } : {}) });
    const current = parseShellUrl(location.search);
    const target = parseShellUrl(own);
    const moved = current.view !== target.view || current.node !== target.node;
    // T409: staying put keeps the screen's own params (a deep link's `section`).
    const next = moved ? own : keepScreenParams(own, location.search);
    if (next === location.search) return;
    const url = `${location.pathname}${next}${location.hash}`;
    if (moved && !replaceNext.current) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    replaceNext.current = false;
  }, [view, selected, project, tab]);

  // URL → state, on back/forward.
  useEffect(() => {
    const onPop = (): void => {
      const next = parseShellUrl(location.search);
      setView(next.view);
      setSelected(next.node);
      setTab(next.tab);
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
        if (next !== 'stream') {
          setSelected(undefined);
          setTab(undefined);
        }
        setRailOpen(false);
      },
      selected,
      tab,
      setTab,
      // T161: picking a stream opens its page (§9.3); "All streams" is the
      // inbox. On a phone the drawer gets out of the way either way.
      select: (id, options) => {
        setSelected(id);
        // Another node opens on its first tab (or the one asked for); the open one keeps its tab.
        setTab((current) =>
          id === undefined ? undefined : (options?.tab ?? (id === selected ? current : undefined)),
        );
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
        setTab(undefined);
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
      askAbout,
      openAsk: (target?: string | null) => {
        if (target === null) {
          setAskAbout(undefined);
          return;
        }
        setAskAbout(
          target ?? (view === 'stream' && selected !== undefined ? selected : 'director'),
        );
        setRailOpen(false);
      },
      project,
      setProject,
      missingNode,
      clearMissingNode: () => setMissingNode(undefined),
    }),
    [
      missingNode,
      view,
      selected,
      tab,
      railOpen,
      newStreamOpen,
      newStreamPreset,
      newProjectOpen,
      askAbout,
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
