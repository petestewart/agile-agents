/**
 * T043: the chrome's own state — which view is showing, whether the Plan
 * screen's left rail is collapsed, whether the middle pane is open, and what
 * mode the EM chat is in (§17 "Control room v2": "A thin tool row under the
 * top bar holds the rail collapse on the left and, after a divider, chat
 * show/hide, pop-out, and maximize on the right", "Any pane can be closed
 * (X) and the chat widens; the rail collapses to icons").
 *
 * It lives in a context rather than in `App`'s props because the Plan screen
 * (T042) consumes `rail` and owns the pane-close (X) that widens the chat,
 * and neither is a child of the tool row that toggles them.
 */

import {
  type PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type ShellView = 'plan' | 'sprint' | 'settings';
export const SHELL_VIEWS: readonly ShellView[] = ['plan', 'sprint', 'settings'];

export function isShellView(value: string | null): value is ShellView {
  return value !== null && (SHELL_VIEWS as readonly string[]).includes(value);
}

/**
 * Chat modes, as one value rather than two booleans, because the mockup's
 * own script treats them as exclusive: maximizing clears "hidden" and
 * showing the chat clears "maximized".
 *  - `panel`  — the 26% side column (default)
 *  - `hidden` — chat off; the middle pane takes the whole frame
 *  - `max`    — chat only; the middle pane is hidden
 */
export type ChatMode = 'panel' | 'hidden' | 'max';

export interface ShellValue {
  view: ShellView;
  setView(view: ShellView): void;
  /** Plan-screen left rail. `true` = collapsed to icons. Persisted per browser. */
  railCollapsed: boolean;
  setRailCollapsed(collapsed: boolean): void;
  toggleRail(): void;
  chatMode: ChatMode;
  setChatMode(mode: ChatMode): void;
  /**
   * The middle pane (the Plan screen's document pane). Closing it widens the
   * chat; re-opening it — which is what selecting a rail entry does — pulls
   * the chat back out of `max`. T042's rail calls `setMiddleOpen(true)`.
   */
  middleOpen: boolean;
  setMiddleOpen(open: boolean): void;
}

const ShellContext = createContext<ShellValue | undefined>(undefined);

const RAIL_STORAGE_KEY = 'agile.cr.rail-collapsed';

function readStoredRail(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) === '1';
  } catch {
    // Private window / blocked site data — the rail just starts expanded.
    return false;
  }
}

export function ShellProvider({
  initialView = 'sprint',
  children,
}: PropsWithChildren<{ initialView?: ShellView }>): JSX.Element {
  const [view, setView] = useState<ShellView>(initialView);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readStoredRail);
  const [chatMode, setChatModeState] = useState<ChatMode>('panel');
  const [middleOpen, setMiddleOpenState] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, railCollapsed ? '1' : '0');
    } catch {
      // Nothing to do — the collapse still works for this page's lifetime.
    }
  }, [railCollapsed]);

  const setChatMode = useCallback((mode: ChatMode) => {
    setChatModeState(mode);
    // "Chat maximize hides the middle pane" — the pane's own open flag is
    // left alone so restoring brings back exactly what was there.
  }, []);

  const setMiddleOpen = useCallback((open: boolean) => {
    setMiddleOpenState(open);
    // "closing the middle pane widens the chat and vice versa": a closed
    // pane with a hidden chat would leave an empty frame, so closing it
    // always brings the chat back.
    if (!open) setChatModeState((mode) => (mode === 'hidden' ? 'panel' : mode));
    else setChatModeState((mode) => (mode === 'max' ? 'panel' : mode));
  }, []);

  const value = useMemo<ShellValue>(
    () => ({
      view,
      setView,
      railCollapsed,
      setRailCollapsed,
      toggleRail: () => setRailCollapsed((v) => !v),
      chatMode,
      setChatMode,
      middleOpen,
      setMiddleOpen,
    }),
    [view, railCollapsed, chatMode, setChatMode, middleOpen, setMiddleOpen],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside a <ShellProvider>');
  return value;
}
