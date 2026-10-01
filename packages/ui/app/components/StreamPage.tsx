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
 *    above the composer. T499: a question is answered in its own card; the
 *    composer sends messages only, and Quote puts selected text in either.
 *    Sending to a node whose agent isn't running starts it (T361).
 *  - **Changes / Plan / Activity / Knowledge / Docs** — only where they apply.
 *  - **Details** (`NodeDetails`, a panel on the right): Delivery, Agent,
 *    Children, Waits on, Tracker, Autonomy, Project, Findings, About.
 *  - T423: the composer's model chip is the one place a model is picked (the
 *    header's Start with… aside): a pick goes with the next message only.
 *
 * The chat pieces (`Chat.tsx`, `Composer.tsx`) know nothing about streams,
 * so the Director reuses them.
 */

import {
  type InboxItem,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
  isAgentRole,
} from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addRepoToStream,
  archiveStream,
  attachSession,
  closeStream,
  createStream,
  getSessionDefaults,
  getStreamPage,
  reopenStream,
  resolveConflict,
  sayOnStream,
  setNodeAutoClose,
  stopSessions,
  streamToTalk,
  unarchiveStream,
  updateStream,
  waitOnStream,
} from '../lib/api';
import { coordinatesIt, hasReplied, sendUpTarget, takeComposerFocus } from '../lib/ask';
import {
  type NodeTab,
  agentFailed,
  agentLabel,
  agentName,
  agentStateText,
  chatAuthor,
  chatVariant,
  detailsOpenFrom,
  headerActions,
  liveAgentOf,
  nodeTabs,
  openQuestions,
  placeQuestionThreads,
  proposedNext,
  questionIdOfRef,
  sendIntent,
  sessionIdText,
  showGoalCard,
  tidyIds,
  uncheckedWarning,
  vendorLabel,
  withQuestion,
  workingAs,
} from '../lib/chat';
import { useAgentCommands } from '../lib/commands';
import { choiceOf, keptChoice, modelChip, resolvedFor } from '../lib/defaults';
import { draftOf, useDraftSetter } from '../lib/drafts';
import {
  type MergeFix,
  type MergeRefusal,
  RECONNECTING,
  SEND_UNREACHABLE,
  isNetworkMessage,
  mergeConflict,
  mergeRefusal,
  writeFailure,
} from '../lib/errors';
import { useFeed } from '../lib/feed-context';
import type { LandOutcome, StreamPagePayload } from '../lib/feed-types';
import { proposalLineAction } from '../lib/inbox';
import { withQuote } from '../lib/quote';
import { appendToDraft, roomAfter, useReview } from '../lib/review';
import { DEFAULT_RULES_FILTER } from '../lib/rules';
import { useShell } from '../lib/shell';
import { type StatusInput, ownStatusKey, partsSummary } from '../lib/status';
import { groupSteps, turnStartedAt } from '../lib/steps';
import { isLiveSession, isThinking } from '../lib/streams';
import { splitRepos, titleFromGoal } from '../lib/tree';
import {
  ChatScroll,
  ContextMeter,
  MessageList,
  QuestionThreadView,
  QuoteSelection,
  StepsFold,
  Thinking,
  useSteps,
} from './Chat';
import { type NodeCommands, useNodeCommands } from './CommandPalette';
import { type ComposerHandle, DraftComposer } from './Composer';
import { addReviewToDraft, quoteIntoAnswer, useMergeAsk } from './DecisionCard';
import { DeliveryPanel, isMergeable, outcomeTone, useDelivery } from './Delivery';
import { TabBoundary, lazyNamed } from './ErrorBoundary';
import { Icon, type IconName } from './Icon';
import { Card } from './Inbox';
import { Markdown } from './Markdown';
import { ModelChoiceSection } from './ModelPolicy';
import { useRepoList } from './NewStream';
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
import { type PickOption, PickerField } from './Pickers';
import { SendUpDialog } from './SendUp';
import { EffortChip, ModelChip, SessionPicker, nextEffort } from './SessionPicker';
import { MoveDialog, RenameDialog } from './StreamTree';
import { TurnIntoWorkDialog } from './TurnIntoWork';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  type MenuItem,
  RepoIcon,
  Tabs,
  UncheckedMark,
  repoKindLabel,
  useCopy,
  useToast,
} from './ui';

// T394: loaded on demand; a throw in any tab stays in that tab (`TabBoundary`).
const DiffView = lazyNamed(() => import('./DiffView'), 'DiffView');
const ProjectOverview = lazyNamed(() => import('./ProjectOverview'), 'ProjectOverview');
// T413: Activity and Knowledge read as the Events and Knowledge screens, with their rows.
const loadNodeViews = () => import('./NodeViews');
const ActivityView = lazyNamed(loadNodeViews, 'ActivityView');
const PlanView = lazyNamed(loadNodeViews, 'PlanView');
const KnowledgeView = lazyNamed(loadNodeViews, 'KnowledgeView');
const DocsView = lazyNamed(loadNodeViews, 'DocsView');

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

