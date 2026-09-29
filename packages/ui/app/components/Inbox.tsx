/**
 * Needs me (cockpit design §3, §9.1; design/cockpit-ui.md §7): everything
 * that waits on the human, across every node, answered in place. T364:
 * grouped by project, then by node, oldest first; a filter by what the item
 * wants (an answer, a decision, a merge); `j`/`k` move between cards,
 * A/B (or 1/2) pick a focused question's choice (T416) and Enter opens a
 * card's node. Nothing waiting reads "all caught up" — or, on
 * a first run (no repository or no project yet), the three steps to get
 * going.
 *
 * The card itself is `DecisionCard.tsx`'s `Card`, re-exported here: the
 * node page renders it too (with `full`).
 */

import type { InboxItem } from '@agile-agents/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeStream, dismissFinished, getDirector, getStreamPage } from '../lib/api';
import { vendorLabel } from '../lib/chat';
import { useFeed } from '../lib/feed-context';
import type { CockpitStreamRow } from '../lib/feed-types';
import {
  DECIDED_LINGER_MS,
  DONE_CARD_TITLE,
  LIST_SETTLE_MS,
  type NeedsMeFilter,
  PATH_SEP,
  type SetupStep,
  applyFilter,
  cardTitle,
  cardTone,
  choiceIndexOfKey,
  doneCardOf,
  filterCounts,
  groupNeedsMe,
  inboxLine,
  isFirstRun,
  nodePath,
  nodesOf,
  replyPreview,
  setupSteps,
  withDecided,
} from '../lib/inbox';
import { isShortcut, useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { DIRECTOR_READ_KEY, ancestorTitles } from '../lib/unread';
import { markAllRead, markRead, useDirectorUnread, useUnreadReplies } from '../lib/use-unread';
import { Card, inboxIcon } from './DecisionCard';
import { Icon, type IconName } from './Icon';
import { ROLE_GLYPH } from './StreamTree';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Kbd,
  PageHeader,
  Segmented,
  Spinner,
  useToast,
} from './ui';

export { Card } from './DecisionCard';

/** T449: how far (px) a pointer may drift and still be "where the last click landed". */
const SAME_SPOT_PX = 6;

const FILTERS: ReadonlyArray<{ id: NeedsMeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'questions', label: 'Questions' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'merges', label: 'Merges' },
  // T470: nodes that finished with nothing to merge, and blocked agents.
  { id: 'finished', label: 'Finished' },
  { id: 'blocked', label: 'Blocked' },
];

/** T470: a row, the focusable line of one Needs me item. */
const ROW = '.cr-inbox-row';

/** T470: "Expand all" is remembered per browser; storage may be unavailable (a private window). */
const ALL_OPEN_KEY = 'agile.inbox.expandAll';

