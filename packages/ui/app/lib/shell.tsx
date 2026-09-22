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

/** `stream` is the stream page (T161) — the stream is `selected`. */
export type ShellView = 'inbox' | 'settings' | 'stream';
/** The views a `?view=` deep link may name; `stream` needs an id, so it is not one. */
export const SHELL_VIEWS: readonly ShellView[] = ['inbox', 'settings'];

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
}

const ShellContext = createContext<ShellValue | undefined>(undefined);

export function ShellProvider({
  initialView = 'inbox',
  children,
}: PropsWithChildren<{ initialView?: ShellView }>): JSX.Element {
  const [view, setView] = useState<ShellView>(initialView);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [railOpen, setRailOpen] = useState(false);

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
    }),
    [view, selected, railOpen],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside a <ShellProvider>');
  return value;
}
