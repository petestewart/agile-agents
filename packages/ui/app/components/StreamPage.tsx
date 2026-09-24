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
 *  - **Land** — the "before" (would `land` refuse right now, and which
 *    diff-stage rules it checks) and the "after" (the outcome line, or the
 *    refusal's reason, shown on the page).
 */

import type { InboxItem } from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachSession,
  closeStream,
  getStreamDiff,
  getStreamPage,
  landStream,
  markStreamLanded,
  resolveConflict,
  sayOnStream,
  stopSessions,
} from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { LandOutcome, StreamDiff, StreamPagePayload } from '../lib/feed-types';
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

type Tab = 'thread' | 'diff' | 'rules' | 'docs';
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'thread', label: 'Thread' },
  { tab: 'diff', label: 'Diff' },
  { tab: 'rules', label: 'Rules in scope' },
  { tab: 'docs', label: 'Docs' },
];

/** Decision cards only: `blocked`/`done` are this page's own status and Land button. */
function needsYou(items: readonly InboxItem[], stream: string): InboxItem[] {
  return items.filter(
    (item) => item.stream === stream && item.kind !== 'blocked' && item.kind !== 'done',
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        <h2>Land</h2>
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
            {busy ? 'Landing…' : 'Land'}
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
      <p className="cr-dim" data-testid="land-diff-rules">
        {page.diff_rules.length === 0
          ? 'No diff-stage rules in scope.'
          : `Diff rules checked at land: ${page.diff_rules.join(', ')}`}
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
  // T176: the server refused a worker on a parent with open children; this is its reason.
  const threadRef = useRef<HTMLOListElement | null>(null);

  const load = useCallback(() => {
    getStreamPage(id)
      .then((next) => {
        setPage(next);
        setLoadError(undefined);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [id]);

  // A pushed cockpit frame follows every batch of events — a new thread
  // line, a session status, a finding — so it is the re-read trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` is the trigger, not an input.
  useEffect(() => {
    load();
  }, [load, cockpit]);

  // A different stream opened: back to its thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the trigger.
  useEffect(() => {
    setTab('thread');
    setDraft('');
    setActionError(undefined);
    setPicker(undefined);
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
  const liveWorker = live.find((s) => s.role === 'worker');
  const liveReviewer = live.find((s) => s.role === 'reviewer');
  // T174: human lines sent mid-turn, not yet delivered to the live worker.
  const queuedLines = new Set(live.flatMap((s) => s.queued ?? []));
  const cards = needsYou(cockpit?.inbox ?? [], stream.id);
  const findings = stream.agent.findings ?? [];
  const text = draft.trim();

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
            {stream.sessions.some((s) => s.role === 'worker') ? 'Restart' : 'Start'}
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
        </div>
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
                  <Markdown text={entry.body} />
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

      {tab === 'rules' && (
        <ul className="cr-rules" data-testid="rules">
          {page.rules.length === 0 && <li className="cr-dim">No accepted rules in scope.</li>}
          {page.rules.map((rule) => (
            <li key={rule.id} data-testid="rule" data-rule={rule.id}>
              <div className="cr-dim">
                {rule.name ?? rule.id} · {rule.scope.kind}
                {rule.scope.ref ? `:${rule.scope.ref}` : ''} · {rule.enforcement} · {rule.stage}
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
