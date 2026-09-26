/**
 * Needs me (cockpit design §3, §9.1; design/cockpit-ui.md §7): everything
 * that waits on the human, across every node, answered in place. T364:
 * grouped by project, then by node, oldest first; a filter by what the item
 * wants (an answer, a decision, a merge); `j`/`k` move between cards and
 * Enter opens a card's node. Nothing waiting reads "all caught up" — or, on
 * a first run (no repository or no project yet), the three steps to get
 * going.
 *
 * The card itself is `DecisionCard.tsx`'s `Card`, re-exported here: the
 * node page renders it too (with `full`).
 */

import type { InboxItem } from '@agile-agents/shared';
import { useEffect, useRef, useState } from 'react';
import { useFeed } from '../lib/feed-context';
import {
  type NeedsMeFilter,
  type SetupStep,
  applyFilter,
  filterCounts,
  groupNeedsMe,
  isFirstRun,
  setupSteps,
} from '../lib/inbox';
import { isShortcut, useShell } from '../lib/shell';
import { Card } from './DecisionCard';
import { Icon, type IconName } from './Icon';
import { Button, EmptyState, Kbd, Segmented, Spinner } from './ui';

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
 * node. Never while typing (`isShortcut`), and Enter only when the card
 * itself has focus, so a focused button still presses.
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
      if (isShortcut(event, 'Enter') && at >= 0 && active === cards[at]) {
        const node = cards[at]?.dataset.nodeId;
        if (node) {
          event.preventDefault();
          open(node);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [list, open]);
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
  useMinuteTick();
  useCardKeys(list, select);

  const counts = filterCounts(items);
  // A filter emptied by answering its last item falls back to everything.
  const active = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const kinds = FILTERS.filter((f) => f.id !== 'all' && counts[f.id] > 0).length;
  const sections = groupNeedsMe(
    applyFilter(items, active),
    cockpit?.streams ?? [],
    cockpit?.projects ?? [],
  );
  const headed = sections.some((s) => s.kind === 'project');

  return (
    <section className="cr-inbox cr-needsme" data-testid="inbox">
      <header className="cr-page-hd cr-needsme-hd">
        <div className="cr-page-hd-main">
          <div className="cr-inbox-title">
            {/* T341: the view is "Needs me" in the sidebar and the walkthrough; its heading agrees. */}
            <h1 className="cr-page-title">Needs me</h1>
            {items.length > 0 && (
              <span className="cr-count" data-testid="inbox-count">
                {items.length}
              </span>
            )}
          </div>
        </div>
        {kinds > 1 && (
          <div className="cr-page-actions">
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
          </div>
        )}
      </header>

      {cockpit === undefined && items.length === 0 ? (
        <div className="cr-inbox-loading" data-testid="inbox-loading">
          <Spinner size={16} />
          Loading…
        </div>
      ) : items.length === 0 ? (
        <Empty />
      ) : (
        <div className="cr-inbox-list" ref={list}>
          {sections.map((section) => (
            <section
              className="cr-inbox-section"
              key={section.key}
              data-section={section.key}
              aria-label={section.label}
            >
              {headed && section.kind !== 'knowledge' && (
                <h2 className="cr-inbox-section-hd">
                  <Icon name={section.kind === 'project' ? 'folder' : 'layers'} size={14} />
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
                            <span className="cr-group-parent">{`${parents.join(' / ')} / `}</span>
                          )}
                          <span className="cr-group-leaf">{leaf}</span>
                          <Icon name="chevron-right" size={13} className="cr-group-chevron" />
                        </button>
                      )}
                    </h2>
                    {group.items.map((item) => (
                      <Card key={item.id} item={item} onDone={onChanged} />
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
          <p className="cr-inbox-keys" aria-hidden="true">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> move between cards · <Kbd>Enter</Kbd> opens the node
          </p>
        </div>
      )}
    </section>
  );
}

/** Nothing waits on you: all caught up — or, on a first run, the steps to get going. */
function Empty(): JSX.Element {
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
        title="You’re all caught up"
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

function Welcome({ steps }: { steps: readonly SetupStep[] }): JSX.Element {
  const { setView, setNewProjectOpen, setNewStreamOpen } = useShell();
  const next = steps.find((s) => !s.done)?.id;
  const started = steps.some((s) => s.done);
  const run: Record<SetupStep['id'], () => void> = {
    repo: () => setView('settings'),
    project: () => setNewProjectOpen(true),
    node: () => setNewStreamOpen(true),
  };
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
