/**
 * The Plan pane's close (X) — T049 defect 4.
 *
 * It used to be a right-aligned strip of its own that `PlanScreen` rendered
 * *above* the pane, which overlapped the pane's own `.dochd` action button
 * (Add ticket / Add rule / Edit). `design/control-room-mockup.html` puts the
 * close inside `.dochd` as its last child on every pane, so that is where it
 * goes: one flex row, the header's own `gap`, nothing to overlap.
 *
 * The callback comes through a context rather than a prop on all eight panes
 * — the panes are otherwise pure views over their own data and threading a
 * shell concern through every one of their signatures would be noise.
 */

import { createContext, useContext } from 'react';

const PaneCloseContext = createContext<(() => void) | undefined>(undefined);

export const PaneCloseProvider = PaneCloseContext.Provider;

export function PaneClose(): JSX.Element | null {
  const close = useContext(PaneCloseContext);
  if (!close) return null;
  return (
    <button
      type="button"
      className="cr-icon-btn cr-pane-close"
      data-testid="pane-close"
      title="Close this pane and widen the chat"
      aria-label="Close this pane and widen the chat"
      onClick={close}
    >
      ✕
    </button>
  );
}
