/**
 * A node's page (T161, redesigned in T363 — design/cockpit-ui.md §1.3, §3,
 * §7): a conversation with its agent.
 *
 *  - **Header** (`NodeHeader`): path, title, status in words, role, repo and
 *    branch; one primary action by state (Start agent, Stop, Merge), the
 *    details toggle and the ⋯ menu with everything else.
 *  - **Overview** (T387, a project's root only, and its first tab): the
 *    project at a glance (`ProjectOverview`).
 *  - **Chat** (any other node's first tab): the goal, the thread as a conversation,
 *    "<Agent> is working…", then whatever needs you on this node (questions,
 *    gates, plans, proposals, proposed knowledge) as decision cards right
 *    above the composer. With a question open the composer answers it.
 *    Sending to a node whose agent isn't running starts it (T361).
 *  - **Changes / Plan / Activity / Knowledge / Docs** — only where they apply.
 *  - **Details** (`NodeDetails`, a panel on the right): Delivery, Agent,
 *    Children, Waits on, Tracker, Coordinator, Project, Findings, About.
 *
 * The chat pieces (`Chat.tsx`, `Composer.tsx`) know nothing about streams,
 * so the Director reuses them.
 */

import { type InboxItem, type SessionDefaultsStatus, isAgentRole } from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type RepoRow,
  addRepoToStream,
  answerQuestion,
  archiveStream,
  attachSession,
  closeStream,
  createStream,
  getSessionDefaults,
  getStreamPage,
  listRepos,
  resolveConflict,
  sayOnStream,
  stopSessions,
  unarchiveStream,
  updateStream,
  waitOnStream,
} from '../lib/api';
import {
  type NodeTab,
  agentLabel,
  agentName,
  agentStateText,
  answerTarget,
  chatAuthor,
  chatVariant,
  detailsOpenFrom,
  headerActions,
  liveAgentOf,
  nodeTabs,
  oneLine,
  openQuestions,
  sendIntent,
  vendorLabel,
} from '../lib/chat';
import { resolvedFor } from '../lib/defaults';
import { useFeed } from '../lib/feed-context';
import type { LandOutcome, StreamPagePayload } from '../lib/feed-types';
import { DEFAULT_RULES_FILTER } from '../lib/rules';
import { useShell } from '../lib/shell';
import type { StatusInput } from '../lib/status';
import { isLiveSession, isThinking } from '../lib/streams';
import { ChatScroll, MessageList, Thinking } from './Chat';
import { Composer, type ComposerHandle } from './Composer';
import { DeliveryPanel, isMergeable, outcomeTone, useDelivery } from './Delivery';
import { DiffView } from './DiffView';
import { Icon } from './Icon';
import { Card } from './Inbox';
import { Markdown } from './Markdown';
import {
  AboutSection,
  AgentSection,
  AutonomySection,
  ChildCards,
  DetailsPanel,
  FindingsSection,
  ProjectSection,
  TrackerSection,
  WaitsOnSection,
} from './NodeDetails';
import { type Crumb, NodeHeader } from './NodeHeader';
import { ActivityView, DocsView, KnowledgeView, PlanView } from './NodeViews';
import { ProjectOverview } from './ProjectOverview';
import { SessionPicker } from './SessionPicker';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  type MenuItem,
  Tabs,
  useCopy,
  useToast,
} from './ui';

// The Director (and older imports) read these from here.
export { THREAD_COLLAPSE_LINES, ThreadBody, isLongThreadBody } from './Chat';

/** Decision cards only: `blocked`/`done` are this page's own status and Merge button. */
function needsYou(items: readonly InboxItem[], stream: string, noChanges = false): InboxItem[] {
  // The header has Merge; T380: with nothing to merge, the card's Close is the move.
  return items.filter(
    (item) =>
      item.stream === stream && item.kind !== 'blocked' && (item.kind !== 'done' || noChanges),
  );
}

/** T205: the registered repos a proposal names, so its card can offer "Add <repo>" (§7). */
export function reposNamedIn(body: string, repos: readonly RepoRow[], current?: string): string[] {
  return repos
    .map((r) => r.name)
    .filter((name) => name !== current)
    .filter((name) =>
      new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(body),
    );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TAB_LABEL: Record<NodeTab, string> = {
  overview: 'Overview',
  thread: 'Chat',
  diff: 'Changes',
  plan: 'Plan',
  activity: 'Activity',
  rules: 'Knowledge',
  docs: 'Docs',
};

const DETAILS_KEY = 'agile.node.details';

/** The details panel's open state: remembered per viewer on a wide window, closed on a narrow one. */
function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(DETAILS_KEY);
    } catch {
      // Private mode or blocked storage: the default.
    }
    return detailsOpenFrom(stored, typeof window === 'undefined' ? 1440 : window.innerWidth);
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    if (typeof window !== 'undefined' && window.innerWidth < 1200) return;
    try {
      localStorage.setItem(DETAILS_KEY, next ? 'open' : 'closed');
    } catch {
      // Not remembered; it still toggles.
    }
  }, []);
  return [open, set];
}

type Picker = 'start' | 'restart' | 'reviewer' | 'resolve';
type Modal = 'repo' | 'wait' | 'close' | 'delete';

