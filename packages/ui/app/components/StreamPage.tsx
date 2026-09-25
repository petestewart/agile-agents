/**
 * The stream page (design/cockpit-design.md §9.3, T161) — opened from the
 * stream tree or an inbox card's "Open stream".
 *
 *  - **Needs you** — this stream's open questions, gates and proposed
 *    rules as inbox cards with their *full* text (the inbox clips at 200
 *    chars, §3.2), answerable here exactly as in the inbox.
 *  - **Sessions strip** — vendor/model/role/status per session, with
 *    Start/Restart (a worker), Review (a reviewer) and Stop.
 *  - **Thread** — the spine: every line, markdown, live (re-read on every
 *    pushed cockpit frame), with a thinking indicator while a session is
 *    mid-turn; the composer under it writes a human line and, when a
 *    worker is attached, prompts it too.
 *  - **Diff / Rules / Docs** tabs — the worktree diff against the landing
 *    target, exactly `rulesInScope(stream)`, and the repo + stream docs.
 *  - **Delivery** (§14.7, direct path; was Land) — the `delivery_state`, the "before" (would `land` refuse right now, and which
 *    diff-stage rules it checks) and the "after" (the outcome line, or the
 *    refusal's reason, shown on the page).
 */

import {
  type Autonomy,
  type InboxItem,
  formatKnowledgeScope,
  isAgentRole,
} from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type RepoRow,
  addRepoToStream,
  approvePlan,
  attachSession,
  closeStream,
  getStreamActivity,
  getStreamDiff,
  getStreamPage,
  getStreamPlan,
  landStream,
  listRepos,
  markStreamLanded,
  resolveConflict,
  sayOnStream,
  setNodeAutonomy,
  setProjectAutonomy,
  stopSessions,
  waitOnStream,
} from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type {
  ActivityEntry,
  CockpitCardError,
  CockpitProjectRow,
  CockpitStatusCard,
  LandOutcome,
  StreamDiff,
  StreamPagePayload,
} from '../lib/feed-types';
import { DEFAULT_RULES_FILTER } from '../lib/rules';
import { useShell } from '../lib/shell';
import {
  DOT_LABEL,
  diffLineKind,
  isLiveSession,
  isThinking,
  ruleHitOf,
  streamDot,
  threadAuthorLabel,
} from '../lib/streams';
import { Card } from './Inbox';
import { Markdown } from './Markdown';
import { SessionPicker, sessionModelText } from './SessionPicker';

type Tab = 'thread' | 'diff' | 'activity' | 'plan' | 'rules' | 'docs';
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'thread', label: 'Thread' },
  { tab: 'diff', label: 'Diff' },
  { tab: 'activity', label: 'Activity' },
  { tab: 'plan', label: 'Plan' },
  { tab: 'rules', label: 'Knowledge in scope' },
  { tab: 'docs', label: 'Docs' },
];

/** Decision cards only: `blocked`/`done` are this page's own status and Land button. */
function needsYou(items: readonly InboxItem[], stream: string): InboxItem[] {
  return items.filter(
    (item) => item.stream === stream && item.kind !== 'blocked' && item.kind !== 'done',
  );
}

/** T205: the registered repos a proposal names, so its card can offer "Add <repo>" (§7). */
/** T330: past ~12 lines a thread entry renders collapsed, with a Show more / Show less toggle. */
export const THREAD_COLLAPSE_LINES = 12;

/** Long enough to collapse: more than 12 source lines, or ~12 wrapped lines of prose. */
export function isLongThreadBody(body: string): boolean {
  return (
    body.split('\n').length > THREAD_COLLAPSE_LINES || body.length > THREAD_COLLAPSE_LINES * 100
  );
}

