/**
 * The cockpit chrome's own state (T043's shell, cut down to the cockpit in
 * T160): which view the main column shows, which stream's page is open
 * (T161), and — at phone width — whether the stream-tree drawer is open.
 *
 * It lives in a context rather than in `App`'s props because the top bar
 * (the view switch and the drawer toggle) and the stream tree (the
 * selection) are siblings, and the inbox cards open a stream too.
 */

import { type PropsWithChildren, createContext, useContext, useMemo, useState } from 'react';
import { DEFAULT_RULES_FILTER, type RulesFilter } from './rules';

/** `stream` is the stream page (T161) — the stream is `selected`. `rules` is T163's rules screen. */
export type ShellView =
  | 'inbox'
  | 'repos'
  | 'running'
  | 'deps'
  | 'rules'
  | 'director'
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
  'settings',
];

export function isShellView(value: string | null): value is ShellView {
  return value !== null && (SHELL_VIEWS as readonly string[]).includes(value);
}

export interface ShellValue {
  view: ShellView;
  setView(view: ShellView): void;
  /** The stream whose page is open (T161), or `undefined`. */
  selected: string | undefined;
  /** Opens a stream's page; `undefined` goes back to the whole inbox. */
  select(id: string | undefined): void;
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
  /** T208: the rail's project switcher; `undefined` is "All". New nodes file into it. */
  project: string | undefined;
  setProject(id: string | undefined): void;
}

const ShellContext = createContext<ShellValue | undefined>(undefined);

export function ShellProvider({
  initialView = 'inbox',
  children,
}: PropsWithChildren<{ initialView?: ShellView }>): JSX.Element {
  const [view, setView] = useState<ShellView>(initialView);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [railOpen, setRailOpen] = useState(false);
  const [newStreamOpen, setNewStreamOpen] = useState(false);
  const [project, setProject] = useState<string | undefined>(undefined);
  const [rulesFilter, setRulesFilter] = useState<RulesFilter>(DEFAULT_RULES_FILTER);

  const value = useMemo<ShellValue>(
    () => ({
      view,
      setView,
      selected,
      // T161: picking a stream opens its page (§9.3); "All streams" is the
      // inbox. On a phone the drawer gets out of the way either way.
      select: (id) => {
        setSelected(id);
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
      },
      newStreamOpen,
      setNewStreamOpen,
      project,
      setProject,
    }),
    [view, selected, railOpen, newStreamOpen, rulesFilter, project],
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
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.tagName !== 'string') return true;
  const tag = target.tagName.toLowerCase();
  return !(tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable);
}
