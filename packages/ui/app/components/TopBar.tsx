/**
 * T043 — the one top bar (§17 "Control room v2"):
 *
 *   "Top bar is identical on every view: project name (path on hover), then
 *    Plan / Sprint / Settings in fixed positions (Sprint carries the
 *    Needs-you count), then on the right the sprint status ('Sprint 1 ·
 *    running 4m 12s', '3 agents working') and the single action (Start
 *    Sprint N / Halt Sprint N). Spend is not in the top bar; it is a
 *    Settings row and a pop-out modal."
 *
 * Nothing in it moves between views: the same nodes in the same order render
 * for Plan, Sprint and Settings, and only `aria-current` on the nav changes.
 * Everything it shows comes from `/api/snapshot`'s `project` + `status`
 * blocks (`feed/snapshot.ts`), so the bar costs one read the control room
 * already makes.
 */

import { useEffect, useState } from 'react';
import { raiseHalt, releaseHalt, startSprint } from '../lib/api';
import type { FeedSnapshot } from '../lib/feed-types';
import { type ShellView, useShell } from '../lib/shell';

const NAV: ReadonlyArray<{ view: ShellView; label: string }> = [
  { view: 'plan', label: 'Plan' },
  { view: 'sprint', label: 'Sprint' },
  { view: 'settings', label: 'Settings' },
];

/** "4m 12s" / "1h 04m 12s" — the mockup's own shape for a running sprint. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `${minutes}m ${pad(seconds)}s`;
}

/** Re-renders once a second, but only while something is actually counting. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function sprintStatusText(status: FeedSnapshot['status'] | undefined, now: number): string {
  if (!status || status.sprint_state === 'none' || !status.sprint_id) return 'No sprint running';
  const label = status.sprint_id.replace(/^S-/, 'Sprint ');
  if (status.sprint_state === 'finished') {
    // Mockup `#s4`: "Sprint 1 · finished in 7m 09s · review pending". There
    // is no `finished_at` on a `Sprint` to measure "in 7m 09s" from (§4 has
    // `started` and the computed `retro`, nothing else), so the duration is
    // the one part of that line this cannot honestly render.
    return status.sprint_review_pending
      ? `${label} · finished · review pending`
      : `${label} · finished`;
  }
  const started = status.sprint_started_at ? Date.parse(status.sprint_started_at) : Number.NaN;
  if (Number.isNaN(started)) return `${label} · running`;
  return `${label} · running ${formatElapsed(now - started)}`;
}

export function TopBar({
  snapshot,
  haltCount,
  activeHaltIds,
  onChanged,
}: {
  snapshot: FeedSnapshot | undefined;
  haltCount: number;
  activeHaltIds: string[];
  onChanged: () => void;
}): JSX.Element {
  const { view, setView } = useShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const status = snapshot?.status;
  const project = snapshot?.project;
  const running = status?.sprint_state === 'running';
  const now = useTicker(running);

  const needsYou = status?.needs_you ?? 0;
  const working = status?.agents_working ?? 0;
  const sprintNumber =
    status?.sprint_id?.slice('S-'.length) ?? String(status?.next_sprint_number ?? 1);

  /**
   * The single action (§17 v2: "the single action (Start Sprint N / Halt
   * Sprint N)"). One button, four states — a raised halt takes precedence
   * over everything, because with the factory stopped the only useful next
   * move is to release it (T025's separate Halt/Resume pair collapses into
   * this):
   *   halted          → Resume Sprint N  (releases every active halt)
   *   running         → Halt Sprint N    (one global halt, `raised_by: human`)
   *   review pending  → Start Sprint N+1, DISABLED, "Review Sprint N first"
   *   otherwise       → Start Sprint N+1 (`POST /api/sprint/start`)
   *
   * The disabled state is the mockup's Review screen (`#s4`:
   * `<button class="btn signal" disabled title="Review Sprint 1 first">Start
   * Sprint 2</button>`) — §16's `sprint_review` gate is "integration → main",
   * so the next frontier must not be startable over an undecided one.
   */
  const halted = haltCount > 0;
  const reviewPending = status?.sprint_review_pending === true;
  const action: 'resume' | 'halt' | 'start' = halted ? 'resume' : running ? 'halt' : 'start';
  const blocked = action === 'start' && reviewPending;
  const actionLabel =
    action === 'resume'
      ? `Resume Sprint ${sprintNumber}`
      : action === 'halt'
        ? `Halt Sprint ${sprintNumber}`
        : `Start Sprint ${status?.next_sprint_number ?? 1}`;
  const actionTitle =
    action === 'resume'
      ? `Release ${haltCount} halt${haltCount === 1 ? '' : 's'} and let the team continue`
      : action === 'halt'
        ? 'Stop every agent on this sprint'
        : blocked
          ? `Review Sprint ${sprintNumber} first`
          : 'Start the next sprint frontier';

  async function runAction(): Promise<void> {
    // Belt to the `disabled` braces: the gate is the daemon's, and a click
    // that slipped through (a stale render, a scripted click) must not start
    // a sprint over an undecided review.
    if (blocked) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'resume') await Promise.all(activeHaltIds.map((id) => releaseHalt(id)));
      else if (action === 'halt') await raiseHalt('halted from the control room');
      else await startSprint();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="cr-topbar" data-testid="topbar">
      <div className="repo" title={project?.path ?? 'no project root'} data-testid="topbar-project">
        {project?.name ?? 'agile-agents'}
      </div>
      <nav className="cr-nav" aria-label="Views">
        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            data-view={item.view}
            aria-current={view === item.view ? 'page' : undefined}
            className={view === item.view ? 'on' : undefined}
            onClick={() => setView(item.view)}
          >
            {item.label}
            {item.view === 'sprint' && needsYou > 0 && (
              <span className="badge" data-testid="needs-you-badge">
                {needsYou}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="grow" />
      {error && <span className="cr-topbar-error">{error}</span>}
      <span className="cr-sprint-status" data-testid="sprint-status">
        {sprintStatusText(status, now)}
      </span>
      <span className="cr-agents-working" data-testid="agents-working">
        <span className="cr-conn-dot" data-status={working > 0 ? 'open' : 'closed'} />
        {working} {working === 1 ? 'agent' : 'agents'} working
      </span>
      <button
        type="button"
        className={action === 'halt' ? 'cr-btn danger' : 'cr-btn signal'}
        data-testid="sprint-action"
        disabled={busy || blocked}
        title={actionTitle}
        onClick={runAction}
      >
        {actionLabel}
      </button>
    </header>
  );
}