function ThreadBody({ body }: { body: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (!isLongThreadBody(body)) return <Markdown text={body} />;
  return (
    <>
      <Markdown
        text={body}
        className={expanded ? undefined : 'cr-collapsed'}
        testId="thread-body"
      />
      <button
        type="button"
        className="cr-link"
        data-testid="thread-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}

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

/** T281 (§9.1): who owns what, the contracts between the children, and the draft's Approve. */
function PlanView({
  id,
  tick,
  onChanged,
}: {
  id: string;
  tick: unknown;
  onChanged: () => void;
}): JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof getStreamPlan>> | undefined>();
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` and `seq` are re-read triggers.
  useEffect(() => {
    let live = true;
    getStreamPlan(id)
      .then((r) => live && setData(r))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [id, tick, seq]);
  if (error) return <p className="cr-dim">{error}</p>;
  if (!data) return <p className="cr-dim">Loading…</p>;
  const { plan, contracts } = data;
  if (!plan && contracts.length === 0) {
    return (
      <p className="cr-dim" data-testid="plan-empty">
        No plan yet — the coordinator writes one when it splits the work.
      </p>
    );
  }
  return (
    <section className="cr-docs" data-testid="plan">
      {plan && (
        <p data-testid="plan-status" data-status={plan.status}>
          Plan v{plan.version} · {plan.status}
          {plan.approved_by ? ` by ${plan.approved_by}` : ''}{' '}
          {plan.status === 'draft' && (
            <button
              type="button"
              className="cr-btn signal"
              data-testid="plan-tab-approve"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                approvePlan(id)
                  .catch((err: unknown) => setError(errorText(err)))
                  .finally(() => {
                    setBusy(false);
                    setSeq((n) => n + 1);
                    onChanged();
                  });
              }}
            >
              Approve
            </button>
          )}
        </p>
      )}
      {plan && (
        <ul data-testid="plan-owners">
          {plan.owners.map((o) => (
            <li key={o.child} data-testid="plan-owner" data-child={o.child}>
              {o.child}: {o.owns.length === 0 ? 'nothing' : o.owns.join(', ')}
              {plan.status === 'draft' && plan.approved
                ? (() => {
                    const before = plan.approved.owners.find((a) => a.child === o.child);
                    const same = before?.owns.join(', ') === o.owns.join(', ');
                    return same ? null : (
                      <span className="cr-dim" data-testid="plan-owner-was">
                        {' '}
                        (approved v{plan.approved.version}:{' '}
                        {before ? before.owns.join(', ') || 'nothing' : 'not in the plan'})
                      </span>
                    );
                  })()
                : null}
            </li>
          ))}
        </ul>
      )}
      <ul data-testid="contracts">
        {contracts.map((c) => (
          <li key={c.id} data-testid="contract" data-contract={c.id}>
            <div className="cr-dim">
              {c.title} · v{c.version} · parties {c.parties.length}
            </div>
            <Markdown text={c.body} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** T245: what woke this node and why — every routed event, its reason, and what carried it. */
function ActivityView({ id, tick }: { id: string; tick: unknown }): JSX.Element {
  const [rows, setRows] = useState<ActivityEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` (the pushed frame) is the re-read trigger.
  useEffect(() => {
    let live = true;
    getStreamActivity(id)
      .then((r) => live && setRows(r))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [id, tick]);
  if (error) return <p className="cr-dim">{error}</p>;
  if (!rows) return <p className="cr-dim">Loading…</p>;
  if (rows.length === 0)
    return (
      <p className="cr-dim" data-testid="activity-empty">
        No events routed here yet.
      </p>
    );
  return (
    <ul className="cr-docs" data-testid="activity">
      {rows.map((row) => (
        <li key={row.event.id} data-testid="activity-row" data-event={row.event.id}>
          <span data-testid="activity-type">{row.event.type.replace(/_/g, ' ')}</span>
          {row.event.repo ? <span className="cr-dim"> · {row.event.repo}</span> : null}
          <span className="cr-dim"> · </span>
          <span className="cr-dim" data-testid="activity-because">
            {row.because.replace(/_/g, ' ')}
          </span>
          <span className="cr-dim" data-testid="activity-status">
            {' '}
            · {row.status}
            {row.session ? ` in session ${row.session}` : ''}
            {row.digest ? ` in digest ${row.digest}` : ''}
          </span>
          <span className="cr-dim"> · {row.event.at}</span>
        </li>
      ))}
    </ul>
  );
}

function DiffView({ id }: { id: string }): JSX.Element {
  const [diff, setDiff] = useState<StreamDiff | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getStreamDiff(id)
      .then((d) => live && setDiff(d))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [id]);
  if (error)
    return (
      <p className="cr-dim" data-testid="diff-empty">
        {error}
      </p>
    );
  if (!diff) return <p className="cr-dim">Loading…</p>;
  return (
    <div data-testid="diff">
      <p className="cr-dim">
        {diff.branch} against {diff.target}
        {diff.worktree ? ` · ${diff.worktree}` : ''} ·{' '}
        {diff.stat.split('\n').pop()?.trim() || 'no changes'}
      </p>
      {diff.patch ? (
        <pre className="cr-diff">
          {diff.patch.split('\n').map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines are positional and never reordered.
            <span key={i} data-line={diffLineKind(line)}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <p className="cr-dim">No changes yet.</p>
      )}
      {diff.truncated && <p className="cr-dim">Truncated — the patch is over the page's cap.</p>}
    </div>
  );
}

function LandPanel({
  page,
  onChanged,
  onResolve,
}: {
  page: StreamPagePayload;
  onChanged: () => void;
  /** T176: opens the session picker for a Resolve worker. */
  onResolve: () => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LandOutcome | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const { stream, land } = page;
  if (stream.repo === undefined) return null;
  const finished = stream.human.status === 'landed' || stream.human.status === 'closed';
  // T176: a failed land's own line replaces the preflight, never "Ready" beside it.
  const failed = refused !== undefined || (outcome !== undefined && outcome.status !== 'landed');
  const conflicts = land?.conflicts;

  async function doMarkLanded(): Promise<void> {
    setBusy(true);
    setRefused(undefined);
    try {
      await markStreamLanded(stream.id);
    } catch (err) {
      setRefused(errorText(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function doLand(): Promise<void> {
    setBusy(true);
    setOutcome(undefined);
    setRefused(undefined);
    try {
      setOutcome(await landStream(stream.id));
    } catch (err) {
      setRefused(errorText(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <section className="cr-land" data-testid="land-panel">
      <div className="cr-land-hd">
        <h2>Delivery</h2>
        {!finished && land?.merged && (
          <button
            type="button"
            className="cr-btn signal"
            data-testid="stream-mark-landed"
            disabled={busy}
            onClick={() => void doMarkLanded()}
          >
            Mark landed
          </button>
        )}
        {!finished && !land?.merged && (
          <button
            type="button"
            className="cr-btn signal"
            data-testid="stream-land"
            disabled={busy}
            onClick={() => void doLand()}
          >
            {busy ? 'Merging…' : 'Merge'}
          </button>
        )}
      </div>
      {stream.human.status === 'landed' ? (
        <p data-testid="land-before" data-ready="landed">
          Landed.
        </p>
      ) : conflicts && conflicts.length > 0 ? (
        <div data-testid="land-conflict">
          <p data-testid="land-before" data-ready="conflict">
            Conflict: landing into {land?.target ?? 'the target'} conflicted in {conflicts.length}{' '}
            file{conflicts.length === 1 ? '' : 's'}. Resolve attaches a worker to merge the target
            in and fix them; then land again.
          </p>
          <ul>
            {conflicts.map((file) => (
              <li key={file} data-testid="land-conflict-file">
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="cr-btn"
            data-testid="stream-resolve"
            disabled={
              busy || page.stream.sessions.some((s) => s.role === 'worker' && isLiveSession(s))
            }
            onClick={onResolve}
          >
            Resolve
          </button>
        </div>
      ) : failed ? null : land?.merged ? (
        <p data-testid="land-before" data-ready="merged">
          Already merged into {land.target}.
        </p>
      ) : land ? (
        <p data-testid="land-before" data-ready={land.ready ? 'yes' : 'no'}>
          {land.ready
            ? `Ready: ${land.branch} is ${land.ahead} commit${land.ahead === 1 ? '' : 's'} ahead of ${land.target}${
                land.gated ? ' — this repo asks for a land gate' : ''
              }.`
            : `Not landable yet: ${land.reason}`}
        </p>
      ) : null}
      {stream.delivery_state && (
        <p
          className="cr-dim"
          data-testid="delivery-state"
          data-status={stream.delivery_state.status}
        >
          Delivery: {stream.delivery_state.mode} · {stream.delivery_state.status.replace('_', ' ')}
          {stream.delivery_state.held_by?.map((h) => ` — ${h.detail}`).join('')}
        </p>
      )}
      <p className="cr-dim" data-testid="land-diff-rules">
        {page.diff_rules.length === 0
          ? 'No diff-stage rules in scope.'
          : `Ship check rules: ${page.diff_rules.join(', ')}`}
      </p>
      {outcome && !(conflicts && conflicts.length > 0) && (
        <p
          className={`cr-land-result ${outcome.status === 'landed' ? 'ok' : 'bad'}`}
          data-testid="land-result"
          data-status={outcome.status}
          aria-live="polite"
        >
          {outcome.line}
        </p>
      )}
      {refused && (
        <p
          className="cr-land-result bad"
          data-testid="land-result"
          data-status="refused"
          role="alert"
        >
          Land refused: {refused}
        </p>
      )}
    </section>
  );
}

const AUTONOMY_LEVELS = ['advise', 'organise', 'run'] as const;

/**
 * T282 (§9 Autonomy): how far this node's coordinator acts on its own. On
 * a project root it sets the project's level; elsewhere it overrides it.
 */
function AutonomyPicker({
  stream,
  project,
  busy,
  act,
}: {
  stream: StreamPagePayload['stream'];
  project: CockpitProjectRow | undefined;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void> | void;
}): JSX.Element | null {
  if (project === undefined) return null;
  const isRoot = project.root === stream.id;
  const inherited = project.autonomy?.coordinator ?? 'advise';
  const value = isRoot ? inherited : (stream.autonomy ?? 'inherit');
  return (
    <label className="cr-dim" data-testid="autonomy">
      Coordinator autonomy{' '}
      <select
        data-testid="autonomy-select"
        value={value}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value;
          void act(() =>
            isRoot
              ? setProjectAutonomy(project.id, { coordinator: next as Autonomy })
              : setNodeAutonomy(stream.id, next === 'inherit' ? null : (next as Autonomy)),
          );
        }}
      >
        {!isRoot && <option value="inherit">inherit ({inherited})</option>}
        {AUTONOMY_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** T283 (§14.5): the children's status cards, on the parent's page. */
function ChildCards({
  cards,
  titleOf,
}: {
  cards: Array<CockpitStatusCard | CockpitCardError>;
  titleOf: (id: string) => string;
}): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <section className="cr-findings" data-testid="child-cards">
      <h2>Children</h2>
      <ul>
        {cards.map((card) =>
          'error' in card ? (
            <li key={card.node} data-testid="status-card-error" data-node={card.node}>
              <strong>{titleOf(card.node)}</strong>{' '}
              <span className="sev" data-testid="status-card-error-text">
                {card.error}
              </span>
            </li>
          ) : (
            <li
              key={card.node}
              data-testid="status-card"
              data-node={card.node}
              data-state={card.state}
            >
              <strong>{titleOf(card.node)}</strong> <span className="cr-dim">{card.state}</span>
              {card.doing !== '' && (
                <>
                  {' — '}
                  <span data-testid="status-card-doing">{card.doing}</span>
                </>
              )}
              {card.files.length > 0 && (
                <p className="cr-dim" data-testid="status-card-files">
                  {card.files.join(', ')}
                </p>
              )}
              {card.relies_on.length > 0 && (
                <p className="cr-dim">relies on {card.relies_on.join(', ')}</p>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

export function StreamPage({ id }: { id: string }): JSX.Element {
  const { cockpit, refresh } = useFeed();
  const { openRules } = useShell();
  const [page, setPage] = useState<StreamPagePayload | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('thread');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // T170: Attach/Review open the session picker first.
  const [picker, setPicker] = useState<'worker' | 'reviewer' | 'resolve' | undefined>(undefined);
  // T205: + Repo in place — the registered repos, and the open picker's choice.
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoChoice, setRepoChoice] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkChoice, setLinkChoice] = useState('');
  // T176: the server refused a worker on a parent with open children; this is its reason.
  const threadRef = useRef<HTMLOListElement | null>(null);

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

  // A different stream opened: back to its thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the trigger.
  useEffect(() => {
    setTab('thread');
    setDraft('');
    setActionError(undefined);
    setPicker(undefined);
    setAddingRepo(false);
    setRepoChoice('');
  }, [id]);

  const threadLength = page?.thread.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the thread grows.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadLength]);

  async function act(fn: () => Promise<unknown>, after?: () => void): Promise<void> {
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
  }

  if (loadError && !page) {
    return (
      <section className="cr-stream" data-testid="stream-page">
        <p className="cr-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }
  if (!page || page.stream.id !== id) {
    return (
      <section className="cr-stream" data-testid="stream-page">
        <p className="cr-dim">Loading…</p>
      </section>
    );
  }

  const { stream } = page;
  const dot = streamDot({ agent_status: stream.agent.status, human_status: stream.human.status });
  const live = stream.sessions.filter(isLiveSession);
  const liveWorker = live.find((s) => isAgentRole(s.role));
  const liveReviewer = live.find((s) => s.role === 'reviewer');
  // T174: human lines sent mid-turn, not yet delivered to the live worker.
  const queuedLines = new Set(live.flatMap((s) => s.queued ?? []));
  const cards = needsYou(cockpit?.inbox ?? [], stream.id);
  const findings = stream.agent.findings ?? [];
  const text = draft.trim();
  const open = stream.human.status !== 'landed' && stream.human.status !== 'closed';
  const repoOptions = repos.map((r) => r.name).filter((name) => name !== stream.repo);
  const chosenRepo = repoChoice || repoOptions[0] || '';
  const waits = stream.waits_on ?? [];
  const titleOf = (id: string) => cockpit?.streams.find((r) => r.id === id)?.title ?? id;
  const linkOptions = (cockpit?.streams ?? []).filter(
    (r) => r.id !== stream.id && !waits.some((w) => w.node === r.id),
  );
  const chosenLink = linkChoice || linkOptions[0]?.id || '';
  function addRepo(repo: string, switching = false): void {
    void act(
      () => addRepoToStream(stream.id, repo, switching),
      () => setAddingRepo(false),
    );
  }

  return (
    <section className="cr-stream" data-testid="stream-page" data-stream={stream.id}>
      <header className="cr-stream-hd">
        <p className="cr-dim cr-path" data-testid="stream-path">
          {page.path.join(' / ')}
        </p>
        <h1>
          <span className="cr-dot" data-dot={dot} aria-label={DOT_LABEL[dot]} />
          <span data-testid="stream-title">{stream.title}</span>
        </h1>
        <p className="cr-dim" data-testid="stream-status">
          agent {stream.agent.status} · you {stream.human.status.replace(/_/g, ' ')}
          {stream.branch ? ` · ${stream.branch}` : ''}
        </p>
        <Markdown className="cr-goal" text={stream.goal} />
      </header>

      <section className="cr-needs" data-testid="stream-needs">
        <h2>Needs you</h2>
        {cards.length === 0 && (
          <p className="cr-dim" data-testid="stream-needs-empty">
            Nothing waiting on you.
          </p>
        )}
        {cards.map((item) => (
          <Card
            key={item.id}
            item={item}
            full
            onDone={() => {
              load();
              refresh();
            }}
          />
        ))}
      </section>

      <ChildCards
        cards={(cockpit?.cards ?? []).filter(
          (c) => cockpit?.streams.find((r) => r.id === c.node)?.parent === stream.id,
        )}
        titleOf={titleOf}
      />

      <section className="cr-sessions" data-testid="sessions">
        <ul>
          {stream.sessions.length === 0 && <li className="cr-dim">No sessions yet.</li>}
          {stream.sessions.map((session) => (
            <li
              key={session.id}
              data-testid="session"
              data-role={session.role}
              data-status={session.status}
              title={session.id}
            >
              <strong>{session.role}</strong> {session.vendor}/{sessionModelText(session)}
              {session.effort ? ` · ${session.effort}` : ''} · {session.status}
              {session.ended_reason && (
                <span className="cr-dim" data-testid="session-ended-reason">
                  {' '}
                  — {session.ended_reason}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn"
            data-testid="attach"
            disabled={busy || liveWorker !== undefined || stream.human.status === 'landed'}
            onClick={() => setPicker('worker')}
          >
            {/* T204: a new node starts its own agent; this is for "Start later" or after one ended. */}
            {stream.sessions.some((s) => isAgentRole(s.role)) ? 'Restart' : 'Start'}
          </button>
          <button
            type="button"
            className="cr-btn"
            data-testid="review"
            disabled={busy || liveReviewer !== undefined}
            onClick={() => setPicker('reviewer')}
          >
            Review
          </button>
          <button
            type="button"
            className="cr-btn danger"
            data-testid="stop"
            disabled={busy || live.length === 0}
            onClick={() => void act(() => stopSessions(stream.id))}
          >
            Stop
          </button>
          {stream.human.status !== 'landed' && stream.human.status !== 'closed' && (
            <button
              type="button"
              className="cr-btn"
              data-testid="stream-close"
              disabled={busy}
              onClick={() => void act(() => closeStream(stream.id))}
            >
              Close
            </button>
          )}
          {open && (
            <button
              type="button"
              className="cr-btn"
              data-testid="link-wait"
              title="Hold this node's delivery until another node is merged"
              disabled={busy || linkOptions.length === 0}
              onClick={() => setLinking((v) => !v)}
            >
              Link
            </button>
          )}
          {open && stream.parent !== undefined && (
            <button
              type="button"
              className="cr-btn"
              data-testid="add-repo"
              disabled={busy || repoOptions.length === 0}
              onClick={() => setAddingRepo((v) => !v)}
            >
              + Repo
            </button>
          )}
        </div>
        {waits.length > 0 && (
          <ul className="cr-dim" data-testid="waits-on">
            {waits.map((w) => (
              <li key={w.node}>
                waits on {titleOf(w.node)}
                {w.satisfied_at ? ' · satisfied' : ''}
                {open && (
                  <button
                    type="button"
                    className="cr-btn"
                    data-testid="waits-on-remove"
                    disabled={busy}
                    onClick={() => void act(() => waitOnStream(stream.id, w.node, true))}
                  >
                    Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <AutonomyPicker
          stream={stream}
          project={cockpit?.projects.find((p) => p.id === stream.project)}
          busy={busy}
          act={act}
        />
        {linking && (
          <div className="cr-actions" data-testid="link-wait-form">
            <select
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
            <button
              type="button"
              className="cr-btn"
              data-testid="link-wait-submit"
              disabled={busy || chosenLink === ''}
              onClick={() =>
                void act(
                  () => waitOnStream(stream.id, chosenLink),
                  () => {
                    setLinking(false);
                    setLinkChoice('');
                  },
                )
              }
            >
              Wait on
            </button>
          </div>
        )}
        {addingRepo && (
          <div className="cr-actions" data-testid="add-repo-form">
            <select
              data-testid="add-repo-select"
              value={chosenRepo}
              onChange={(e) => setRepoChoice(e.target.value)}
            >
              {repoOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="cr-btn"
              data-testid="add-repo-submit"
              disabled={busy || chosenRepo === ''}
              onClick={() => addRepo(chosenRepo)}
            >
              Add
            </button>
            {stream.branch !== undefined && (
              <button
                type="button"
                className="cr-btn"
                data-testid="switch-repo-submit"
                title="Only when nothing is committed on this branch"
                disabled={busy || chosenRepo === ''}
                onClick={() => addRepo(chosenRepo, true)}
              >
                Switch
              </button>
            )}
          </div>
        )}
        {picker && (
          <SessionPicker
            key={picker}
            role={picker === 'reviewer' ? 'reviewer' : 'worker'}
            repo={stream.repo}
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
                () => attachSession(stream.id, picker, choice),
                () => setPicker(undefined),
              );
            }}
          />
        )}
        {actionError && (
          <p className="cr-error" role="alert" data-testid="stream-error">
            {actionError}
          </p>
        )}
      </section>

      {findings.length > 0 && (
        <section className="cr-findings" data-testid="findings">
          <h2>Findings</h2>
          <ul>
            {findings.map((finding, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: findings are append-only.
                key={i}
                data-testid="finding"
                data-severity={finding.severity}
              >
                <span className="sev">{finding.severity}</span>{' '}
                <code>
                  {finding.file}
                  {finding.line !== undefined ? `:${finding.line}` : ''}
                </code>{' '}
                — {finding.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <LandPanel
        // A new session (Resolve, Attach) starts the panel over: the last land's result is stale.
        key={`${stream.id}:${stream.sessions.length}`}
        page={page}
        onChanged={load}
        onResolve={() => setPicker('resolve')}
      />

      <nav className="cr-tabs" aria-label="Stream views">
        {TABS.map((each) => (
          <button
            key={each.tab}
            type="button"
            data-tab={each.tab}
            aria-current={tab === each.tab ? 'page' : undefined}
            className={tab === each.tab ? 'on' : undefined}
            onClick={() => setTab(each.tab)}
          >
            {each.label}
            {each.tab === 'rules' ? ` (${page.rules.length})` : ''}
            {each.tab === 'docs' ? ` (${page.docs.length})` : ''}
          </button>
        ))}
      </nav>

      {tab === 'thread' && (
        <section className="cr-thread-wrap">
          {page.thread_total > page.thread.length && (
            <p className="cr-dim">
              Showing the newest {page.thread.length} of {page.thread_total} lines.
            </p>
          )}
          <ol className="cr-thread" data-testid="thread" ref={threadRef}>
            {page.thread.map((entry, i) => {
              const hit = ruleHitOf(entry);
              if (hit !== undefined) {
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: the thread is append-only, so an index is stable.
                    key={i}
                    className="cr-rule-hit"
                    data-testid="thread-rule-hit"
                    data-kind={entry.kind}
                    data-by="daemon"
                    data-rule={hit}
                  >
                    <div className="who">blocked by rule</div>
                    <Markdown text={entry.body.slice('rule_hit:'.length).trim()} />
                    <button
                      type="button"
                      className="cr-link"
                      data-testid="thread-rule-link"
                      onClick={() => openRules({ ...DEFAULT_RULES_FILTER, rule: hit })}
                    >
                      Open rule {hit}
                    </button>
                  </li>
                );
              }
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the thread is append-only, so an index is stable.
                  key={i}
                  data-testid="thread-entry"
                  data-kind={entry.kind}
                  data-by={entry.by === 'human' || entry.by === 'daemon' ? entry.by : 'agent'}
                >
                  <div className="who">
                    {threadAuthorLabel(entry.by, stream.sessions)}
                    {entry.kind !== 'line' ? ` · ${entry.kind}` : ''}
                  </div>
                  <ThreadBody body={entry.body} />
                  {entry.kind === 'proposal' &&
                    open &&
                    reposNamedIn(entry.body, repos, stream.repo).map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="cr-btn"
                        data-testid="proposal-add-repo"
                        disabled={busy}
                        onClick={() => addRepo(name)}
                      >
                        Add {name}
                      </button>
                    ))}
                  {entry.by === 'human' && entry.kind === 'line' && queuedLines.has(entry.ts) && (
                    <div className="cr-dim cr-queued" data-testid="thread-queued">
                      queued — the worker reads it after its current step
                    </div>
                  )}
                </li>
              );
            })}
            {isThinking(stream) && (
              <li className="cr-thinking" data-testid="thinking" aria-label="agent is thinking">
                <span />
                <span />
                <span />
              </li>
            )}
          </ol>
          <form
            className="cr-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (text)
                void act(
                  () => sayOnStream(stream.id, text),
                  () => setDraft(''),
                );
            }}
          >
            <textarea
              data-testid="composer-input"
              aria-label="Write on the stream"
              rows={2}
              maxLength={800}
              value={draft}
              disabled={busy}
              placeholder={
                liveWorker
                  ? 'Write on the stream — the attached worker reads it too…'
                  : 'Write on the stream…'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline; never mid-IME composition.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (busy) return;
                  if (text)
                    void act(
                      () => sayOnStream(stream.id, text),
                      () => setDraft(''),
                    );
                }
              }}
            />
            <button
              type="submit"
              className="cr-btn signal"
              data-testid="composer-send"
              disabled={busy || text.length === 0}
            >
              Send
            </button>
          </form>
        </section>
      )}

      {tab === 'diff' &&
        (stream.branch ? (
          <DiffView id={stream.id} />
        ) : (
          <p className="cr-dim" data-testid="diff-empty">
            {stream.repo
              ? 'No branch yet — attach a worker to cut one.'
              : 'This stream has no repo.'}
          </p>
        ))}

      {tab === 'activity' && <ActivityView id={stream.id} tick={cockpit} />}

      {tab === 'plan' && <PlanView id={stream.id} tick={cockpit} onChanged={refresh} />}

      {tab === 'rules' && (
        <ul className="cr-rules" data-testid="rules">
          {page.rules.length === 0 && <li className="cr-dim">No accepted knowledge in scope.</li>}
          {page.rules.map((rule) => (
            <li key={rule.id} data-testid="rule" data-rule={rule.id}>
              <div className="cr-dim">
                {rule.name ?? rule.id} · {formatKnowledgeScope(rule.scope)} · {rule.kind} ·{' '}
                {rule.enforcement}
                {rule.critical ? ' · critical' : ''}
              </div>
              <Markdown text={rule.text} />
            </li>
          ))}
        </ul>
      )}

      {tab === 'docs' && (
        <ul className="cr-docs" data-testid="docs">
          {page.docs.length === 0 && (
            <li className="cr-dim">No docs — repo docs and stream docs appear here.</li>
          )}
          {page.docs.map((doc) => (
            <li key={doc.path} data-testid="doc">
              <details>
                <summary>
                  {doc.name} <span className="cr-dim">· {doc.source}</span>
                </summary>
                <Markdown text={doc.body} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