/** T416: the tabs' glyphs, for "Open Changes" and the like in ⌘K's "This node". */
const TAB_ICON: Record<NodeTab, IconName> = {
  overview: 'layers',
  thread: 'message-square',
  diff: 'file-diff',
  plan: 'list',
  activity: 'activity',
  rules: 'book-open',
  docs: 'file-text',
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

/** T445 (audit r7 #21): the Plan tab's "Ask it to plan", as your message to the node. */
const PLAN_REQUEST =
  'Please write the plan: split the work into parts, say which paths each part owns, and the contracts between them.';

/**
 * T445 (audit r7 #26): a project root's composer with no agent running. It
 * holds whether a line there adds a note or starts the root's agent.
 */
const ROOT_PLACEHOLDER = 'Write to the project — or press A to ask it a question';

type Picker = 'start' | 'reviewer' | 'resolve';
type Modal = 'repo' | 'wait' | 'close' | 'delete' | 'rename' | 'move' | 'talk';

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
            title={goal === '' ? 'Set the goal' : 'Edit the goal'}
            onClick={() => setDraft(goal)}
          >
            <Icon name="pencil" size={12} />
            {goal === '' ? 'Set a goal' : 'Edit'}
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
      ) : goal === '' ? (
        <p className="cr-goal cr-goal-none" data-testid="goal-none">
          No goal yet. The agent talks it through with you; set a goal when you know what it is, and
          finishing it then counts.
        </p>
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
  const { cockpit, refresh, offline } = useFeed();
  const { openRules, select, tab, setTab, openAsk, openNewStream } = useShell();
  const toast = useToast();
  const copy = useCopy();
  const [page, setPage] = useState<StreamPagePayload | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // `tab` (the shell's, in the URL: T436 #21) is `undefined` for the node's own first tab (T387:
  // a project root's Overview, else the chat); T403: a Needs me card asks for the chat.
  // T436 (#11): the draft is kept per node, across a reload too (`lib/drafts.ts`).
  // T447 (audit r7 #15): the page writes the draft but doesn't hold it: `DraftComposer` does, so a
  // keystroke re-renders the composer alone, not this page and its chat.
  const setDraft = useDraftSetter(id);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // T416 (finding 7): a failed send says so under the composer, with Retry; the draft stays.
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  // T416 (finding 6): a refused merge says why under the header's Merge, with the fix it names.
  const [mergeError, setMergeError] = useState<MergeRefusal | undefined>(undefined);
  const [mergeNote, setMergeNote] = useState<string | undefined>(undefined);
  const [fixing, setFixing] = useState(false);
  const mergeTarget = useRef('main');
  const mergeAsk = useMergeAsk();
  // T416 (finding 21): the header's and the ⋯ menu's actions, for ⌘K's "This node".
  const commands = useRef<NodeCommands | undefined>(undefined);
  useNodeCommands(useCallback(() => commands.current, []));
  const [picker, setPicker] = useState<Picker | undefined>(undefined);
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  // T445 (audit r7 #23): every repository, with its kind, for Add repository…'s picker.
  const repos = useRepoList();
  const [repoChoice, setRepoChoice] = useState('');
  const [linkChoice, setLinkChoice] = useState('');
  // T332 (D33): "Branch off" — the thread line (0-based, whole thread) and the tangent's question.
  const [branching, setBranching] = useState<number | undefined>(undefined);
  // T421 (D42): Send to parent's dialog, with the words it starts from.
  const [sendingUp, setSendingUp] = useState<string | undefined>(undefined);
  // T422 (D42): Turn into work's dialog.
  const [turning, setTurning] = useState(false);
  const [tangentQuestion, setTangentQuestion] = useState('');
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [defaults, setDefaults] = useState<SessionDefaultsStatus | undefined>(undefined);
  // T423: the composer chip's pick for the next message only (undefined: the default, or what runs).
  const [nextSession, setNextSession] = useState<ResolvedSessionDefaults | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const composer = useRef<ComposerHandle>(null);
  // T499: the chat, where a selection offers Quote.
  const chatRef = useRef<HTMLDivElement>(null);
  // T393: review comments on the Changes tab (counted on its tab).
  const reviewCount = useReview(id).comments.length;
  // T392: the agent's steps, live.
  const agentSteps = useSteps(id);
  // T461: the live agent's slash commands, for the composer's `/` menu.
  const agentCommands = useAgentCommands(
    id,
    page?.stream.id === id ? liveAgentOf(page.stream.sessions)?.id : undefined,
  );

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

  // T435 (#20): Ask just opened this conversation: its composer takes focus once it shows.
  const shownId = page?.stream.id;
  useEffect(() => {
    if (shownId === id && takeComposerFocus(id)) {
      requestAnimationFrame(() => composer.current?.focus());
    }
  }, [shownId, id]);

  // A different node opened: nothing half-open (its tab is the shell's, its draft its own).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the trigger.
  useEffect(() => {
    setActionError(undefined);
    setSendError(undefined);
    setMergeError(undefined);
    setMergeNote(undefined);
    setPicker(undefined);
    setModal(undefined);
    setRepoChoice('');
    setLinkChoice('');
    setBranching(undefined);
    setTangentQuestion('');
    setTrackerOpen(false);
    setNextSession(undefined);
    getSessionDefaults()
      .then(setDefaults)
      .catch(() => setDefaults(undefined));
  }, [id]);

  const onDeliveryResult = useCallback(
    (result: { outcome?: LandOutcome; refused?: string }) => {
      // T416 (finding 6): a refusal is said under the header's Merge, where it was pressed,
      // in words and with the fix it names; never a toast over the composer.
      const outcome = result.outcome;
      if (result.refused !== undefined) {
        setMergeError(
          mergeRefusal(
            isNetworkMessage(result.refused)
              ? 'Couldn’t reach the daemon; nothing was merged.'
              : result.refused,
            mergeTarget.current,
          ),
        );
        return;
      }
      if (outcome?.status === 'blocked') {
        setMergeError(mergeConflict(outcome.target, outcome.conflicts));
        return;
      }
      if (outcome?.status === 'refused' && !outcome.held) {
        setMergeError(mergeRefusal(outcome.reason, mergeTarget.current));
        return;
      }
      // Good news and holds: the Delivery section says it; with the panel shut, a toast does.
      if (detailsOpen || !outcome) return;
      const tone = outcomeTone(outcome);
      toast({
        title: tone === 'ok' ? 'Delivered' : tone === 'info' ? 'Held' : 'Not merged',
        // T413: a branch by its name, no ids.
        body: tidyIds(outcome.line),
        tone: tone === 'bad' ? 'error' : tone === 'ok' ? 'success' : 'info',
      });
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
    commands.current = undefined;
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
  if (!page || page.stream.id !== id) {
    commands.current = undefined;
    return <PageSkeleton />;
  }

  // ---------------------------------------------------------------- derived state
  const { stream } = page;
  const rows = cockpit?.streams ?? [];
  const row = rows.find((r) => r.id === stream.id);
  const role = row?.role;
  // T421 (D42): a conversation can send what it concludes to the node it sits under;
  // T435 (#19): not to a merged or closed one, where nothing acts on it.
  const sendUpTo = sendUpTarget({ role, parent: stream.parent }, rows);
  const parentRow =
    stream.parent !== undefined ? rows.find((r) => r.id === stream.parent) : undefined;
  const grandparentRow =
    parentRow?.parent !== undefined ? rows.find((r) => r.id === parentRow.parent) : undefined;
  const project = cockpit?.projects.find((p) => p.id === stream.project);
  const rootOf = cockpit?.projects.find((p) => p.root === stream.id);
  const children = rows.filter((r) => r.parent === stream.id);
  const open = stream.human.status !== 'landed' && stream.human.status !== 'closed';
  const merged = stream.human.status === 'landed';
  // T471: closed is inactive, not read-only: Reopen (or a message) brings it back.
  const closedNode = stream.human.status === 'closed' && stream.archived !== true;
  const live = stream.sessions.filter(isLiveSession);
  const liveAgent = liveAgentOf(stream.sessions);
  const liveReviewer = live.find((s) => s.role === 'reviewer');
  const agentWorking =
    liveAgent !== undefined && (liveAgent.status === 'starting' || liveAgent.status === 'running');
  const thinking = isThinking(stream);
  const hasRun = stream.sessions.some((s) => isAgentRole(s.role));
  // T361: a line starts an agent anywhere; T443: a project's root too (its coordinator, parts or
  // not). Only a parentless single stream with no project waits for Start agent.
  const lineStarts = !(role === 'project' && children.length === 0 && stream.project === undefined);
  const waitingForPlan = row?.waiting_for_plan === true;
  // T174: human lines sent mid-turn, not yet delivered to the live worker.
  const queuedLines = new Set(live.flatMap((s) => s.queued ?? []));
  const cards = needsYou(cockpit?.inbox ?? [], stream.id, row?.nothing_to_merge === true);
  const questions = openQuestions(cockpit?.inbox ?? [], stream.id);
  const name = agentName(stream.sessions);
  const byDefaults = defaults ? resolvedFor(defaults, stream.repo, project?.session) : undefined;
  // T464: a node that has run starts again on what it last ran; the defaults choose only for
  // a node that never ran. Every "starts as" below names this.
  const kept = byDefaults
    ? keptChoice(stream.sessions, byDefaults.effort, defaults?.not_installed)
    : undefined;
  // T482: a start the policy picks for (a node that never ran, or a choose-again) runs its pick.
  const routed = page.next_pick;
  const resolved = routed
    ? { vendor: routed.vendor, model: routed.model, effort: routed.effort }
    : (kept ?? byDefaults);
  // T423: what the live agent runs, and the chip: the next message's model (a pick lasts one
  // message). It picks only where a line starts (or restarts) the agent; elsewhere it only names
  // what runs. Picking never starts anything by itself.
  const canPick = open && !waitingForPlan && lineStarts;
  const running = liveAgent ? choiceOf(liveAgent, resolved?.effort ?? 'low') : undefined;
  const chip = resolved
    ? modelChip({
        fallback: resolved,
        ...(running ? { live: running } : {}),
        ...(nextSession && canPick ? { chosen: nextSession } : {}),
      })
    : undefined;
  const pending = chip?.pending;
  // What a start by the header's Start agent runs: what the node last ran, else the default.
  // A line starts with the chip's pick.
  // T483: under Choose with a key, Jev picks at the start; the routed pick is only its fallback.
  const defaultLabel = resolved
    ? routed?.chooses === true
      ? `the model Jev picks (${agentLabel(resolved)} if it can’t)`
      : agentLabel(resolved)
    : undefined;
  const startWith = pending && !liveAgent ? agentLabel(pending) : defaultLabel;
  // T505: Details → Agent warns for the agent that runs, else the one a start runs.
  const agentWarning = uncheckedWarning(liveAgent?.vendor ?? resolved?.vendor);
  const statusInput: StatusInput = row ?? {
    agent_status: stream.agent.status,
    human_status: stream.human.status,
    ...(live.length > 0 ? { live: true as const } : {}),
  };
  // T447 (audit r7 #2): a coordinating node's parts in one line: "2 of 4 merged · waiting for web part".
  const partsLine = partsSummary(row?.parts);
  const intent = sendIntent({
    open,
    merged,
    ...(liveAgent ? { live: { name: vendorLabel(liveAgent.vendor), working: agentWorking } } : {}),
    waitingForPlan,
    canStart: lineStarts,
    hasRun,
    ...(row?.stopped ? { stopped: true } : {}),
    ...(startWith ? { startWith } : {}),
    ...(pending && liveAgent ? { restartWith: agentLabel(pending) } : {}),
  });
  const mergeable = isMergeable(page, delivery);
  // T436 (audit r6 #24): a reviewer reads commits; until the branch has some there is nothing to review.
  const hasCommits = stream.repo !== undefined && (page.land?.ahead ?? 0) > 0;
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
    decisionOpen: cards.length > 0,
  });
  // T435 (#16): an answered conversation's next step is what follows from its answer — Turn into
  // work…, Send to <parent> — not Restart agent, which would ask its question again (⋯ keeps it).
  const convoNext = open && hasReplied(role, page.thread) && actions.agent !== 'stop';
  const shownActions: typeof actions = convoNext ? { merge: actions.merge } : actions;
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
  // T445 (audit r7 #23): the project's repositories first, as New node lists them.
  const { inProject: projectRepos, others: otherRepos } = splitRepos(
    repos.filter((r) => r.name !== stream.repo),
    project?.repos,
  );
  const repoOptions = [...projectRepos, ...otherRepos].map((r) => r.name);
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
        // T425: cut at a word like New node's; the cheap model names it better (D41).
        title: titleFromGoal(question) || question.slice(0, 60),
        goal: question,
        parent: stream.id,
        seed_line: line,
        auto_title: true,
      });
      setBranching(undefined);
      setTangentQuestion('');
      select(created.id);
    });

  /** T445: scrolls to one of this node's decision cards and puts focus on its first action. */
  function showCard(id: string): void {
    const card = document.querySelector<HTMLElement>(
      `[data-testid="stream-needs"] .cr-card[data-id="${CSS.escape(id)}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.querySelector<HTMLButtonElement>('.cr-card-ft button:not(:disabled)')?.focus({
      preventScroll: true,
    });
    // A moment's ring, so the eye finds it too (a focus a click moved shows none).
    card.dataset.flash = 'true';
    setTimeout(() => delete card.dataset.flash, 1200);
  }

  function addRepo(repo: string, switching = false): void {
    void act(
      () => addRepoToStream(stream.id, repo, switching),
      () => setModal(undefined),
    );
  }

  const start = () => void act(() => attachSession(stream.id, 'worker'));
  const stop = () => void act(() => stopSessions(stream.id));
  // ⋯ Restart agent: a fresh session with the same model.
  const restart = () =>
    act(async () => {
      const previous = liveAgent;
      await stopSessions(stream.id);
      await attachSession(
        stream.id,
        'worker',
        previous
          ? {
              vendor: previous.vendor,
              ...(previous.model !== 'default' ? { model: previous.model } : {}),
              ...(previous.effort ? { effort: previous.effort } : {}),
            }
          : {},
      );
    });

  async function send(): Promise<void> {
    const text = draftOf(stream.id).trim();
    if (!text || intent.action === 'none') return;
    if (offline) {
      setSendError(SEND_UNREACHABLE);
      return;
    }
    setSending(true);
    setActionError(undefined);
    setSendError(undefined);
    try {
      // T423: the chip's pick goes with this line only: it starts the agent with it, or
      // restarts the live one with it (stop, then a start the line is the first prompt of).
      const session = pending
        ? {
            vendor: pending.vendor,
            ...(pending.model !== undefined ? { model: pending.model } : {}),
            effort: pending.effort,
          }
        : undefined;
      if (intent.action === 'restart' && session) {
        await stopSessions(stream.id);
        const said = await sayOnStream(stream.id, text, { start: true, session });
        if (said.started)
          toast({ title: `Restarted with ${agentLabel(session)}`, tone: 'success' });
        setNextSession(undefined);
      } else if (intent.action === 'start') {
        const said = await sayOnStream(stream.id, text, {
          start: true,
          ...(session ? { session } : {}),
        });
        if (said.started) toast({ title: `Started ${startWith ?? 'the agent'}`, tone: 'success' });
        setNextSession(undefined);
      } else {
        await sayOnStream(stream.id, text);
      }
      setDraft('');
    } catch (err) {
      // T416 (finding 7): under the composer, in words, with Retry; the draft stays as typed.
      setSendError(writeFailure(err));
    } finally {
      setSending(false);
      load();
      refresh();
    }
  }

  // T416 (finding 38): the first Merge asks, remembered per browser.
  mergeTarget.current = page.land?.target ?? 'main';
  const merge = (): void => {
    setMergeError(undefined);
    setMergeNote(undefined);
    mergeAsk.ask(
      {
        node: stream.title,
        id: stream.id,
        // T436 (#11): unsent review comments join the draft, and the chat opens on it.
        onAddReview: () => {
          addReviewToDraft(stream.id)
            .then((result) => {
              setTab(result === 'added' ? 'thread' : 'diff');
              if (result === 'added') requestAnimationFrame(() => composer.current?.focusEnd());
            })
            .catch(() => setTab('diff'));
        },
        ...(page.land?.target !== undefined ? { target: page.land.target } : {}),
        ...(row?.diff_stat !== undefined ? { files: row.diff_stat.files } : {}),
        pr:
          stream.delivery_state?.mode === 'pr' ||
          cockpit?.repos.find((r) => r.name === stream.repo)?.delivery === 'pr',
      },
      () => void delivery.land(),
    );
  };

  /** The fix a refused merge named: a prepared message to the agent, or stopping it. */
  async function applyFix(fix: MergeFix): Promise<void> {
    setFixing(true);
    try {
      if (fix.kind === 'stop') {
        await stopSessions(stream.id);
        setMergeNote('The agent is stopped. Merge again when you’re ready.');
      } else {
        await sayOnStream(stream.id, fix.message, { start: true });
        setMergeNote('Sent to the agent. Merge again once it says the branch is ready.');
      }
      setMergeError(undefined);
    } catch (err) {
      setMergeError((before) =>
        before
          ? { ...before, text: writeFailure(err, 'Couldn’t reach the daemon; nothing was sent.') }
          : before,
      );
    } finally {
      setFixing(false);
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
        title: `Moved “${title}” to the trash`,
        body: 'Its worktree and branch are kept until you delete it forever.',
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

  // T471: Reopen: open again on the same branch and worktree; its agent wakes with your next message.
  async function reopen(): Promise<void> {
    setBusy(true);
    try {
      await reopenStream(stream.id);
      toast({ title: 'Reopened', body: 'Your next message wakes its agent.', tone: 'success' });
      composer.current?.focus();
    } catch (err) {
      toast({ title: 'Couldn’t reopen it', body: errorText(err), tone: 'error' });
    } finally {
      setBusy(false);
      load();
      refresh();
    }
  }
  // T478: this node closes itself when its goal is met; the operator's, while it is open.
  const changeAutoClose = open
    ? async (on: boolean) => {
        try {
          await setNodeAutoClose(stream.id, on);
        } catch (err) {
          toast({ title: 'Couldn’t change auto-close', body: errorText(err), tone: 'error' });
        }
        load();
        refresh();
      }
    : undefined;
  const menu: MenuItem[] = [
    {
      // T421 (D42): what this conversation concluded, to the node it is about.
      label: sendUpTo !== undefined ? `Send to ${sendUpTo.title}…` : 'Send to parent…',
      icon: 'send',
      testid: 'send-up',
      title: 'Send a conclusion up: it arrives there as your message, and its agent acts on it',
      hidden: sendUpTo === undefined,
      onSelect: () => setSendingUp(lastAgentLine(page.thread) ?? ''),
    },
    {
      // T422 (D42): what the conversation concluded becomes the work, here.
      label: 'Turn into work…',
      icon: 'play',
      testid: 'turn-into-work-menu',
      title: 'State the goal (drafted from the talk), pick a repository or none, and start',
      hidden: !open || role !== 'conversation',
      onSelect: () => setTurning(true),
    },
    {
      // T419 (D42): a question about this node, in its own thread.
      label: 'Ask about this…',
      icon: 'message-square',
      testid: 'ask-about',
      title: 'A conversation under this node, in its own thread (A)',
      onSelect: () => openAsk(stream.id),
    },
    {
      label: 'Restart agent',
      icon: 'refresh',
      testid: 'restart',
      title: liveAgent
        ? 'Stop the agent and start a fresh session with the same model'
        : 'Start a fresh session: it answers the question again',
      // T435 (#16): an answered conversation's header offers what follows instead.
      hidden: !open || (liveAgent === undefined && !convoNext),
      disabled: busy,
      onSelect: () => (liveAgent ? void restart() : start()),
    },
    {
      // T413: "Review" is what you do on the Changes tab; this starts a reviewer agent.
      label: 'Ask an agent to review…',
      icon: 'eye',
      testid: 'review',
      title: hasCommits
        ? 'A read-only reviewer agent reads the diff and reports findings'
        : 'Nothing to review yet: the branch has no commits',
      // T438: shown from the first render once there is a branch, and disabled until its commits
      // are known, so the menu never grows under the pointer while the page's merge check loads.
      hidden: stream.repo === undefined || stream.branch === undefined,
      disabled: busy || liveReviewer !== undefined || !hasCommits,
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
      title:
        role === 'coordinating'
          ? 'Add a part on another repository'
          : 'Work on a repo here: a conversation becomes a work node, a second repo splits it',
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
      // T445 (audit r7 #22): the rail row's Rename and Move to…, here and in ⌘K's "This node".
      label: 'Rename…',
      icon: 'pencil',
      testid: 'menu-rename',
      hidden: !open || projectRoot,
      disabled: busy || row === undefined,
      onSelect: () => setModal('rename'),
    },
    {
      label: 'Move to…',
      icon: 'corner-down-right',
      testid: 'menu-move',
      hidden: projectRoot,
      disabled: busy || row === undefined,
      onSelect: () => setModal('move'),
    },
    {
      // T478: the Details switch, from the menu.
      label: stream.auto_close === true ? 'Turn off auto-close' : 'Close when its goal is met',
      icon: 'check-circle',
      testid: 'menu-auto-close',
      hidden: projectRoot || changeAutoClose === undefined,
      disabled: busy,
      onSelect: () => void changeAutoClose?.(stream.auto_close !== true),
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
      // T473: work and talk are one kind of node; switching is one step either way.
      label: 'Back to just talk…',
      icon: 'message-square',
      testid: 'menu-to-talk',
      hidden: !open || role !== 'work' || stream.helper_of !== undefined,
      disabled: busy,
      onSelect: () => setModal('talk'),
    },
    {
      label: `Back to work on ${stream.parked?.repo ?? ''}`,
      icon: 'git-branch',
      testid: 'menu-to-work',
      hidden: !open || role !== 'conversation' || stream.parked === undefined,
      disabled: busy,
      onSelect: () => {
        const parked = stream.parked;
        if (parked === undefined) return;
        void act(
          () => addRepoToStream(stream.id, parked.repo),
          () => toast({ title: `Back to work on ${parked.repo}`, tone: 'success' }),
        );
      },
    },
    {
      label: 'Reopen',
      icon: 'undo',
      testid: 'menu-reopen',
      hidden: !closedNode,
      disabled: busy,
      onSelect: () => void reopen(),
    },
    {
      label: 'Close node…',
      icon: 'x-circle',
      testid: 'stream-close',
      hidden: !open,
      disabled: busy,
      onSelect: () => setModal('close'),
    },
    {
      label: 'Move to trash…',
      icon: 'trash',
      testid: 'stream-delete',
      danger: true,
      hidden: isRoot,
      disabled: busy,
      onSelect: () => setModal('delete'),
    },
  ];

  // T416 (finding 21): ⌘K's "This node" — the header's own buttons, the other tabs, then the
  // ⋯ menu — the same items (and the same handlers), so the palette never decides anything itself.
  const headerItems: MenuItem[] = [
    {
      label: 'Merge',
      icon: 'git-merge',
      hidden: !actions.merge,
      disabled: delivery.busy || offline,
      onSelect: merge,
    },
    {
      label: hasRun ? 'Restart agent' : 'Start agent',
      icon: 'play',
      hidden: shownActions.agent !== 'start',
      disabled: busy || offline,
      onSelect: start,
    },
    {
      // T423: the split button's other half, the one place to start with another model.
      label: 'Start with…',
      icon: 'sliders',
      hidden: shownActions.agent !== 'start',
      disabled: busy || offline,
      onSelect: () => setPicker('start'),
    },
    {
      label: 'Stop agent',
      icon: 'square',
      hidden: actions.agent !== 'stop',
      disabled: busy || offline,
      onSelect: stop,
    },
    ...tabs
      .filter((t) => t !== shownTab)
      .map(
        (t): MenuItem => ({
          label: `Open ${TAB_LABEL[t]}`,
          icon: TAB_ICON[t],
          onSelect: () => setTab(t),
        }),
      ),
    {
      label: detailsOpen ? 'Hide details' : 'Show details',
      icon: 'panel-right',
      onSelect: () => setDetailsOpen(!detailsOpen),
    },
  ];
  commands.current = { node: stream.id, title: stream.title, items: [...headerItems, ...menu] };

  // ---------------------------------------------------------------- the chat
  // T502 (D62): each question is its thread: nested under the line that asked it, its other
  // lines out of the main flow. D63: on a coordinator's chat each child's question is a thread,
  // with the coordinator's own lines it caused (its notes) nested under it.
  const questionThreads = placeQuestionThreads(page.question_threads ?? [], page.thread);
  const childThreads = page.child_questions ?? [];
  const childNotes = placeQuestionThreads(childThreads, page.thread, { notesOnly: true });
  const lineAt = new Map(page.thread.map((e) => [e.ts, e]));
  const linesAt = (ts: readonly string[]) =>
    ts.flatMap((t) => {
      const e = lineAt.get(t);
      return e ? [e] : [];
    });
  /** The thread lines the main flow shows (by index into `page.thread`). */
  const shownLines = page.thread.flatMap((e, i) =>
    questionThreads.nested.has(e.ts) || childNotes.nested.has(e.ts) ? [] : [i],
  );
  const renderActions = (entry: StreamPagePayload['thread'][number], i: number) => (
    <>
      {canBranch && entry.kind === 'line' && branching !== threadBase + i && (
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
      )}
      {sendUpTo !== undefined && entry.kind === 'line' && entry.by.startsWith('agent:') && (
        // T421 (D42): this reply, sent up to the node the conversation is about.
        <button
          type="button"
          className="cr-msg-btn"
          data-testid="send-up-line"
          title={`Send this to ${sendUpTo.title}: it arrives there as your message`}
          onClick={() => setSendingUp(entry.body)}
        >
          <Icon name="send" size={13} />
          Send to {sendUpTo.title}
        </button>
      )}
    </>
  );

  const renderExtra = (entry: StreamPagePayload['thread'][number], i: number) => (
    <>
      {(() => {
        // T502 (D62): a question is its thread, nested under the line that asked it.
        const thread = questionThreads.hostOf.get(entry.ts);
        return thread ? (
          <QuestionThreadView
            thread={thread}
            lines={linesAt(questionThreads.linesOf.get(thread) ?? [])}
            authorOf={(by) => chatAuthor(by, stream.sessions)}
          />
        ) : null;
      })()}
      {open &&
        (() => {
          // T427: what a worker proposes next is one click from being a node. T435 (#14): next
          // to this one, on its repository — under it, this node would coordinate it (New node's
          // Parent picker can still nest it).
          const next = proposedNext(entry);
          return next ? (
            <div className="cr-msg-extra">
              <Button
                size="sm"
                icon="plus"
                data-testid="proposal-create-node"
                title={`Open New node with its title and goal, next to ${stream.title}`}
                onClick={() =>
                  openNewStream({
                    ...(stream.parent !== undefined
                      ? { parent: stream.parent }
                      : stream.project !== undefined
                        ? { project: stream.project }
                        : {}),
                    title: next.title,
                    goal: next.goal,
                    ...(stream.repo !== undefined ? { repo: stream.repo } : {}),
                  })
                }
              >
                Create node…
              </Button>
            </div>
          ) : null;
        })()}
      {open &&
        (() => {
          // T445 (audit r7 #3): only a line that proposes a repo (its `ref`) offers + Repo; an
          // autonomy proposal points to its card below, a contract proposal to the plan.
          const action = proposalLineAction(entry, {
            repos: repos.map((r) => r.name),
            current: stream.repo,
            // T455: once added, a split node holds the repo in a part; the button goes.
            partRepos: children.flatMap((c) =>
              c.repo !== undefined && c.human_status !== 'closed' ? [c.repo] : [],
            ),
            projectRoot,
            cards: cards.map((c) => c.id),
            hasPlan: tabs.includes('plan'),
          });
          if (action === undefined) return null;
          return (
            <div className="cr-msg-extra">
              {action.kind === 'add_repo' ? (
                <Button
                  size="sm"
                  icon="plus"
                  data-testid="proposal-add-repo"
                  disabled={busy}
                  onClick={() => addRepo(action.repo)}
                >
                  Add {action.repo}
                </Button>
              ) : action.kind === 'decide' ? (
                <Button
                  size="sm"
                  icon="arrow-down"
                  data-testid="proposal-decide"
                  title="Apply or dismiss it on its card, above the composer"
                  onClick={() => showCard(action.card)}
                >
                  Decide below
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon="list"
                  data-testid="proposal-see-plan"
                  onClick={() => setTab('plan')}
                >
                  See the plan
                </Button>
              )}
            </div>
          );
        })()}
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

  // T468: the effort on the right of the bar, stepped by a click or Shift+Tab; a pick for the
  // next message, as the model chip's is.
  const stepEffort =
    canPick && chip
      ? () => {
          const shown = chip.shows;
          setNextSession({ ...(nextSession ?? shown), effort: nextEffort(shown.effort) });
        }
      : undefined;
  const effortChipEl =
    stepEffort && chip ? (
      <EffortChip
        value={chip.shows.effort}
        vendor={chip.shows.vendor}
        chosen={chip.pending !== undefined && chip.pending.effort !== (running ?? resolved)?.effort}
        onStep={stepEffort}
      />
    ) : undefined;
  // T411: the live agent's context window, when its vendor reports it (the row's agent is this one).
  const context =
    liveAgent !== undefined && row?.live_agent?.role === liveAgent.role
      ? row.live_agent.context
      : undefined;
  // T505: the chip's agent runs shell commands that nothing checks (Codex, Grok, Antigravity):
  // an amber mark beside it, the sentence its tooltip.
  const chipWarning = uncheckedWarning(
    canPick && chip && resolved ? chip.shows.vendor : liveAgent?.vendor,
  );
  const modelChipBare =
    canPick && chip && resolved ? (
      <ModelChip
        status={defaults}
        chip={chip}
        {...(running ? { running } : {})}
        fallback={resolved}
        onPick={setNextSession}
        onReset={() => setNextSession(undefined)}
        modelOnly
      />
    ) : liveAgent !== undefined ? (
      <span
        className="cr-model-chip"
        data-testid="composer-model"
        data-live="true"
        title={`Running ${sessionIdText(liveAgent)}`}
      >
        <span className="cr-model-dot" aria-hidden="true" />
        <span className="cr-model-chip-text">{agentLabel(liveAgent)}</span>
      </span>
    ) : undefined;
  const modelChipEl =
    modelChipBare && chipWarning !== undefined ? (
      <>
        {modelChipBare}
        <UncheckedMark warning={chipWarning} testid="composer-unchecked" />
      </>
    ) : (
      modelChipBare
    );

  // T385: the goal changes in place. T413: not as a card when it only repeats the title (or on a
  // project's root, whose goal is its name); the details panel's About keeps it and its Edit then.
  const saveGoal = open
    ? async (goal: string) => {
        await updateStream(stream.id, { goal });
        load();
        refresh();
      }
    : undefined;
  // T419 (D42): a conversation shows its goal as your first message, so it never has the card.
  const goalCard =
    role !== 'conversation' &&
    showGoalCard({ goal: stream.goal, title: stream.title, projectRoot });

  // T445 (audit r7 #26): a project's root with no agent: Ask (A) is how to question the project.
  const askFirst = projectRoot && open && liveAgent === undefined;
  // T438 (audit r6 #4): under a failure's warning, "Tell the agent what to do" would contradict it.
  const emptyChat =
    !conversation &&
    !thinking &&
    cards.length === 0 &&
    childThreads.length === 0 &&
    !agentFailed(page.thread);
  // The open questions whose own line the chat shows (an older one may be above the loaded lines).
  const askedInChat = new Set(
    page.thread
      .filter((e) => e.kind === 'question')
      .map((e) => questionIdOfRef(e.ref))
      .filter((q): q is string => q !== undefined),
  );
  // T392: each reply's steps fold before it; the running turn's show live.
  const steps = groupSteps(agentSteps.steps, page.thread, {
    live: thinking,
    truncated: page.thread_total > page.thread.length,
    partial: agentSteps.partial,
  });
  // T419 (D42): a conversation's goal is the question you asked: your first message. T435 (#10):
  // in the thread's own list (one day divider), after "Node created".
  // T441: one turned into work keeps the question it was asked (the record's `question`).
  const asked = stream.question ?? (role === 'conversation' ? stream.goal : undefined);
  const listed = withQuestion(
    shownLines.map((i) => page.thread[i] as StreamPagePayload['thread'][number]),
    asked !== undefined && asked.trim() !== ''
      ? { ts: stream.created_at, by: 'human', kind: 'line' as const, body: asked }
      : undefined,
  );
  // T502: a list index back to the whole loaded thread's (a question thread's lines are nested).
  const threadIndexOf = (i: number): number | undefined => {
    const at = listed.threadIndex(i);
    return at === undefined ? undefined : shownLines[at];
  };
  const shownAt = new Map(shownLines.map((at, i) => [at, i]));
  const listSteps = new Map(
    [...steps.before].flatMap(([i, led]) => {
      const at = shownAt.get(i);
      return at === undefined ? [] : [[listed.listIndex(at), led] as const];
    }),
  );

  const chat = (
    <div className="cr-chat" data-tab-body="thread" ref={chatRef}>
      <ChatScroll
        tick={`${threadTick}:${thinking}:${cards.length}`}
        resetKey={stream.id}
        label="Conversation"
      >
        {goalCard && (
          <GoalCard goal={stream.goal ?? ''} {...(saveGoal ? { onSave: saveGoal } : {})} />
        )}
        {page.thread_total > page.thread.length && (
          <p className="cr-chat-older">
            Showing the newest {page.thread.length} of {page.thread_total} lines.
          </p>
        )}
        <MessageList
          entries={listed.entries}
          authorOf={(by) => chatAuthor(by, stream.sessions)}
          renderActions={(entry, i) => {
            const at = threadIndexOf(i);
            return at === undefined ? null : renderActions(entry, at);
          }}
          renderExtra={(entry, i) => {
            const at = threadIndexOf(i);
            return at === undefined ? null : renderExtra(entry, at);
          }}
          entryAttrs={(_, i) =>
            i === listed.at
              ? { 'data-testid': 'chat-question', 'data-question': 'true' }
              : undefined
          }
          onOpenRule={(rule) => openRules({ ...DEFAULT_RULES_FILTER, rule })}
          openQuestions={new Set(questions.map((q) => q.id))}
          steps={listSteps}
          windowKey={stream.id}
        />
        {thinking && (
          <Thinking
            {...workingAs(stream.sessions)}
            steps={steps.current}
            since={turnStartedAt(page.thread, steps.current)}
          />
        )}
        {!thinking && steps.current.length > 0 && (
          <div className="cr-steps-tail">
            <StepsFold steps={steps.current} />
          </div>
        )}
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
                  ? `Your message ${hasRun ? 'wakes' : 'starts'} it with ${startWith ?? 'the default model'}.${goalCard ? ' The goal above is its brief.' : ''}`
                  : intent.hint}
            </p>
            {askFirst && (
              // T445 (audit r7 #26): a question about the project goes in its own thread.
              <Button
                size="sm"
                icon="message-square"
                data-testid="chat-empty-ask"
                title="A conversation under the project, in its own thread (A)"
                onClick={() => openAsk(stream.id)}
              >
                Ask the project a question
              </Button>
            )}
          </div>
        )}
        {childThreads.length > 0 && (
          // T502 (D63): each part's question as a thread, one row each; its node answers it.
          <section
            className="cr-child-questions"
            data-testid="child-questions"
            aria-label="Questions from the parts"
          >
            <div className="cr-child-questions-hd">
              <Icon name="help-circle" size={13} />
              {childThreads.length === 1
                ? 'A question from a part'
                : `${childThreads.length} questions from the parts`}
            </div>
            {childThreads.map((thread) => (
              <QuestionThreadView
                key={thread.question}
                testid="child-question-thread"
                thread={thread}
                lines={linesAt(childNotes.linesOf.get(thread) ?? [])}
                authorOf={(by) => chatAuthor(by, stream.sessions)}
                head={
                  <div className="cr-qthread-head">
                    <button
                      type="button"
                      className="cr-link cr-qthread-node"
                      data-testid="child-question-open"
                      title={`Open ${thread.node_title ?? 'the part'}’s chat`}
                      onClick={() => select(thread.stream, { tab: 'thread' })}
                    >
                      {thread.node_title ?? 'A part'}
                    </button>
                    <p className="cr-qthread-text" title={thread.text}>
                      {thread.text.replace(/\s+/g, ' ').trim()}
                    </p>
                  </div>
                }
              />
            ))}
          </section>
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
            <Card
              key={item.id}
              item={item}
              full
              // T416 (finding 12): the chat's line above reads the question; the card
              // repeats a line of it only to tell several apart (T499: whole, once you reply).
              {...(item.kind === 'question' && askedInChat.has(item.id)
                ? { questionText: questions.length > 1 ? ('line' as const) : ('none' as const) }
                : {})}
              onDone={() => {
                load();
                refresh();
              }}
            />
          ))}
        </section>
      </ChatScroll>
      {intent.action !== 'none' && (
        // T499: a selection in a question (its card or its line) quotes into its answer box;
        // anywhere else in the chat, into the composer.
        <QuoteSelection
          scope={chatRef}
          onQuote={(text, question) => {
            if (question !== undefined) {
              quoteIntoAnswer(question, text);
              return;
            }
            setDraft((before) => withQuote(before, text));
            requestAnimationFrame(() => composer.current?.focusEnd());
          }}
        />
      )}
      <div className="cr-chat-foot">
        <div className="cr-chat-col">
          <DraftComposer
            ref={composer}
            node={stream.id}
            onSend={() => void send()}
            {...(agentWorking && open ? { onStop: stop } : {})}
            busy={sending}
            disabled={intent.action === 'none'}
            placeholder={askFirst ? ROOT_PLACEHOLDER : intent.placeholder}
            hint={intent.hint}
            chip={
              context !== undefined ? (
                <>
                  {modelChipEl}
                  <ContextMeter context={context} />
                </>
              ) : (
                modelChipEl
              )
            }
            {...(effortChipEl ? { effort: effortChipEl } : {})}
            {...(stepEffort && effortChipEl ? { onShiftTab: stepEffort } : {})}
            label="Message the agent"
            {...(offline ? { sendBlocked: RECONNECTING } : {})}
            {...(intent.action !== 'none'
              ? {
                  slash: {
                    running: agentCommands.running,
                    commands: agentCommands.commands,
                    ...((liveAgent?.vendor ?? pending?.vendor ?? resolved?.vendor)
                      ? { vendor: liveAgent?.vendor ?? pending?.vendor ?? resolved?.vendor }
                      : {}),
                  },
                  onSlash: agentCommands.refresh,
                }
              : {})}
            after={(draft) =>
              sendError && (
                <div className="cr-send-error" role="alert" data-testid="send-error">
                  <Icon name="alert-circle" size={14} />
                  <span>{sendError}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    data-testid="send-retry"
                    busy={sending}
                    disabled={offline || draft.trim() === ''}
                    title={offline ? RECONNECTING : 'Send it again'}
                    onClick={() => void send()}
                  >
                    Retry
                  </Button>
                  <IconButton
                    icon="x"
                    size="sm"
                    label="Dismiss"
                    onClick={() => setSendError(undefined)}
                  />
                </div>
              )
            }
          />
        </div>
      </div>
    </div>
  );

  // T445 (audit r7 #21): the Plan tab's empty state gets the plan written. A coordinator never
  // started (a project's root is one, T443) starts, its brief asking for the plan; one that ran
  // is asked for it.
  const planStart =
    open && liveAgent === undefined && !waitingForPlan && (role === 'coordinating' || isRoot)
      ? !hasRun
        ? { label: 'Start the coordinator', busy, onStart: start }
        : {
            label: 'Ask it to plan',
            busy,
            onStart: () => void act(() => sayOnStream(stream.id, PLAN_REQUEST, { start: true })),
          }
      : undefined;

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
          {...(partsLine !== undefined ? { parts: partsLine } : {})}
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
          actions={shownActions}
          {...(convoNext
            ? {
                extra: (
                  <>
                    {sendUpTo !== undefined && (
                      <Button
                        icon="send"
                        className="cr-send-up-btn"
                        data-testid="header-send-up"
                        disabled={offline}
                        title={
                          offline
                            ? RECONNECTING
                            : `Send its last reply to ${sendUpTo.title}: it arrives there as your message`
                        }
                        onClick={() => setSendingUp(lastAgentLine(page.thread) ?? '')}
                      >
                        <span className="cr-btn-clip">Send to {sendUpTo.title}</span>
                      </Button>
                    )}
                    <Button
                      icon="play"
                      data-testid="header-turn-into-work"
                      disabled={offline}
                      title={
                        offline
                          ? RECONNECTING
                          : 'State the goal (drafted from the talk), pick a repository or none, and start'
                      }
                      onClick={() => setTurning(true)}
                    >
                      Turn into work…
                    </Button>
                  </>
                ),
              }
            : closedNode
              ? {
                  extra: (
                    <Button
                      icon="undo"
                      variant="primary"
                      data-testid="header-reopen"
                      busy={busy}
                      disabled={offline}
                      title={
                        offline
                          ? RECONNECTING
                          : 'Open it again on the same branch and worktree; your next message wakes its agent'
                      }
                      onClick={() => void reopen()}
                    >
                      Reopen
                    </Button>
                  ),
                }
              : {})}
          startLabel={hasRun ? 'Restart agent' : 'Start agent'}
          busy={busy}
          merging={delivery.busy}
          offline={offline}
          onStart={start}
          onChooseStart={() => setPicker('start')}
          onStop={stop}
          onMerge={merge}
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
          {mergeError && (
            <div className="cr-node-error cr-merge-error" role="alert" data-testid="merge-error">
              <Icon name="alert-circle" size={15} />
              <span>
                <strong>Couldn’t merge.</strong> {mergeError.text}
              </span>
              {mergeError.fix && (
                <Button
                  size="sm"
                  icon={mergeError.fix.kind === 'stop' ? 'square' : 'send'}
                  data-testid="merge-fix"
                  data-fix={mergeError.fix.kind}
                  busy={fixing}
                  disabled={offline}
                  title={
                    offline
                      ? RECONNECTING
                      : mergeError.fix.kind === 'stop'
                        ? undefined
                        : mergeError.fix.message
                  }
                  onClick={() => {
                    const fix = mergeError.fix;
                    if (fix) void applyFix(fix);
                  }}
                >
                  {mergeError.fix.label}
                </Button>
              )}
              <IconButton
                icon="x"
                size="sm"
                label="Dismiss"
                onClick={() => setMergeError(undefined)}
              />
            </div>
          )}
          {mergeNote && !mergeError && (
            <output className="cr-node-note" data-testid="merge-note">
              <Icon name="check" size={15} />
              <span>{mergeNote}</span>
              <IconButton
                icon="x"
                size="sm"
                label="Dismiss"
                onClick={() => setMergeNote(undefined)}
              />
            </output>
          )}
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
            // T426: the count on Changes is your review comments, not its files: it says so.
            ...(t === 'diff' && reviewCount > 0
              ? {
                  count: reviewCount,
                  countOf: {
                    icon: 'message-square' as const,
                    title: `${reviewCount} review ${reviewCount === 1 ? 'comment' : 'comments'} not sent yet`,
                  },
                }
              : {}),
          }))}
          value={shownTab}
          // T436 (#21): the first tab is the plain node link; any other is `&tab=` in the URL.
          onChange={(t) => setTab(t === tabs[0] ? undefined : t)}
          label="Node views"
          className="cr-node-tabs"
        />
        <TabBoundary tab={shownTab} node={stream.id}>
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
                    <DiffView
                      id={stream.id}
                      version={threadTick}
                      {...(intent.action !== 'none'
                        ? {
                            // T393: the review joins the draft; the chat opens on it, unsent.
                            onAddToMessage: (text: string) => {
                              setDraft((before) => appendToDraft(before, text));
                              setTab('thread');
                              requestAnimationFrame(() => composer.current?.focusEnd());
                            },
                            room: roomAfter(draftOf(stream.id)),
                          }
                        : {})}
                    />
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
                  <PlanView
                    id={stream.id}
                    tick={cockpit}
                    onChanged={refresh}
                    titleOf={titleOf}
                    running={liveAgent !== undefined}
                    {...(planStart ? { start: planStart } : {})}
                  />
                )}
                {shownTab === 'rules' && (
                  <KnowledgeView node={stream} rules={page.rules} onChanged={load} />
                )}
                {shownTab === 'docs' && <DocsView docs={page.docs} />}
              </div>
            </div>
          )}
        </TabBoundary>
      </div>

      {detailsOpen && (
        <DetailsPanel onClose={() => setDetailsOpen(false)}>
          <DeliveryPanel
            page={page}
            delivery={delivery}
            onResolve={() => setPicker('resolve')}
            status={ownStatusKey(statusInput)}
          />
          <AgentSection
            stream={stream}
            {...(liveAgent ? { live: liveAgent } : {})}
            {...(defaultLabel ? { startWith: defaultLabel } : {})}
            {...(agentWarning !== undefined ? { warning: agentWarning } : {})}
            busy={busy}
            canReview={liveReviewer === undefined}
            {...(hasCommits ? { onReview: () => setPicker('reviewer') } : {})}
          />
          {/* T482: who picks this node's model at a start, and how it was picked. */}
          <ModelChoiceSection
            key={`model-choice:${stream.id}`}
            stream={stream}
            {...((rootOf?.id ?? stream.project) !== undefined
              ? { projectId: (rootOf?.id ?? stream.project) as string }
              : {})}
            isRoot={rootOf !== undefined}
          />
          {/* T413: every child, by the status words used everywhere; a root's Overview lists them. */}
          {!projectRoot && <ChildCards parent={stream.id} cards={cockpit?.cards ?? []} />}
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
          <AboutSection
            stream={stream}
            role={role}
            {...(goalCard ? {} : { goal: saveGoal ? { onSave: saveGoal } : {} })}
            {...(projectRoot
              ? {}
              : { autoClose: changeAutoClose ? { onChange: changeAutoClose } : {} })}
          />
        </DetailsPanel>
      )}
      {detailsOpen && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the panel closes with its own button too.
        <div className="cr-node-scrim" onClick={() => setDetailsOpen(false)} />
      )}

      {turning && (
        <TurnIntoWorkDialog
          node={stream.id}
          title={stream.title}
          goal={stream.goal ?? stream.question ?? stream.title}
          repos={cockpit?.repos ?? []}
          {...(project ? { project } : {})}
          {...(parentRow ? { parent: parentRow } : {})}
          {...(grandparentRow ? { grandparent: grandparentRow } : {})}
          {...(sendUpTo !== undefined
            ? {
                onSendUp: () => {
                  setTurning(false);
                  setSendingUp(lastAgentLine(page.thread) ?? '');
                },
              }
            : {})}
          onClose={() => setTurning(false)}
          onDone={({ repo, where }) => {
            setTurning(false);
            load();
            refresh();
            toast({
              tone: 'success',
              title: repo
                ? where === 'next-to' && parentRow
                  ? `Now a work node on ${repo}, next to ${parentRow.title}`
                  : `Now a work node on ${repo}`
                : 'Now researching its goal',
              duration: 4000,
            });
          }}
        />
      )}
      {sendingUp !== undefined && sendUpTo !== undefined && (
        <SendUpDialog
          node={stream.id}
          parentTitle={sendUpTo.title}
          initial={sendingUp}
          onClose={() => setSendingUp(undefined)}
          onSent={(parent) => {
            setSendingUp(undefined);
            load();
            refresh();
            toast({
              tone: 'success',
              title: `Sent to ${sendUpTo.title}`,
              duration: 5000,
              action: { label: 'Open it', onClick: () => select(parent, { tab: 'thread' }) },
            });
          }}
        />
      )}
      {picker && (
        <SessionPicker
          key={picker}
          role={picker === 'reviewer' ? 'reviewer' : 'worker'}
          purpose={picker === 'reviewer' ? 'reviewer' : picker === 'resolve' ? 'resolve' : 'worker'}
          repo={stream.repo}
          {...(project?.session ? { project: project.session } : {})}
          {...(picker === 'start' && hasRun ? { submitLabel: 'Restart agent' } : {})}
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
          role === 'conversation' ? (
            <>
              This conversation becomes a work node on the repo, with its own branch. The thread
              stays.
              {coordinatesIt(parentRow) !== undefined && (
                // T435 (#3): under a work node, that node then coordinates it.
                <>
                  {' '}
                  <span data-testid="add-repo-coordinates">{coordinatesIt(parentRow)}</span>
                </>
              )}
            </>
          ) : role === 'coordinating' ? (
            // T445 (audit r7 #23): a coordinating node gains a part; it isn't split again.
            <span data-testid="add-repo-part">
              Adds a part on {chosenRepo || 'the repository you pick'}, under this node, which
              coordinates it.
            </span>
          ) : (
            'A second repo splits this node: each repo gets a part, and this node coordinates them.'
          )
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
        <Field label="Repository">
          {/* T445 (audit r7 #23): the searchable picker every other repository choice uses. */}
          <PickerField
            testid="add-repo-select"
            label="Repository"
            value={chosenRepo}
            display={
              chosenRepo ? (
                <>
                  <RepoIcon remote={repos.find((r) => r.name === chosenRepo)?.remote} size={14} />
                  <span className="cr-pickfield-text">{chosenRepo}</span>
                  <span className="cr-pickfield-sub">
                    {repoKindLabel(repos.find((r) => r.name === chosenRepo)?.remote)}
                  </span>
                </>
              ) : (
                <span className="cr-pickfield-text">Pick a repository</span>
              )
            }
            options={[
              ...projectRepos.map(
                (r): PickOption => ({
                  value: r.name,
                  text: r.name,
                  icon: <RepoIcon remote={r.remote} size={14} />,
                  sub: repoKindLabel(r.remote),
                  group: `In ${project?.name ?? 'this project'}`,
                  attrs: { 'data-repo': r.name },
                }),
              ),
              ...otherRepos.map(
                (r): PickOption => ({
                  value: r.name,
                  text: r.name,
                  icon: <RepoIcon remote={r.remote} size={14} />,
                  sub: repoKindLabel(r.remote),
                  group: projectRepos.length > 0 ? 'Other repositories' : 'Repositories',
                  attrs: { 'data-repo': r.name },
                }),
              ),
            ]}
            placeholder="Search repositories…"
            search={repoOptions.length > 6}
            onPick={setRepoChoice}
          />
        </Field>
      </Dialog>
      {modal === 'rename' && row !== undefined && (
        // T445 (audit r7 #22): the rail's own dialogs, from the header's ⋯ menu and ⌘K.
        <RenameDialog
          row={row}
          onClose={() => {
            setModal(undefined);
            load();
          }}
        />
      )}
      {modal === 'move' && row !== undefined && (
        <MoveDialog
          row={row}
          rows={rows}
          projectName={project?.name}
          onClose={() => {
            setModal(undefined);
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={modal === 'talk'}
        title={`Back to just talking in “${stream.title}”?`}
        confirmLabel="Back to talk"
        busy={busy}
        testid="to-talk"
        onCancel={() => setModal(undefined)}
        onConfirm={() =>
          void act(
            () => streamToTalk(stream.id),
            () => {
              setModal(undefined);
              toast({
                title: 'Back to talking',
                body: `Its work on ${stream.repo ?? 'the repository'} is kept; pick that repository again to carry on.`,
                tone: 'success',
              });
            },
          )
        }
      >
        <p className="cr-confirm-text">
          Its agent stops. Its branch, commits and worktree stay as they are; the conversation
          carries on without a repository, and its next agent reads and researches rather than
          edits.
        </p>
      </ConfirmDialog>

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
          Closing puts it away without merging: it leaves Needs me and its agent stops. A message or
          Reopen brings it back; the branch and worktree stay.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={modal === 'delete'}
        title={`Move “${stream.title}” to the trash?`}
        confirmLabel="Move to trash"
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
          Worktrees and branches are kept. Restore it from Trash at the foot of the sidebar.
        </p>
      </ConfirmDialog>
      {mergeAsk.dialog}
    </section>
  );
}

/** T421: the conversation's last reply, where Send to parent starts. */
function lastAgentLine(thread: StreamPagePayload['thread']): string | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i];
    if (e !== undefined && e.kind === 'line' && e.by.startsWith('agent:')) return e.body;
  }
  return undefined;
}