function readAllOpen(): boolean {
  try {
    return localStorage.getItem(ALL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAllOpen(on: boolean): void {
  try {
    if (on) localStorage.setItem(ALL_OPEN_KEY, '1');
    else localStorage.removeItem(ALL_OPEN_KEY);
  } catch {
    // Not remembered: it still applies until the page reloads.
  }
}

/** Re-renders every minute so the cards' ages stay true while the page sits open. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

/**
 * T470: `j`/`k` move focus between the rows; on a focused row `x` selects
 * it, Space expands its card and Enter opens its node. T416: on a focused
 * question, A/B… (or 1/2…) picks that choice once its card is expanded.
 * Never while typing (`isShortcut`), and only when the row itself has
 * focus, so a focused button still presses and a focused input still types.
 */
function useRowKeys(
  list: React.RefObject<HTMLElement>,
  open: (id: string) => void,
  toggleSelect: (id: string) => void,
  toggleExpand: (id: string) => void,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Not behind an open dialog.
      if (event.defaultPrevented || document.querySelector('.cr-modal')) return;
      const root = list.current;
      if (!root) return;
      const rows = [...root.querySelectorAll<HTMLElement>(ROW)];
      if (rows.length === 0) return;
      const active = document.activeElement;
      const at = rows.findIndex(
        (row) => row === active || row.closest('.cr-inbox-item')?.contains(active) === true,
      );
      if (isShortcut(event, 'j') || isShortcut(event, 'k')) {
        event.preventDefault();
        const next =
          at < 0 ? 0 : event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
        rows[next]?.focus();
        rows[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      // The row itself, or its expanded card, has focus (not a button or field inside).
      const onRow =
        at >= 0 &&
        (active === rows[at] ||
          (active instanceof HTMLElement && active.classList.contains('cr-card')));
      const row = onRow ? rows[at] : undefined;
      if (!row) return;
      const id = row.dataset.item ?? '';
      if (isShortcut(event, 'Enter')) {
        const node = row.dataset.nodeId;
        if (node) {
          event.preventDefault();
          open(node);
        }
        return;
      }
      if (isShortcut(event, 'x')) {
        event.preventDefault();
        toggleSelect(id);
        return;
      }
      if (isShortcut(event, ' ')) {
        event.preventDefault();
        toggleExpand(id);
        return;
      }
      if (isShortcut(event, event.key) && !event.shiftKey) {
        const item = row.closest('.cr-inbox-item') ?? row;
        const choices = [
          ...item.querySelectorAll<HTMLButtonElement>('[data-testid="answer-choice"]'),
        ];
        const index = choiceIndexOfKey(event.key, choices.length);
        const choice = index !== undefined ? choices[index] : undefined;
        if (choice && !choice.disabled) {
          // T419's `a` (Ask) listens on the window: on a focused question, A is its choice.
          event.preventDefault();
          event.stopPropagation();
          choice.click();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [list, open, toggleSelect, toggleExpand]);
}

/** A card acted on here: when (to forget one the frame never took away) and when it left the list. */
interface Decided {
  item: InboxItem;
  at: number;
  gone?: number;
}

/** How long a card acted on may wait for the frame that takes it away before it is forgotten. */
const DECIDED_WAIT_MS = 10_000;

/**
 * T445 (audit r7 #5, #13): the list holds still under the pointer and keeps
 * the keyboard's place.
 *  - A card acted on here stays mounted from the moment its action starts
 *    (the frame may drop it before the answer is back), and
 *    `DECIDED_LINGER_MS` after the frame drops it, in place and at its
 *    height, as its outcome ("Merged into main").
 *  - For `LIST_SETTLE_MS` after any card leaves, a pointer's click on the
 *    list where the last one landed is ignored: whatever is under it just
 *    moved there (T449: a click elsewhere is meant and goes through). Keys
 *    still work.
 *  - When the card that had focus leaves, the one that took its place gets it.
 */
function useSteadyList(
  items: readonly InboxItem[],
  list: React.RefObject<HTMLElement>,
): {
  shown: InboxItem[];
  gone: (id: string) => boolean;
  onActing: (item: InboxItem) => void;
  guard: (event: React.MouseEvent) => void;
  onFocus: (event: React.FocusEvent) => void;
} {
  const [decided, setDecided] = useState<ReadonlyMap<string, Decided>>(new Map());
  const guardUntil = useRef(0);
  const lastClick = useRef<{ x: number; y: number } | undefined>(undefined);
  const lastFocus = useRef<{ id: string; index: number } | undefined>(undefined);
  const shownIds = useRef<readonly string[]>([]);

  const onActing = useCallback((item: InboxItem) => {
    setDecided((before) => new Map(before).set(item.id, { item, at: Date.now() }));
  }, []);

  // Mark when each decided card left the frame's list; forget any the frame never took away.
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const now = Date.now();
    let changed = false;
    const next = new Map(decided);
    for (const [id, d] of decided) {
      if (ids.has(id)) {
        if (d.gone !== undefined || now - d.at > DECIDED_WAIT_MS) {
          next.delete(id);
          changed = true;
        }
      } else if (d.gone === undefined) {
        next.set(id, { ...d, gone: now });
        changed = true;
      }
    }
    if (changed) setDecided(next);
  }, [items, decided]);

  // Each one that left goes once it has stayed its moment.
  useEffect(() => {
    const leaving = [...decided.values()].flatMap((d) => (d.gone !== undefined ? [d.gone] : []));
    if (leaving.length === 0) return;
    const due = Math.min(...leaving) + DECIDED_LINGER_MS - Date.now();
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setDecided((before) => {
          const next = new Map(before);
          for (const [id, d] of before) {
            if (d.gone !== undefined && now - d.gone >= DECIDED_LINGER_MS) next.delete(id);
          }
          return next;
        });
      },
      Math.max(0, due),
    );
    return () => clearTimeout(timer);
  }, [decided]);

  const shown = withDecided(items, decided, Date.now());
  const frameIds = new Set(items.map((i) => i.id));
  const key = shown.map((i) => i.id).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger.
  useLayoutEffect(() => {
    const now = shown.map((i) => i.id);
    const left = shownIds.current.filter((id) => !now.includes(id));
    shownIds.current = now;
    if (left.length === 0) return;
    guardUntil.current = performance.now() + LIST_SETTLE_MS;
    const was = lastFocus.current;
    const active = document.activeElement;
    if (was === undefined || !left.includes(was.id)) return;
    if (active !== null && active !== document.body) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
    const next = rows[Math.min(was.index, rows.length - 1)];
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView?.({ block: 'nearest' });
    }
  }, [key]);

  return {
    shown,
    gone: (id) => !frameIds.has(id),
    onActing,
    guard: (event) => {
      // `detail` is 0 for a click made by a key (Enter, Space, a card's A/B): never guarded.
      if (event.detail === 0) return;
      // T449: only a click where the last one landed (the pointer hasn't moved: a double-click,
      // or a second click while the first was slow) hits whatever just slid under it. A click
      // aimed somewhere else is meant, and goes through.
      const at = { x: event.clientX, y: event.clientY };
      const last = lastClick.current;
      lastClick.current = at;
      const still =
        last !== undefined &&
        Math.abs(at.x - last.x) <= SAME_SPOT_PX &&
        Math.abs(at.y - last.y) <= SAME_SPOT_PX;
      if (still && performance.now() < guardUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onFocus: (event) => {
      const row = (event.target as Element)
        .closest('.cr-inbox-item')
        ?.querySelector<HTMLElement>(ROW);
      const id = row?.dataset.item;
      if (!row || id === undefined) return;
      const rows = [...(list.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
      lastFocus.current = { id, index: rows.indexOf(row) };
    },
  };
}

export function Inbox({
  items,
  onChanged,
}: {
  items: readonly InboxItem[];
  onChanged: () => void;
}): JSX.Element {
  const { cockpit } = useFeed();
  const { select } = useShell();
  const toast = useToast();
  const [filter, setFilter] = useState<NeedsMeFilter>('all');
  const list = useRef<HTMLDivElement>(null);
  // T470: the rows ticked, the rows expanded to their card, and a close that asks first.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Expand all: every row shows its card (remembered per browser); a row can still fold itself.
  const [allOpen, setAllOpen] = useState<boolean>(() => readAllOpen());
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const isExpanded = (id: string): boolean => (allOpen ? !folded.has(id) : expanded.has(id));
  const [confirm, setConfirm] = useState<{ nodes: string[]; label: string } | undefined>();
  const [closing, setClosing] = useState(false);
  // T429: answers you haven't read, above what waits on you (T433: the Director's first).
  const replies = useUnreadReplies();
  const directorReply = useDirectorUnread();
  useMinuteTick();
  const toggleSelect = useCallback((id: string) => {
    setSelected((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const toggleExpand = useCallback(
    (id: string) => {
      const flip = (before: ReadonlySet<string>) => {
        const next = new Set(before);
        if (!next.delete(id)) next.add(id);
        return next;
      };
      if (allOpen) setFolded(flip);
      else setExpanded(flip);
    },
    [allOpen],
  );
  useRowKeys(list, select, toggleSelect, toggleExpand);
  const steady = useSteadyList(items, list);

  const rows = cockpit?.streams ?? [];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rowOf = (id: string | undefined) => (id === undefined ? undefined : rowById.get(id));
  const counts = filterCounts(items, rowOf);
  // A filter emptied by answering its last item falls back to everything.
  const active = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const kinds = FILTERS.filter((f) => f.id !== 'all' && counts[f.id] > 0).length;
  const shownItems = applyFilter(steady.shown, active, rowOf);
  const sections = groupNeedsMe(shownItems, rows, cockpit?.projects ?? []);
  const headed = sections.some((s) => s.kind === 'project');
  // Only what is shown (and still there) counts as selected.
  const shownIds = new Set(shownItems.map((i) => i.id));
  const picked = shownItems.filter((i) => selected.has(i.id) && !steady.gone(i.id));
  const pickedNodes = nodesOf(picked);
  const finished = applyFilter(items, 'finished', rowOf);
  const allTicked = shownItems.length > 0 && shownItems.every((i) => selected.has(i.id));

  /** T477: a Finished row's ✕: it stays away until its agent finishes again. */
  async function dismissOne(node: string): Promise<void> {
    try {
      await dismissFinished(node);
      onChanged();
    } catch {
      toast({ title: 'Couldn’t dismiss it; the daemon didn’t answer.', tone: 'error' });
    }
  }

  async function closeNodes(nodes: readonly string[]): Promise<void> {
    setClosing(true);
    let closed = 0;
    let failed = 0;
    for (const node of nodes) {
      try {
        await closeStream(node);
        closed++;
      } catch {
        failed++;
      }
    }
    setClosing(false);
    setSelected(
      (before) =>
        new Set([...before].filter((id) => shownIds.has(id) && !picked.some((p) => p.id === id))),
    );
    onChanged();
    toast({
      title:
        failed === 0
          ? `Closed ${closed} ${closed === 1 ? 'node' : 'nodes'}`
          : `Closed ${closed}; ${failed} couldn’t close`,
      tone: failed === 0 ? 'success' : 'error',
    });
  }

  return (
    <section className="cr-inbox cr-needsme" data-testid="inbox">
      <PageHeader
        className="cr-needsme-hd"
        icon="inbox"
        // T341: the view is "Needs me" in the sidebar and the walkthrough; its heading agrees.
        title="Needs me"
        badge={
          items.length > 0 ? (
            <span className="cr-count" data-testid="inbox-count">
              {items.length}
            </span>
          ) : undefined
        }
        subtitle="Questions, decisions and merges waiting on you"
        actions={
          kinds > 1 ? (
            <Segmented
              label="Show"
              testid="inbox-filter"
              value={active}
              onChange={(next) => {
                setFilter(next);
                setSelected(new Set());
              }}
              items={FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => ({
                id: f.id,
                label: f.label,
                count: counts[f.id],
                testid: `inbox-filter-${f.id}`,
              }))}
            />
          ) : undefined
        }
      />

      <Replies rows={replies} director={directorReply} />
      {cockpit === undefined && items.length === 0 ? (
        <div className="cr-inbox-loading" data-testid="inbox-loading">
          <Spinner size={16} />
          Loading…
        </div>
      ) : steady.shown.length === 0 ? (
        <Empty replies={replies.length + (directorReply !== undefined ? 1 : 0)} />
      ) : (
        <>
          <div className="cr-inbox-bar" data-testid="inbox-bar">
            <input
              type="checkbox"
              className="cr-inbox-check"
              data-testid="inbox-select-all"
              aria-label={allTicked ? 'Select none' : 'Select all shown'}
              title={allTicked ? 'Select none' : 'Select all shown'}
              checked={allTicked}
              onChange={() =>
                setSelected(allTicked ? new Set() : new Set(shownItems.map((i) => i.id)))
              }
            />
            {picked.length > 0 ? (
              <>
                <span className="cr-inbox-bar-count" data-testid="inbox-selected">
                  {picked.length} selected
                </span>
                {pickedNodes.length > 0 && (
                  <Button
                    size="sm"
                    icon="x-circle"
                    data-testid="inbox-close-selected"
                    busy={closing}
                    onClick={() =>
                      setConfirm({
                        nodes: pickedNodes,
                        label: `Close ${pickedNodes.length} ${pickedNodes.length === 1 ? 'node' : 'nodes'}`,
                      })
                    }
                  >
                    Close {pickedNodes.length}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </>
            ) : (
              <span className="cr-inbox-bar-hint">Select rows to act on several at once</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={allOpen ? 'chevron-up' : 'chevron-down'}
              className="cr-inbox-bar-end"
              data-testid="inbox-expand-all"
              aria-pressed={allOpen}
              onClick={() => {
                const next = !allOpen;
                setAllOpen(next);
                setFolded(new Set());
                setExpanded(new Set());
                writeAllOpen(next);
              }}
            >
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
            {finished.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon="check-circle"
                data-testid="inbox-close-finished"
                busy={closing}
                onClick={() =>
                  setConfirm({
                    nodes: nodesOf(finished),
                    label: `Close all finished (${nodesOf(finished).length})`,
                  })
                }
              >
                Close all finished
              </Button>
            )}
          </div>
          <div
            className="cr-inbox-list"
            ref={list}
            onClickCapture={steady.guard}
            onFocus={steady.onFocus}
          >
            {sections.map((section) => (
              <section
                className="cr-inbox-section"
                key={section.key}
                data-section={section.key}
                aria-label={section.label}
              >
                {headed && (
                  <h2 className="cr-inbox-section-hd">
                    <Icon
                      name={
                        section.kind === 'project'
                          ? 'layers'
                          : section.kind === 'knowledge'
                            ? 'book-open'
                            : section.kind === 'updates'
                              ? 'download'
                              : 'circle-dashed'
                      }
                      size={14}
                    />
                    <span className="cr-inbox-section-name">{section.label}</span>
                    <span className="cr-inbox-section-count">{section.count}</span>
                  </h2>
                )}
                {section.groups.flatMap((group) =>
                  group.items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      row={rowOf(item.stream)}
                      path={group.path}
                      selected={selected.has(item.id)}
                      expanded={isExpanded(item.id)}
                      onSelect={() => toggleSelect(item.id)}
                      onExpand={() => toggleExpand(item.id)}
                      onOpen={() => item.stream !== undefined && select(item.stream)}
                      onClose={() => item.stream !== undefined && void closeNodes([item.stream])}
                      onDismiss={() => item.stream !== undefined && void dismissOne(item.stream)}
                      closing={closing}
                      onDone={onChanged}
                      onActing={steady.onActing}
                      gone={steady.gone(item.id)}
                    />
                  )),
                )}
              </section>
            ))}
            <p className="cr-inbox-keys" aria-hidden="true">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> move · <Kbd>x</Kbd> select · <Kbd>Space</Kbd> expand · <Kbd>Enter</Kbd>{' '}
              opens the node
            </p>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm !== undefined}
        title={`${confirm?.label ?? 'Close'}?`}
        confirmLabel={confirm?.label ?? 'Close'}
        busy={closing}
        testid="inbox-close-confirm"
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          const nodes = confirm?.nodes ?? [];
          setConfirm(undefined);
          void closeNodes(nodes);
        }}
      >
        Each node stops being active: its agent won’t start and it leaves Needs me. Its branch and
        worktree stay as they are.
      </ConfirmDialog>
    </section>
  );
}

/**
 * T470: one Needs me item as a row: select it, what it is, the agent, the
 * node, one line, its age, Close and Open. The row itself expands the full
 * card, where a question is answered or a merge made.
 */
function InboxRow({
  item,
  row,
  path,
  selected,
  expanded,
  onSelect,
  onExpand,
  onOpen,
  onClose,
  onDismiss,
  closing,
  onDone,
  onActing,
  gone,
}: {
  item: InboxItem;
  row: CockpitStreamRow | undefined;
  /** The node's path inside its project, root→leaf. */
  path: readonly string[];
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onExpand: () => void;
  onOpen: () => void;
  onClose: () => void;
  /** T477: a Finished row's ✕. */
  onDismiss: () => void;
  closing: boolean;
  onDone: () => void;
  onActing: (item: InboxItem) => void;
  gone: boolean;
}): JSX.Element {
  const title = item.kind === 'done' ? DONE_CARD_TITLE[doneCardOf(row)] : cardTitle(item);
  // T481: a CLI update is about the CLI ("Claude Code"), not a node.
  const subject =
    item.harness?.label ?? path.at(-1) ?? (item.stream === undefined ? 'Knowledge' : 'Node');
  const parents = path.slice(0, -1);
  const agent = row?.live_agent?.vendor ?? row?.last_agent?.vendor;
  const line = inboxLine(item, row);
  // A node that finished with nothing to merge: done, not a merge.
  const finishedIdle = item.kind === 'done' && doneCardOf(row) === 'no_changes';
  return (
    <div
      className="cr-inbox-item"
      data-testid="inbox-item"
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      <article
        className="cr-inbox-row"
        aria-label={`${title}: ${subject}`}
        // The list moves focus between rows with j/k; a row is never a tab stop.
        tabIndex={-1}
        data-testid="inbox-row"
        data-item={item.id}
        data-row-kind={item.kind}
        data-node-id={item.stream}
        data-tone={cardTone(item)}
      >
        <input
          type="checkbox"
          className="cr-inbox-check"
          data-testid="inbox-select"
          aria-label={`Select ${subject}`}
          checked={selected}
          onChange={onSelect}
        />
        <span
          className="cr-inbox-row-icon"
          data-tone={finishedIdle ? 'gray' : cardTone(item)}
          aria-hidden="true"
        >
          <Icon name={finishedIdle ? 'check-circle' : inboxIcon(item)} size={15} />
        </span>
        <span className="cr-inbox-row-agent" data-testid="inbox-agent">
          {agent !== undefined
            ? vendorLabel(agent)
            : item.kind === 'harness_update'
              ? 'Update'
              : item.stream === undefined
                ? 'Knowledge'
                : ''}
        </span>
        <button
          type="button"
          className="cr-inbox-row-main"
          data-testid="inbox-expand"
          aria-expanded={expanded}
          title={expanded ? 'Hide the card' : 'Show the card'}
          onClick={onExpand}
        >
          <span className="cr-inbox-row-subject" data-testid="inbox-subject">
            {parents.length > 0 && (
              <span className="cr-inbox-row-parents">{`${nodePath(parents)}${PATH_SEP}`}</span>
            )}
            {subject}
          </span>
          <span className="cr-inbox-row-what" data-testid="inbox-what">
            {title}
          </span>
          {line !== undefined && (
            <span className="cr-inbox-row-line" data-testid="inbox-line">
              {line}
            </span>
          )}
        </button>
        <span className="cr-inbox-row-age" title={item.ts}>
          {ago(item.ts)}
        </span>
        <span className="cr-inbox-row-actions">
          {item.kind === 'done' && item.stream !== undefined && (
            <IconButton
              icon="x"
              size="sm"
              label="Dismiss"
              title="Dismiss. It comes back if the agent finishes again."
              data-testid="inbox-dismiss"
              disabled={closing || gone}
              onClick={onDismiss}
            />
          )}
          {item.stream !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              icon="x-circle"
              data-testid="inbox-close"
              disabled={closing || gone}
              title="Close the node: it stops being active and leaves Needs me"
              onClick={onClose}
            >
              Close
            </Button>
          )}
          {item.stream !== undefined && (
            <Button size="sm" iconRight="arrow-right" data-testid="inbox-open" onClick={onOpen}>
              Open
            </Button>
          )}
        </span>
      </article>
      {(expanded || gone) && (
        <div className="cr-inbox-card">
          <Card item={item} onDone={onDone} onActing={onActing} gone={gone} />
        </div>
      )}
    </div>
  );
}

/**
 * T429: the replies you haven't read — a conversation, a root or a
 * coordinator that answered. Opening one (or its check) reads it; they are
 * never Needs me's cards, which wait on a decision.
 */
function Replies({
  rows,
  director,
}: {
  rows: readonly CockpitStreamRow[];
  /** T433: when the Director replied, if you haven't read it. */
  director?: string | undefined;
}): JSX.Element | null {
  const { cockpit } = useFeed();
  const { select, setView } = useShell();
  const count = rows.length + (director !== undefined ? 1 : 0);
  if (count === 0) return null;
  const all = cockpit?.streams ?? [];
  return (
    <section className="cr-replies" data-testid="replies" aria-label="Replies">
      <h2 className="cr-inbox-section-hd">
        <Icon name="message-square" size={14} />
        <span className="cr-inbox-section-name">Replies</span>
        <span className="cr-inbox-section-count">{count}</span>
        <button
          type="button"
          className="cr-link cr-replies-all"
          data-testid="replies-mark-all"
          onClick={() => {
            markAllRead(rows);
            if (director !== undefined) markRead(DIRECTOR_READ_KEY, director);
          }}
        >
          Mark all read
        </button>
      </h2>
      <ul className="cr-replies-list">
        {director !== undefined && (
          <ReplyRow
            id={DIRECTOR_READ_KEY}
            at={director}
            icon="sparkles"
            title="The Director"
            parents={[]}
            when="Replied"
            label="Open the Director"
            onOpen={() => setView('director')}
            onRead={() => markRead(DIRECTOR_READ_KEY, director)}
          />
        )}
        {rows.map((row) => (
          <ReplyRow
            key={row.id}
            id={row.id}
            // T437: when it answered (a status change later is no new reply).
            at={row.answered_at}
            // T436 (audit r6 #17): the rail's role glyphs, so a row reads as the tree does.
            icon={ROLE_GLYPH[row.role]}
            title={row.title}
            parents={ancestorTitles(all, row.id)}
            when={row.role === 'conversation' ? 'Replied' : 'Finished a turn'}
            label={`Open ${row.title}`}
            onOpen={() => select(row.id, { tab: 'thread' })}
            onRead={() => row.updated_at && markRead(row.id, row.updated_at)}
          />
        ))}
      </ul>
    </section>
  );
}

/** T436: previews read so far, per reply (`id@when`): a re-render or a revisit reads nothing again. */
const previews = new Map<string, string | null>();

/**
 * T436 (audit r6 #17): the first line of what `id` replied — its node's
 * last agent line (else its last progress line), or the Director's — read
 * once per reply. The cockpit frame carries no reply text, so this is the
 * node's page read (the Director's), cached; nothing shows until it's in,
 * and a read that fails shows nothing.
 */
function useReplyPreview(id: string, at: string | undefined): string | undefined {
  const key = `${id}@${at ?? ''}`;
  const [text, setText] = useState<string | undefined>(() => previews.get(key) ?? undefined);
  useEffect(() => {
    if (previews.has(key)) {
      setText(previews.get(key) ?? undefined);
      return;
    }
    let live = true;
    const read =
      id === DIRECTOR_READ_KEY
        ? getDirector().then((page) => replyPreview(page.thread))
        : getStreamPage(id).then((page) => replyPreview(page.thread, page.stream.agent.progress));
    read
      .then((preview) => {
        for (const old of previews.keys()) if (old.startsWith(`${id}@`)) previews.delete(old);
        previews.set(key, preview ?? null);
        if (live) setText(preview);
      })
      .catch(() => {
        // No preview: the row still reads, and opens the reply.
      });
    return () => {
      live = false;
    };
  }, [id, key]);
  return text;
}

function ReplyRow({
  id,
  at,
  icon,
  title,
  parents,
  when,
  label,
  onOpen,
  onRead,
}: {
  id: string;
  at: string | undefined;
  icon: IconName;
  title: string;
  parents: readonly string[];
  when: string;
  label: string;
  onOpen: () => void;
  onRead: () => void;
}): JSX.Element {
  const preview = useReplyPreview(id, at);
  return (
    <li className="cr-reply" data-testid="reply" data-stream={id}>
      <button type="button" className="cr-reply-open" title={label} onClick={onOpen}>
        <Icon name={icon} size={14} className="cr-reply-icon" />
        <span className="cr-reply-text">
          <span className="cr-reply-head">
            {parents.length > 0 && (
              <span className="cr-reply-path">{`${nodePath(parents)}${PATH_SEP}`}</span>
            )}
            <span className="cr-reply-title">{title}</span>
          </span>
          {preview !== undefined && (
            <span className="cr-reply-preview" data-testid="reply-preview" title={preview}>
              {preview}
            </span>
          )}
        </span>
        <span className="cr-reply-when">
          {when}
          {at ? ` · ${ago(at)}` : ''}
        </span>
      </button>
      <IconButton
        icon="check"
        size="sm"
        label="Mark read"
        data-testid="reply-read"
        onClick={onRead}
      />
    </li>
  );
}

/** Nothing waits on you: all caught up — or, on a first run, the steps to get going. */
function Empty({ replies = 0 }: { replies?: number }): JSX.Element {
  const { cockpit } = useFeed();
  const { setNewStreamOpen } = useShell();
  const steps = setupSteps(cockpit);
  if (cockpit !== undefined && isFirstRun(steps)) {
    return <Welcome steps={steps} />;
  }
  return (
    <div data-testid="inbox-empty" data-state="caught-up">
      <EmptyState
        icon="check-circle"
        title={replies > 0 ? 'Nothing else waits on you' : 'You’re all caught up'}
        actions={
          <Button
            icon="plus"
            variant={steps[2]?.done === false ? 'primary' : 'secondary'}
            onClick={() => setNewStreamOpen(true)}
          >
            New node
          </Button>
        }
      >
        When an agent asks you something, wants your OK for an action, has a plan for you to approve
        or work ready to merge, it shows up here.
      </EmptyState>
    </div>
  );
}

const STEP_COPY: Record<
  SetupStep['id'],
  { icon: IconName; title: string; body: string; action: string; done: (n: number) => string }
> = {
  repo: {
    icon: 'folder-git',
    title: 'Add a repository',
    body: 'A git repository on this machine, or one to clone. Agents work in their own branch of it.',
    action: 'Add repository',
    done: (n) => `${n} ${n === 1 ? 'repository' : 'repositories'} added`,
  },
  project: {
    icon: 'layers',
    title: 'Create a project',
    body: 'A project groups the nodes for one piece of work and the repositories they use.',
    action: 'New project',
    done: (n) => `${n} ${n === 1 ? 'project' : 'projects'}`,
  },
  node: {
    icon: 'git-branch',
    title: 'Start a node',
    body: 'A node is one goal with its own agent and conversation — and a branch, when it works in a repo.',
    action: 'New node',
    done: (n) => `${n} ${n === 1 ? 'node' : 'nodes'}`,
  },
};

/** T445 (audit r7 #10, #13): the step whose button takes focus once it is the next one. */
let focusOnStep: SetupStep['id'] | undefined;
const stepListeners = new Set<() => void>();

/**
 * T445: after a step done elsewhere (a repository added), the next step's
 * button takes focus — once it is the next one, whether the frame that
 * says so came before this call or comes after it.
 */
export function focusSetupStep(id: SetupStep['id']): void {
  focusOnStep = id;
  for (const listener of stepListeners) listener();
}

function Welcome({ steps }: { steps: readonly SetupStep[] }): JSX.Element {
  const { setAddRepoOpen, setNewProjectOpen, setNewStreamOpen } = useShell();
  const next = steps.find((s) => !s.done)?.id;
  const started = steps.some((s) => s.done);
  const nextButton = useRef<HTMLButtonElement>(null);
  // T445 (audit r7 #10): every step opens its dialog here, over Needs me.
  const run: Record<SetupStep['id'], () => void> = {
    repo: () => setAddRepoOpen(true),
    project: () => setNewProjectOpen(true),
    node: () => setNewStreamOpen(true),
  };
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const listener = (): void => setAsked((n) => n + 1);
    stepListeners.add(listener);
    return () => {
      stepListeners.delete(listener);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is a trigger.
  useEffect(() => {
    if (next === undefined || focusOnStep !== next) return;
    // After the dialog that did the step has closed and given its focus back.
    const timer = setTimeout(() => {
      focusOnStep = undefined;
      nextButton.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [next, asked]);
  return (
    <div className="cr-welcome" data-testid="inbox-empty" data-state="first-run">
      <div className="cr-welcome-hd">
        <h2>{started ? 'Finish setting up' : 'Welcome to Agile Agents'}</h2>
        <p>
          Agents work in nodes; this page is where they come to you — with questions, actions to
          allow, plans to approve and work ready to merge. Three steps to get going:
        </p>
      </div>
      <ol className="cr-welcome-steps">
        {steps.map((step, i) => {
          const copy = STEP_COPY[step.id];
          return (
            <li
              key={step.id}
              className="cr-welcome-step"
              data-testid="setup-step"
              data-step={step.id}
              data-done={step.done ? 'true' : 'false'}
            >
              <span className="cr-welcome-mark" aria-hidden="true">
                {step.done ? <Icon name="check" size={14} strokeWidth={2.5} /> : i + 1}
              </span>
              <div className="cr-welcome-text">
                <div className="cr-welcome-title">{copy.title}</div>
                <div className="cr-welcome-body">
                  {step.done ? copy.done(step.count) : copy.body}
                </div>
              </div>
              {!step.done && (
                <Button
                  size="sm"
                  variant={step.id === next ? 'primary' : 'secondary'}
                  {...(step.id === next ? { ref: nextButton } : {})}
                  icon={copy.icon}
                  data-testid={`setup-${step.id}`}
                  onClick={run[step.id]}
                >
                  {copy.action}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