function PageSkeleton(): JSX.Element {
  return (
    <section className="cr-node" data-testid="stream-page" aria-busy="true">
      <div className="cr-node-main">
        <div className="cr-node-hd">
          <div className="cr-skel" style={{ width: 140, height: 10 }} />
          <div className="cr-skel" style={{ width: 280, height: 20, marginTop: 10 }} />
          <div className="cr-skel" style={{ width: 220, height: 10, marginTop: 10 }} />
        </div>
        <div className="cr-chat">
          <div className="cr-chat-col cr-skel-chat">
            <div className="cr-skel" style={{ width: '60%', height: 44 }} />
            <div className="cr-skel" style={{ width: '45%', height: 32, alignSelf: 'flex-end' }} />
            <div className="cr-skel" style={{ width: '75%', height: 64 }} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The node's goal, at the head of its conversation (long goals fold).
 * T385: Edit changes it in place; the agent reads the change on its thread.
 */
function GoalCard({
  goal,
  onSave,
}: {
  goal: string;
  onSave?: (goal: string) => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const long = goal.split('\n').length > 8 || goal.length > 700;
  const editing = draft !== undefined;
  const save = (): void => {
    const next = (draft ?? '').trim();
    if (!onSave || busy) return;
    if (next === '' || next === goal.trim()) {
      setDraft(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    onSave(next)
      .then(() => setDraft(undefined))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="cr-goal-card"
      data-testid="goal-card"
      data-folded={long && !open && !editing ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
    >
      <div className="cr-goal-label">
        <Icon name="scroll-text" size={13} />
        Goal
        {onSave && !editing && (
          <button
            type="button"
            className="cr-goal-edit"
            data-testid="goal-edit"
            title="Edit the goal"
            onClick={() => setDraft(goal)}
          >
            <Icon name="pencil" size={12} />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="cr-goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <textarea
            className="cr-goal-input"
            data-testid="goal-input"
            aria-label="Goal"
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
            // biome-ignore lint/a11y/noAutofocus: the user just asked to edit it.
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(undefined);
                setError(undefined);
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          {error && <p className="cr-field-error">{error}</p>}
          <div className="cr-goal-actions">
            <span className="cr-goal-hint">The agent reads the new goal on its next turn.</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" busy={busy} data-testid="goal-save">
              Save goal
            </Button>
          </div>
        </form>
      ) : (
        <Markdown className="cr-goal" text={goal} />
      )}
      {long && !editing && (
        <button
          type="button"
          className="cr-fold"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show all'}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
        </button>
      )}
    </div>
  );
}

export function StreamPage({ id }: { id: string }): JSX.Element {
  const { cockpit, refresh } = useFeed();
  const { openRules, select } = useShell();
  const toast = useToast();
  const copy = useCopy();
  const [page, setPage] = useState<StreamPagePayload | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // `undefined` is the node's own first tab (T387: a project root's Overview, else the chat).
  const [tab, setTab] = useState<NodeTab | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const drafts = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [picker, setPicker] = useState<Picker | undefined>(undefined);
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [repoChoice, setRepoChoice] = useState('');
  const [linkChoice, setLinkChoice] = useState('');
  // T332 (D33): "Branch off" — the thread line (0-based, whole thread) and the tangent's question.
  const [branching, setBranching] = useState<number | undefined>(undefined);
  const [tangentQuestion, setTangentQuestion] = useState('');
  // Which open question Send answers: an id, 'message' (a plain line), or undefined (the oldest).
  const [answerChoice, setAnswerChoice] = useState<string | undefined>(undefined);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [defaults, setDefaults] = useState<SessionDefaultsStatus | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const composer = useRef<ComposerHandle>(null);

  // Every pushed frame and every action re-reads the page, so reads
  // overlap, and their responses can arrive in any order. Only the latest
  // read may land: an older one resolving last would put back a stale page
  // (a worker still `starting` after it went `running`), and with the
  // session quiet no later frame would ever correct it.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    getStreamPage(id)
      .then((next) => {
        if (seq !== loadSeq.current) return;
        setPage(next);
        setLoadError(undefined);
      })
      .catch((err: unknown) => {
        if (seq !== loadSeq.current) return;
        setLoadError(errorText(err));
      });
  }, [id]);

  // A pushed cockpit frame follows every batch of events — a new thread
  // line, a session status, a finding — so it is the re-read trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` is the trigger, not an input.
  useEffect(() => {
    load();
  }, [load, cockpit]);

  useEffect(() => {
    listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  // A different node opened: back to its first tab, its own draft, nothing half-open.
  const lastId = useRef(id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the trigger.
  useEffect(() => {
    drafts.current.set(lastId.current, draft);
    lastId.current = id;
    setDraft(drafts.current.get(id) ?? '');
    setTab(undefined);
    setActionError(undefined);
    setPicker(undefined);
    setModal(undefined);
    setRepoChoice('');
    setLinkChoice('');
    setBranching(undefined);
    setTangentQuestion('');
    setAnswerChoice(undefined);
    setTrackerOpen(false);
    getSessionDefaults()
      .then(setDefaults)
      .catch(() => setDefaults(undefined));
  }, [id]);

  const onDeliveryResult = useCallback(
    (result: { outcome?: LandOutcome; refused?: string }) => {
      // The Delivery section says it; with the panel shut, a toast does.
      if (detailsOpen) return;
      if (result.refused !== undefined) {
        toast({ title: 'Merge refused', body: result.refused, tone: 'error' });
      } else if (result.outcome) {
        const tone = outcomeTone(result.outcome);
        toast({
          title: tone === 'ok' ? 'Delivered' : tone === 'info' ? 'Held' : 'Not merged',
          body: result.outcome.line,
          tone: tone === 'bad' ? 'error' : tone === 'ok' ? 'success' : 'info',
        });
      }
    },
    [detailsOpen, toast],
  );
  const onDeliveryChanged = useCallback(() => {
    load();
    refresh();
  }, [load, refresh]);
  const delivery = useDelivery(
    id,
    `${id}:${page?.stream.id === id ? page.stream.sessions.length : 0}`,
    onDeliveryChanged,
    onDeliveryResult,
  );

  const questionIds = openQuestions(cockpit?.inbox ?? [], id)
    .map((q) => q.id)
    .join(',');
  // A question arrives or goes: the composer goes back to answering the oldest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `questionIds` is the trigger.
  useEffect(() => {
    setAnswerChoice(undefined);
  }, [questionIds]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await fn();
        after?.();
      } catch (err) {
        setActionError(errorText(err));
      } finally {
        setBusy(false);
        load();
        refresh();
      }
    },
    [load, refresh],
  );

  const titleOf = useCallback(
    (nodeId: string) => cockpit?.streams.find((r) => r.id === nodeId)?.title ?? nodeId,
    [cockpit],
  );

  const threadTick = page?.thread_total ?? 0;

  if (loadError && !page) {
    return (
      <section className="cr-node" data-testid="stream-page">
        <div className="cr-node-main cr-node-failed">
          <EmptyState
            icon="alert-circle"
            title="Couldn’t open this node"
            actions={
              <>
                <Button icon="refresh" onClick={load}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={() => select(undefined)}>
                  Back to Needs me
                </Button>
              </>
            }
          >
            <span className="cr-error" role="alert">
              {loadError}
            </span>
          </EmptyState>
        </div>
      </section>
    );
  }
  if (!page || page.stream.id !== id) return <PageSkeleton />;

  // ---------------------------------------------------------------- derived state
  const { stream } = page;
  const rows = cockpit?.streams ?? [];
  const row = rows.find((r) => r.id === stream.id);
  const role = row?.role;
  const project = cockpit?.projects.find((p) => p.id === stream.project);
  const rootOf = cockpit?.projects.find((p) => p.root === stream.id);
  const children = rows.filter((r) => r.parent === stream.id);
  const open = stream.human.status !== 'landed' && stream.human.status !== 'closed';
  const merged = stream.human.status === 'landed';
  const live = stream.sessions.filter(isLiveSession);
  const liveAgent = liveAgentOf(stream.sessions);
  const liveReviewer = live.find((s) => s.role === 'reviewer');
  const agentWorking =
    liveAgent !== undefined && (liveAgent.status === 'starting' || liveAgent.status === 'running');
  const thinking = isThinking(stream);
  const hasRun = stream.sessions.some((s) => isAgentRole(s.role));
  // T361: a line starts an agent anywhere but a bare project root (Start agent still runs one there).
  const lineStarts = !(role === 'project' && children.length === 0);
  const waitingForPlan = row?.waiting_for_plan === true;
  // T174: human lines sent mid-turn, not yet delivered to the live worker.
  const queuedLines = new Set(live.flatMap((s) => s.queued ?? []));
  const cards = needsYou(cockpit?.inbox ?? [], stream.id, row?.nothing_to_merge === true);
  const questions = openQuestions(cockpit?.inbox ?? [], stream.id);
  const answering = answerTarget(questions, answerChoice);
  const answeringItem = questions.find((q) => q.id === answering);
  const name = agentName(stream.sessions);
  const resolved = defaults ? resolvedFor(defaults, stream.repo, project?.session) : undefined;
  const startWith = resolved ? agentLabel(resolved) : undefined;
  const statusInput: StatusInput = row ?? {
    agent_status: stream.agent.status,
    human_status: stream.human.status,
    ...(live.length > 0 ? { live: true as const } : {}),
  };
  const intent = sendIntent({
    open,
    merged,
    ...(answering !== undefined ? { answering } : {}),
    ...(liveAgent ? { live: { name: vendorLabel(liveAgent.vendor), working: agentWorking } } : {}),
    waitingForPlan,
    canStart: lineStarts,
    hasRun,
    ...(row?.stopped ? { stopped: true } : {}),
    ...(startWith ? { startWith } : {}),
  });
  const mergeable = isMergeable(page, delivery);
  const actions = headerActions({
    open,
    liveAgent: liveAgent !== undefined,
    anyLive: live.length > 0,
    anyBusy: live.some((s) => s.status === 'starting' || s.status === 'running'),
    canStart: !waitingForPlan,
    // T390: a project root's next step is a node, not its coordinator: Start stays plain there.
    startIsNext: rootOf === undefined && (!hasRun || row?.stopped === true),
    mergeable,
    landReady: page.land?.ready === true,
  });
  // T387: a project's root, known from the page itself (no parent, a project) before the frame names it.
  const projectRoot =
    rootOf !== undefined || (stream.parent === undefined && stream.project !== undefined);
  const tabs = nodeTabs({
    role,
    projectRoot,
    hasRepo: stream.repo !== undefined,
    hasChildren: children.length > 0,
    hasPlanItem: cards.some((c) => c.kind === 'plan_approve'),
    knowledge: page.rules.length,
    docs: page.docs.length,
  });
  const shownTab: NodeTab = tab !== undefined && tabs.includes(tab) ? tab : (tabs[0] ?? 'thread');
  const waits = stream.waits_on ?? [];
  const linkOptions = rows.filter((r) => r.id !== stream.id && !waits.some((w) => w.node === r.id));
  const chosenLink = linkChoice || linkOptions[0]?.id || '';
  const repoOptions = repos.map((r) => r.name).filter((n) => n !== stream.repo);
  const chosenRepo = repoChoice || repoOptions[0] || '';
  // T332 (D33): only a conversation branches off; its tangents are conversations too.
  const canBranch = open && role === 'conversation';
  const threadBase = page.thread_total - page.thread.length;
  const question = tangentQuestion.trim();
  const conversation = page.thread.some((e) => {
    const v = chatVariant(e);
    return v === 'you' || v === 'agent';
  });
  const isRoot = rootOf !== undefined || role === 'project';
  // "Waits on" holds a delivery: it applies where something merges.
  const canWait = role === 'work' || role === 'coordinating' || waits.length > 0;

  // The path: the node's ancestors, root first, each one opening its page.
  const crumbs: Crumb[] = [];
  {
    const seen = new Set<string>([stream.id]);
    let at = row?.parent !== undefined ? rows.find((r) => r.id === row.parent) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      crumbs.unshift({ id: at.id, title: at.title });
      const parent: string | undefined = at.parent;
      at = parent !== undefined ? rows.find((r) => r.id === parent) : undefined;
    }
    if (crumbs.length === 0 && row === undefined) {
      for (const title of page.path.slice(0, -1)) crumbs.push({ title });
    }
  }

  // ---------------------------------------------------------------- actions
  const branchOff = (line: number) =>
    act(async () => {
      const created = await createStream({
        title: question.split('\n')[0]?.slice(0, 80) || question,
        goal: question,
        parent: stream.id,
        seed_line: line,
      });
      setBranching(undefined);
      setTangentQuestion('');
      select(created.id);
    });

  function addRepo(repo: string, switching = false): void {
    void act(
      () => addRepoToStream(stream.id, repo, switching),
      () => setModal(undefined),
    );
  }

  const start = () => void act(() => attachSession(stream.id, 'worker'));
  const stop = () => void act(() => stopSessions(stream.id));
  const restart = (choice?: { vendor?: string; model?: string; effort?: string }) =>
    act(async () => {
      const previous = liveAgent;
      await stopSessions(stream.id);
      await attachSession(
        stream.id,
        'worker',
        choice ??
          (previous
            ? {
                vendor: previous.vendor,
                ...(previous.model !== 'default' ? { model: previous.model } : {}),
                ...(previous.effort ? { effort: previous.effort } : {}),
              }
            : {}),
      );
    });

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || intent.action === 'none') return;
    setSending(true);
    setActionError(undefined);
    try {
      if (intent.action === 'answer' && answering !== undefined) {
        await answerQuestion(answering, text);
      } else if (intent.action === 'start') {
        const said = await sayOnStream(stream.id, text, { start: true });
        if (said.started) toast({ title: `Started ${startWith ?? 'the agent'}`, tone: 'success' });
      } else {
        await sayOnStream(stream.id, text);
      }
      setDraft('');
      drafts.current.delete(stream.id);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setSending(false);
      load();
      refresh();
    }
  }

  async function deleteNode(): Promise<void> {
    const title = stream.title;
    const nodeId = stream.id;
    setBusy(true);
    try {
      await archiveStream(nodeId);
      setModal(undefined);
      refresh();
      select(undefined);
      toast({
        title: `Deleted “${title}”`,
        body: 'Its worktree and branch are kept.',
        tone: 'info',
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            unarchiveStream(nodeId)
              .then(() => {
                refresh();
                select(nodeId);
              })
              .catch((err: unknown) =>
                toast({ title: 'Could not restore it', body: errorText(err), tone: 'error' }),
              );
          },
        },
      });
    } catch (err) {
      setModal(undefined);
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const menu: MenuItem[] = [
    {
      label: 'Choose the model and start…',
      icon: 'sliders',
      testid: 'attach-choose',
      hidden: !open || live.length > 0 || waitingForPlan,
      onSelect: () => setPicker('start'),
    },
    {
      label: 'Restart agent',
      icon: 'refresh',
      testid: 'restart',
      title: 'Stop the agent and start a fresh session with the same model',
      hidden: !open || liveAgent === undefined,
      disabled: busy,
      onSelect: () => void restart(),
    },
    {
      label: 'Restart with another model…',
      icon: 'sliders',
      hidden: !open || liveAgent === undefined,
      disabled: busy,
      onSelect: () => setPicker('restart'),
    },
    {
      label: 'Review changes…',
      icon: 'eye',
      testid: 'review',
      title: 'A read-only reviewer reads the diff and reports findings',
      hidden: stream.repo === undefined,
      disabled: busy || liveReviewer !== undefined,
      onSelect: () => setPicker('reviewer'),
    },
    {
      label: 'Stop agent',
      icon: 'square',
      testid: 'menu-stop',
      hidden: live.length === 0,
      disabled: busy,
      onSelect: stop,
    },
    'separator',
    {
      label: 'Waits on…',
      icon: 'clock',
      testid: 'link-wait',
      title: "Hold this node's delivery until another node is merged",
      hidden: !open || !canWait,
      disabled: busy || linkOptions.length === 0,
      onSelect: () => setModal('wait'),
    },
    {
      label: 'Add repository…',
      icon: 'folder-git',
      testid: 'add-repo',
      title: 'Work on a repo here: a conversation becomes a work node, a second repo splits it',
      hidden: !open || stream.parent === undefined,
      disabled: busy || repoOptions.length === 0,
      onSelect: () => setModal('repo'),
    },
    {
      label: 'Tracker issue…',
      icon: 'ticket',
      testid: 'tracker-menu',
      hidden: project?.tracker === undefined || stream.external_link !== undefined,
      onSelect: () => {
        setDetailsOpen(true);
        setTrackerOpen(true);
      },
    },
    'separator',
    {
      label: 'Copy branch name',
      icon: 'git-branch',
      hidden: stream.branch === undefined,
      onSelect: () => copy(stream.branch ?? '', 'Copied the branch name'),
    },
    {
      label: 'Copy node id',
      icon: 'copy',
      onSelect: () => copy(stream.id, 'Copied the node id'),
    },
    'separator',
    {
      label: 'Close node…',
      icon: 'x-circle',
      testid: 'stream-close',
      hidden: !open,
      disabled: busy,
      onSelect: () => setModal('close'),
    },
    {
      label: 'Delete node…',
      icon: 'trash',
      testid: 'stream-delete',
      danger: true,
      hidden: isRoot,
      disabled: busy,
      onSelect: () => setModal('delete'),
    },
  ];

  // ---------------------------------------------------------------- the chat
  const renderActions = (entry: StreamPagePayload['thread'][number], i: number) =>
    canBranch && entry.kind === 'line' && branching !== threadBase + i ? (
      <button
        type="button"
        className="cr-msg-btn"
        data-testid="branch-off"
        title="Start a tangent from this line: a new conversation seeded with it"
        disabled={busy}
        onClick={() => {
          setBranching(threadBase + i);
          setTangentQuestion('');
        }}
      >
        <Icon name="git-fork" size={13} />
        Branch off
      </button>
    ) : null;

  const renderExtra = (entry: StreamPagePayload['thread'][number], i: number) => (
    <>
      {entry.kind === 'proposal' &&
        open &&
        reposNamedIn(entry.body, repos, stream.repo).length > 0 && (
          <div className="cr-msg-extra">
            {reposNamedIn(entry.body, repos, stream.repo).map((repoName) => (
              <Button
                key={repoName}
                size="sm"
                icon="plus"
                data-testid="proposal-add-repo"
                disabled={busy}
                onClick={() => addRepo(repoName)}
              >
                Add {repoName}
              </Button>
            ))}
          </div>
        )}
      {canBranch && branching === threadBase + i && (
        <form
          className="cr-branch-form"
          data-testid="branch-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (question) void branchOff(threadBase + i);
          }}
        >
          <div className="cr-branch-label">
            <Icon name="git-fork" size={13} />
            Branch off into a new conversation
          </div>
          <textarea
            data-testid="branch-question"
            aria-label="The tangent's question"
            placeholder="What should the tangent look into?"
            rows={2}
            // biome-ignore lint/a11y/noAutofocus: the form opens on a click, for typing at once.
            autoFocus
            value={tangentQuestion}
            onChange={(e) => setTangentQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setBranching(undefined);
            }}
          />
          <div className="cr-branch-actions">
            <Button size="sm" variant="ghost" onClick={() => setBranching(undefined)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              data-testid="branch-start"
              disabled={busy || !question}
            >
              Start tangent
            </Button>
          </div>
        </form>
      )}
      {entry.by === 'human' && entry.kind === 'line' && queuedLines.has(entry.ts) && (
        <div className="cr-queued" data-testid="thread-queued">
          <Icon name="clock" size={12} />
          Not sent yet — queued until {name}’s current step ends
        </div>
      )}
    </>
  );

  const answeringChip = answeringItem ? (
    <div className="cr-answering" data-testid="composer-answering">
      <Icon name="corner-down-left" size={13} />
      <span className="cr-answering-label">Answering</span>
      {questions.length > 1 ? (
        <Menu
          label="Which question"
          align="start"
          placement="top"
          testid="composer-answering-menu"
          trigger={(props) => (
            <button type="button" className="cr-answering-q" {...props}>
              {oneLine(answeringItem.detail ?? answeringItem.context)}
              <Icon name="chevron-down" size={12} />
            </button>
          )}
          items={[
            ...questions.map((q) => ({
              label: oneLine(q.detail ?? q.context, 70),
              icon: q.id === answering ? ('check' as const) : undefined,
              onSelect: () => {
                setAnswerChoice(q.id);
                composer.current?.focus();
              },
            })),
            'separator' as const,
            {
              label: 'Write a message instead',
              icon: 'message-square' as const,
              onSelect: () => {
                setAnswerChoice('message');
                composer.current?.focus();
              },
            },
          ]}
        />
      ) : (
        <span className="cr-answering-q" title={answeringItem.detail ?? answeringItem.context}>
          {oneLine(answeringItem.detail ?? answeringItem.context)}
        </span>
      )}
      <IconButton
        icon="x"
        size="sm"
        label="Write a message instead"
        data-testid="composer-answer-cancel"
        onClick={() => {
          setAnswerChoice('message');
          composer.current?.focus();
        }}
      />
    </div>
  ) : questions.length > 0 && open ? (
    <button
      type="button"
      className="cr-answering-off"
      data-testid="composer-answer-resume"
      onClick={() => {
        setAnswerChoice(undefined);
        composer.current?.focus();
      }}
    >
      <Icon name="corner-down-left" size={13} />
      Answer the open question instead
    </button>
  ) : undefined;

  const modelChip =
    liveAgent !== undefined ? (
      <span
        className="cr-model-chip"
        data-testid="composer-model"
        data-live="true"
        title={`Running: ${liveAgent.vendor}/${liveAgent.model}${liveAgent.effort ? ` · ${liveAgent.effort}` : ''}`}
      >
        <span className="cr-model-dot" aria-hidden="true" />
        {agentLabel(liveAgent)}
      </span>
    ) : startWith && open && !waitingForPlan ? (
      <button
        type="button"
        className="cr-model-chip"
        data-testid="composer-model"
        title="Choose the model and start the agent"
        onClick={() => setPicker('start')}
      >
        <Icon name="sparkles" size={12} />
        {startWith}
        <Icon name="chevron-down" size={12} />
      </button>
    ) : undefined;

  const emptyChat = !conversation && !thinking && cards.length === 0;

  const chat = (
    <div className="cr-chat" data-tab-body="thread">
      <ChatScroll
        tick={`${threadTick}:${thinking}:${cards.length}`}
        resetKey={stream.id}
        label="Conversation"
      >
        <GoalCard
          goal={stream.goal}
          {...(open
            ? {
                onSave: async (goal: string) => {
                  await updateStream(stream.id, { goal });
                  load();
                  refresh();
                },
              }
            : {})}
        />
        {page.thread_total > page.thread.length && (
          <p className="cr-chat-older">
            Showing the newest {page.thread.length} of {page.thread_total} lines.
          </p>
        )}
        <MessageList
          entries={page.thread}
          authorOf={(by) => chatAuthor(by, stream.sessions)}
          renderActions={renderActions}
          renderExtra={renderExtra}
          onOpenRule={(rule) => openRules({ ...DEFAULT_RULES_FILTER, rule })}
          openQuestions={new Set(questions.map((q) => q.id))}
        />
        {thinking && <Thinking name={name} />}
        {emptyChat && open && (
          <div className="cr-chat-empty" data-testid="chat-empty">
            <span className="cr-chat-empty-icon">
              <Icon name="sparkles" size={20} />
            </span>
            <div className="cr-chat-empty-title">
              {liveAgent
                ? `${name} is ready`
                : hasRun
                  ? 'Tell the agent what to do next'
                  : 'Tell the agent what to do'}
            </div>
            <p>
              {liveAgent
                ? 'Send it a message below.'
                : intent.action === 'start'
                  ? `Your message ${hasRun ? 'wakes' : 'starts'} it with ${startWith ?? 'the default model'}. The goal above is its brief.`
                  : intent.hint}
            </p>
          </div>
        )}
        <section
          className="cr-decisions"
          data-testid="stream-needs"
          aria-label="Needs you"
          hidden={cards.length === 0}
        >
          {cards.length > 0 && (
            <div className="cr-decisions-hd">
              <span className="cr-decisions-dot" aria-hidden="true" />
              {cards.length === 1 ? 'Waiting on you' : `${cards.length} things wait on you`}
            </div>
          )}
          {cards.map((item) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut only; the composer's "Answering" menu picks the question from the keyboard.
            <div
              key={item.id}
              className="cr-decision"
              data-answering={item.id === answering ? 'true' : undefined}
              onClick={(e) => {
                // A click on a question (not on one of its buttons) makes it the one Send answers.
                if (item.kind !== 'question' || item.id === answering) return;
                if ((e.target as Element).closest('button, a, input, textarea, select')) return;
                setAnswerChoice(item.id);
                composer.current?.focus();
              }}
            >
              <Card
                item={item}
                full
                onDone={() => {
                  load();
                  refresh();
                }}
              />
            </div>
          ))}
        </section>
      </ChatScroll>
      <div className="cr-chat-foot">
        <div className="cr-chat-col">
          <Composer
            ref={composer}
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            {...(agentWorking && open ? { onStop: stop } : {})}
            busy={sending}
            disabled={intent.action === 'none'}
            placeholder={intent.placeholder}
            hint={intent.hint}
            above={answeringChip}
            chip={modelChip}
            label={answeringItem ? 'Your answer' : 'Message the agent'}
            mode={intent.action === 'answer' ? 'answer' : undefined}
          />
        </div>
      </div>
    </div>
  );

  // ---------------------------------------------------------------- the page
  return (
    <section
      className="cr-node"
      data-testid="stream-page"
      data-stream={stream.id}
      data-details={detailsOpen ? 'open' : 'closed'}
    >
      <div className="cr-node-main">
        <NodeHeader
          title={stream.title}
          crumbs={crumbs}
          onOpen={select}
          status={statusInput}
          role={role}
          agentText={agentStateText({
            agent_status: stream.agent.status,
            human_status: stream.human.status,
            waiting_for_plan: waitingForPlan,
            live: live.length > 0,
            never_started: row?.never_started === true,
            stopped: row?.stopped === true,
          })}
          {...(stream.repo ? { repo: stream.repo } : {})}
          {...(stream.branch ? { branch: stream.branch } : {})}
          actions={actions}
          startLabel={hasRun ? 'Restart agent' : 'Start agent'}
          busy={busy}
          merging={delivery.busy}
          onStart={start}
          onChooseStart={() => setPicker('start')}
          onStop={stop}
          onMerge={() => void delivery.land()}
          {...(page.land && !page.land.ready && page.land.reason
            ? { mergeTitle: page.land.reason }
            : {})}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen(!detailsOpen)}
          menu={menu}
          {...(open && role !== 'project'
            ? {
                onRename: async (title: string) => {
                  await updateStream(stream.id, { title });
                  load();
                  refresh();
                },
              }
            : {})}
        >
          {actionError && (
            <div className="cr-node-error" role="alert" data-testid="stream-error">
              <Icon name="alert-circle" size={15} />
              <span>{actionError}</span>
              <IconButton
                icon="x"
                size="sm"
                label="Dismiss"
                onClick={() => setActionError(undefined)}
              />
            </div>
          )}
        </NodeHeader>
        <Tabs
          items={tabs.map((t) => ({
            id: t,
            label: TAB_LABEL[t],
            ...(t === 'rules' ? { count: page.rules.length } : {}),
            ...(t === 'docs' ? { count: page.docs.length } : {}),
          }))}
          value={shownTab}
          onChange={setTab}
          label="Stream views"
          className="cr-node-tabs"
        />
        <div className="cr-node-body" data-tab={shownTab}>
          {shownTab === 'thread' ? (
            chat
          ) : shownTab === 'overview' && stream.project !== undefined ? (
            <div className="cr-node-pane" data-tab-body="overview">
              <div className="cr-node-pane-col">
                <ProjectOverview
                  key={stream.id}
                  project={stream.project}
                  root={stream.id}
                  waiting={cards.length}
                  onOpenChat={() => setTab('thread')}
                  onEditRepos={() => {
                    // The project's repositories are a checklist in the details panel.
                    setDetailsOpen(true);
                    requestAnimationFrame(() =>
                      document
                        .querySelector('[data-testid="project-repos"]')
                        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
                    );
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="cr-node-pane">
              <div className="cr-node-pane-col">
                {shownTab === 'diff' &&
                  (stream.branch ? (
                    <DiffView id={stream.id} version={threadTick} />
                  ) : (
                    <div data-testid="diff-empty">
                      <EmptyState icon="file-diff" title="No changes yet">
                        This node gets its branch when its agent starts.
                      </EmptyState>
                    </div>
                  ))}
                {shownTab === 'activity' && (
                  <ActivityView id={stream.id} tick={cockpit} sessions={stream.sessions} />
                )}
                {shownTab === 'plan' && (
                  <PlanView id={stream.id} tick={cockpit} onChanged={refresh} titleOf={titleOf} />
                )}
                {shownTab === 'rules' && <KnowledgeView rules={page.rules} />}
                {shownTab === 'docs' && <DocsView docs={page.docs} />}
              </div>
            </div>
          )}
        </div>
      </div>

      {detailsOpen && (
        <DetailsPanel onClose={() => setDetailsOpen(false)}>
          <DeliveryPanel page={page} delivery={delivery} onResolve={() => setPicker('resolve')} />
          <AgentSection
            stream={stream}
            {...(liveAgent ? { live: liveAgent } : {})}
            {...(startWith ? { startWith } : {})}
            busy={busy}
            canReview={liveReviewer === undefined}
            {...(stream.repo !== undefined ? { onReview: () => setPicker('reviewer') } : {})}
            {...(open && !waitingForPlan
              ? { onChooseModel: () => setPicker(liveAgent ? 'restart' : 'start') }
              : {})}
          />
          <ChildCards
            cards={(cockpit?.cards ?? []).filter(
              (c) => rows.find((r) => r.id === c.node)?.parent === stream.id,
            )}
            titleOf={titleOf}
          />
          {canWait && (
            <WaitsOnSection
              stream={stream}
              open={open}
              busy={busy}
              act={act}
              titleOf={titleOf}
              canAdd={linkOptions.length > 0}
              onAdd={() => setModal('wait')}
            />
          )}
          <TrackerSection
            key={`tracker:${stream.id}`}
            stream={stream}
            project={project}
            rollup={page.rollup}
            busy={busy}
            act={act}
            opened={trackerOpen}
            setOpened={setTrackerOpen}
          />
          <AutonomySection stream={stream} role={role} project={project} busy={busy} act={act} />
          {rootOf && <ProjectSection key={rootOf.id} project={rootOf} busy={busy} act={act} />}
          <FindingsSection findings={stream.agent.findings ?? []} />
          <AboutSection stream={stream} role={role} />
        </DetailsPanel>
      )}
      {detailsOpen && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the panel closes with its own button too.
        <div className="cr-node-scrim" onClick={() => setDetailsOpen(false)} />
      )}

      {picker && (
        <SessionPicker
          key={picker}
          role={picker === 'reviewer' ? 'reviewer' : 'worker'}
          purpose={picker === 'reviewer' ? 'reviewer' : picker === 'resolve' ? 'resolve' : 'worker'}
          repo={stream.repo}
          {...(project?.session ? { project: project.session } : {})}
          busy={busy}
          onCancel={() => setPicker(undefined)}
          onStart={(choice) => {
            if (picker === 'resolve') {
              void act(
                () => resolveConflict(stream.id, choice),
                () => setPicker(undefined),
              );
              return;
            }
            if (picker === 'restart') {
              void restart(choice).then(() => setPicker(undefined));
              return;
            }
            void act(
              () => attachSession(stream.id, picker === 'reviewer' ? 'reviewer' : 'worker', choice),
              () => setPicker(undefined),
            );
          }}
        />
      )}

      <Dialog
        open={modal === 'wait'}
        onClose={() => setModal(undefined)}
        title="Wait on another node"
        description="This node’s merge is held until the node you pick is merged."
        size="sm"
        testid="link-wait-form"
        onSubmit={() => {
          if (chosenLink === '') return;
          void act(
            () => waitOnStream(stream.id, chosenLink),
            () => {
              setModal(undefined);
              setLinkChoice('');
            },
          );
        }}
        footer={
          <>
            <Button onClick={() => setModal(undefined)}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="link-wait-submit"
              disabled={busy || chosenLink === ''}
            >
              Wait on
            </Button>
          </>
        }
      >
        <Field label="Node" htmlFor="link-wait-select">
          <select
            id="link-wait-select"
            data-testid="link-wait-select"
            value={chosenLink}
            onChange={(e) => setLinkChoice(e.target.value)}
          >
            {linkOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </Field>
      </Dialog>

      <Dialog
        open={modal === 'repo'}
        onClose={() => setModal(undefined)}
        title="Add a repository"
        description={
          role === 'conversation'
            ? 'This conversation becomes a work node on the repo, with its own branch. The thread stays.'
            : 'A second repo splits this node: each repo gets a part, and this node coordinates them.'
        }
        size="sm"
        testid="add-repo-form"
        onSubmit={() => chosenRepo !== '' && addRepo(chosenRepo)}
        footer={
          <>
            {stream.branch !== undefined && (
              <Button
                data-testid="switch-repo-submit"
                title="Only when nothing is committed on this branch"
                disabled={busy || chosenRepo === ''}
                onClick={() => addRepo(chosenRepo, true)}
              >
                Switch to it
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              data-testid="add-repo-submit"
              disabled={busy || chosenRepo === ''}
            >
              Add
            </Button>
          </>
        }
      >
        <Field label="Repository" htmlFor="add-repo-select">
          <select
            id="add-repo-select"
            data-testid="add-repo-select"
            value={chosenRepo}
            onChange={(e) => setRepoChoice(e.target.value)}
          >
            {repoOptions.map((repoName) => (
              <option key={repoName} value={repoName}>
                {repoName}
              </option>
            ))}
          </select>
        </Field>
      </Dialog>

      <ConfirmDialog
        open={modal === 'close'}
        title={`Close “${stream.title}”?`}
        confirmLabel="Close node"
        busy={busy}
        testid="close-node"
        onCancel={() => setModal(undefined)}
        onConfirm={() =>
          void act(
            () => closeStream(stream.id),
            () => {
              setModal(undefined);
              toast({ title: 'Node closed', tone: 'success' });
            },
          )
        }
      >
        <p className="cr-confirm-text">
          Closing marks it done without merging. Its agent stops and it can’t be reopened. The
          branch and worktree stay.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={modal === 'delete'}
        title={`Delete “${stream.title}”?`}
        confirmLabel="Delete node"
        danger
        busy={busy}
        testid="delete-node"
        onCancel={() => setModal(undefined)}
        onConfirm={() => void deleteNode()}
      >
        <p className="cr-confirm-text">
          {children.length > 0
            ? `It and its ${children.length} sub-node${children.length === 1 ? '' : 's'} leave the tree, and their agents stop.`
            : 'It leaves the tree, and its agent stops.'}{' '}
          Worktrees and branches are kept, and you can undo this right after.
        </p>
      </ConfirmDialog>
    </section>
  );
}
