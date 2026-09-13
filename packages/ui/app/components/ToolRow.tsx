/**
 * T043 — the thin tool row under the top bar (§17 "Control room v2"):
 *
 *   "A thin tool row under the top bar holds the rail collapse on the left
 *    and, after a divider, chat show/hide, pop-out, and maximize on the
 *    right. Icons, not text links."
 *
 * Every button here is icon-only, so every one carries both a `title`
 * (hover tooltip) and an `aria-label` (its accessible name), is a real
 * `<button>` in tab order, and gets a visible focus ring from
 * `.cr-ib:focus-visible` (ticket AC: "every icon has a tooltip and keyboard
 * focus").
 *
 * The rail toggle appears only on the Plan screen — it is the Plan rail it
 * collapses (mockup: the Sprint and Settings tool rows have no left-hand
 * button). The chat controls are on every view, because "EM chat is one
 * conversation across views".
 */

import { useShell } from '../lib/shell';
import { ChatIcon, MaximizeIcon, PopOutIcon, RailCollapseIcon } from './icons';

export function ToolRow({ connected }: { connected: boolean }): JSX.Element {
  const { view, railCollapsed, toggleRail, chatMode, setChatMode } = useShell();

  const chatVisible = chatMode !== 'hidden';
  const maximized = chatMode === 'max';

  return (
    <div className="cr-toolrow" data-testid="toolrow">
      {view === 'plan' && (
        <button
          type="button"
          className="cr-ib"
          data-testid="rail-toggle"
          aria-pressed={railCollapsed}
          title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleRail}
        >
          <RailCollapseIcon collapsed={railCollapsed} />
        </button>
      )}
      <span
        className="cr-conn-dot"
        data-status={connected ? 'open' : 'closed'}
        title={connected ? 'Live — connected to the daemon' : 'Reconnecting to the daemon…'}
        data-testid="conn-dot"
      />
      <span className="grow" />
      <span className="sep" />
      <button
        type="button"
        className={`cr-ib${chatVisible ? ' on' : ''}`}
        data-testid="chat-toggle"
        aria-pressed={chatVisible}
        title={chatVisible ? 'Hide EM chat' : 'Show EM chat'}
        aria-label={chatVisible ? 'Hide EM chat' : 'Show EM chat'}
        onClick={() => setChatMode(chatVisible ? 'hidden' : 'panel')}
      >
        <ChatIcon />
      </button>
      <button
        type="button"
        className="cr-ib"
        data-testid="chat-popout"
        title="Pop chat out into its own window"
        aria-label="Pop chat out into its own window"
        onClick={() => window.open('/control-room/chat', 'agile-em-chat')}
      >
        <PopOutIcon />
      </button>
      <button
        type="button"
        className={`cr-ib${maximized ? ' on' : ''}`}
        data-testid="chat-maximize"
        aria-pressed={maximized}
        title={maximized ? 'Restore' : 'Maximize chat'}
        aria-label={maximized ? 'Restore chat' : 'Maximize chat'}
        onClick={() => setChatMode(maximized ? 'panel' : 'max')}
      >
        <MaximizeIcon on={maximized} />
      </button>
    </div>
  );
}
