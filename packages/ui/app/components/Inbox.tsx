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
import { getDirector, getStreamPage } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { CockpitStreamRow } from '../lib/feed-types';
import {
  DECIDED_LINGER_MS,
  LIST_SETTLE_MS,
  type NeedsMeFilter,
  PATH_SEP,
  type SetupStep,
  applyFilter,
  choiceIndexOfKey,
  filterCounts,
  groupNeedsMe,
  isFirstRun,
  nodePath,
  replyPreview,
  setupSteps,
  withDecided,
} from '../lib/inbox';
import { isShortcut, useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { DIRECTOR_READ_KEY, ancestorTitles } from '../lib/unread';
import { markAllRead, markRead, useDirectorUnread, useUnreadReplies } from '../lib/use-unread';
import { Card } from './DecisionCard';
import { Icon, type IconName } from './Icon';
import { ROLE_GLYPH } from './StreamTree';
import { Button, EmptyState, IconButton, Kbd, PageHeader, Segmented, Spinner } from './ui';

export { Card } from './DecisionCard';

const FILTERS: ReadonlyArray<{ id: NeedsMeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'questions', label: 'Questions' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'merges', label: 'Merges' },
];

/** Re-renders every minute so the cards' ages stay true while the page sits open. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

/**
 * `j`/`k` move focus between the cards; Enter on a focused card opens its
 * node. T416: on a focused question card, A/B… (or 1/2…) picks that choice,
 * as its keycaps say. Never while typing (`isShortcut`), and Enter and the
 * choice keys only when the card itself has focus, so a focused button
 * still presses and a focused input still types.
 */
function useCardKeys(list: React.RefObject<HTMLElement>, open: (id: string) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Not behind an open dialog.
      if (event.defaultPrevented || document.querySelector('.cr-modal')) return;
      const root = list.current;
      if (!root) return;
      const cards = [...root.querySelectorAll<HTMLElement>('.cr-card')];
      if (cards.length === 0) return;
      const active = document.activeElement;
      const at = cards.findIndex((card) => card === active || card.contains(active));
      if (isShortcut(event, 'j') || isShortcut(event, 'k')) {
        event.preventDefault();
        const next =
          at < 0 ? 0 : event.key === 'j' ? Math.min(cards.length - 1, at + 1) : Math.max(0, at - 1);
        cards[next]?.focus();
        cards[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const card = at >= 0 && active === cards[at] ? cards[at] : undefined;
      if (!card) return;
      if (isShortcut(event, 'Enter')) {
        const node = card.dataset.nodeId;
        if (node) {
          event.preventDefault();
          open(node);
        }
        return;
      }
      if (isShortcut(event, event.key) && !event.shiftKey) {
        const choices = [
          ...card.querySelectorAll<HTMLButtonElement>('[data-testid="answer-choice"]'),
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
  }, [list, open]);
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
 *    list is ignored: whatever is under it just moved there. Keys still work.
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
    const cards = [...(list.current?.querySelectorAll<HTMLElement>('.cr-card') ?? [])];
    const next = cards[Math.min(was.index, cards.length - 1)];
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
      if (event.detail > 0 && performance.now() < guardUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onFocus: (event) => {
      const card = (event.target as Element).closest<HTMLElement>('.cr-card');
      const id = card?.dataset.id;
      if (!card || id === undefined) return;
      const cards = [...(list.current?.querySelectorAll<HTMLElement>('.cr-card') ?? [])];
      lastFocus.current = { id, index: cards.indexOf(card) };
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
  const [filter, setFilter] = useState<NeedsMeFilter>('all');
  const list = useRef<HTMLDivElement>(null);
  // T429: answers you haven't read, above what waits on you (T433: the Director's first).
  const replies = useUnreadReplies();
  const directorReply = useDirectorUnread();
  useMinuteTick();
  useCardKeys(list, select);
  const steady = useSteadyList(items, list);

  const counts = filterCounts(items);
  // A filter emptied by answering its last item falls back to everything.
  const active = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const kinds = FILTERS.filter((f) => f.id !== 'all' && counts[f.id] > 0).length;
  const sections = groupNeedsMe(
    applyFilter(steady.shown, active),
    cockpit?.streams ?? [],
    cockpit?.projects ?? [],
  );
  const headed = sections.some((s) => s.kind === 'project');

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
              onChange={setFilter}
              items={FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => ({
                id: f.id,
                label: f.label,
                count: counts[f.id],
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
              {headed && section.kind !== 'knowledge' && (
                <h2 className="cr-inbox-section-hd">
                  <Icon name={section.kind === 'project' ? 'layers' : 'circle-dashed'} size={14} />
                  <span className="cr-inbox-section-name">{section.label}</span>
                  <span className="cr-inbox-section-count">{section.count}</span>
                </h2>
              )}
              {section.groups.map((group) => {
                const leaf = group.path.at(-1) ?? '';
                const parents = group.path.slice(0, -1);
                return (
                  <div className="cr-group" key={group.key} data-stream={group.key}>
                    {/* Knowledge that belongs to no node: its one group heads the section. */}
                    <h2
                      data-testid="inbox-group"
                      className={
                        headed && section.kind === 'knowledge' ? 'cr-inbox-section-hd' : undefined
                      }
                    >
                      {group.key === '' ? (
                        headed ? (
                          <>
                            <Icon name="book-open" size={14} />
                            <span className="cr-inbox-section-name">{leaf}</span>
                            <span className="cr-inbox-section-count">{section.count}</span>
                          </>
                        ) : (
                          <span className="cr-group-leaf">{leaf}</span>
                        )
                      ) : (
                        <button
                          type="button"
                          className="cr-group-link"
                          title={`Open ${leaf}`}
                          onClick={() => select(group.key)}
                        >
                          {parents.length > 0 && (
                            <span className="cr-group-parent">{`${nodePath(parents)}${PATH_SEP}`}</span>
                          )}
                          <span className="cr-group-leaf">{leaf}</span>
                          <Icon name="chevron-right" size={13} className="cr-group-chevron" />
                        </button>
                      )}
                    </h2>
                    {group.items.map((item) => (
                      <Card
                        key={item.id}
                        item={item}
                        onDone={onChanged}
                        onActing={steady.onActing}
                        gone={steady.gone(item.id)}
                      />
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
          <p className="cr-inbox-keys" aria-hidden="true">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> move between cards · <Kbd>A</Kbd>
            <Kbd>B</Kbd> pick a choice · <Kbd>Enter</Kbd> opens the node
          </p>
        </div>
      )}
    </section>
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
