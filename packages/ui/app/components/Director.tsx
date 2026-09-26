/**
 * The Director page (T300, projects-design §12, P16), rebuilt in T368 on
 * the node chat's pieces (T363: `ChatScroll`, `MessageList`, `Thinking`,
 * `Composer`), so talking to the Director looks and behaves like talking to
 * a node's agent: your lines as bubbles, its replies as prose, the daemon's
 * bookkeeping as system rows, Enter sends.
 *
 * What needs you sits in the conversation, right above the composer: its
 * held drafts (T301) as decision cards — a draft tree as the tree it would
 * build, parts with their repo and what they wait on — with Create/Dismiss.
 * The details panel (as on a node, remembered per viewer, closed below
 * 1200px) holds its Activity (the events routed to it, as a timeline) and
 * how far it may act in each project. Re-read on every pushed frame.
 */

import type { AutonomyProposal } from '@agile-agents/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DirectorPayload, decideProposal, getDirector, sayToDirector } from '../lib/api';
import { type ChatAuthor, detailsOpenFrom } from '../lib/chat';
import {
  DIRECTOR_AUTONOMY,
  directorHint,
  directorState,
  draftActionLabel,
  draftHeading,
  draftParts,
} from '../lib/director';
import { useFeed } from '../lib/feed-context';
import { eventDetail, eventTitle } from '../lib/lenses';
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { activityDelivery, eventTime } from '../lib/streams';
import { ChatScroll, MessageList, Thinking } from './Chat';
import { Composer, type ComposerHandle } from './Composer';
import { Icon } from './Icon';
import { EventGlyph } from './Lenses';
import { Markdown } from './Markdown';
import { DetailSection } from './NodeDetails';
import { Button, IconButton, useToast } from './ui';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DETAILS_KEY = 'agile.director.details';

/** As on a node's page: remembered per viewer on a wide window, closed on a narrow one. */
function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(DETAILS_KEY);
    } catch {
      // Blocked storage: the default for the width.
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

const SUGGESTIONS = [
  'What needs me today?',
  'Is anything stuck or overlapping?',
  'Draft the work for…',
];

/** T301: a held Director change, as a decision card. A draft tree renders as the tree it would build. */
function DraftCard({
  proposal,
  onDecide,
}: {
  proposal: AutonomyProposal;
  onDecide: (decision: 'apply' | 'dismiss') => Promise<void>;
}): JSX.Element {
  const { cockpit } = useFeed();
  const [busy, setBusy] = useState<'apply' | 'dismiss' | undefined>(undefined);
  const change = proposal.change;
  const tree = change.action === 'create_tree' ? change.tree : undefined;
  // T341: projects and nodes read by name, never by id.
  const projectName = (id: string) => cockpit?.projects.find((p) => p.id === id)?.name;
  const nodeTitle = (id: string) => cockpit?.streams.find((s) => s.id === id)?.title;
  const decide = (decision: 'apply' | 'dismiss'): void => {
    setBusy(decision);
    void onDecide(decision).finally(() => setBusy(undefined));
  };
  return (
    <article
      className="cr-card cr-dir-draft"
      data-kind="proposal"
      data-testid="director-proposal"
      data-id={proposal.id}
      data-action={change.action}
    >
      <div className="cr-card-hd">
        <span className="cr-card-icon" data-tone="accent">
          <Icon name="sparkles" size={13} />
        </span>
        <span className="kind">{draftHeading(change, projectName, nodeTitle)}</span>
        <span className="cr-card-age" title={eventTime(proposal.created_at)}>
          {ago(proposal.created_at)}
        </span>
      </div>
      <div className="cr-card-body">
        {tree ? (
          <div className="cr-dir-tree" data-testid="director-draft-tree">
            <div className="cr-dir-tree-project">
              <Icon name="layers" size={14} />
              <span data-testid="director-draft-project">
                {tree.new_project ?? projectName(tree.project ?? '') ?? 'a project'}
              </span>
              {tree.new_project ? <span className="cr-dir-new">new project</span> : null}
            </div>
            <ul className="cr-dir-tree-list">
              <li className="cr-dir-tree-node" data-testid="director-draft-node">
                <div className="cr-dir-tree-row">
                  <Icon name="network" size={14} className="cr-dir-tree-icon" />
                  <span className="cr-dir-tree-title">{tree.title}</span>
                  {tree.repo ? (
                    <>
                      {' on '}
                      <span className="cr-dir-repo">{tree.repo}</span>
                    </>
                  ) : null}
                </div>
                <p className="cr-dir-tree-goal">{tree.goal}</p>
                <ul className="cr-dir-tree-list">
                  {draftParts(tree).map((part, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are referenced by index.
                      key={i}
                      className="cr-dir-tree-part"
                      data-testid="director-draft-part"
                      title={part.goal}
                    >
                      <div className="cr-dir-tree-row">
                        <Icon
                          name={part.repo ? 'git-branch' : 'message-square'}
                          size={14}
                          className="cr-dir-tree-icon"
                        />
                        <span className="cr-dir-tree-title">{part.title}</span>
                        {part.repo ? (
                          <>
                            {' on '}
                            <span className="cr-dir-repo">{part.repo}</span>
                          </>
                        ) : null}
                        {part.waitsOn.length > 0 ? (
                          <span className="cr-dir-waits">
                            <Icon name="link" size={12} />
                            {' · waits on '}
                            {part.waitsOn.join(', ')}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            </ul>
          </div>
        ) : (
          <Markdown className="context" text={proposal.summary} />
        )}
      </div>
      <div className="cr-card-ft">
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            data-testid="director-create"
            busy={busy === 'apply'}
            disabled={busy !== undefined}
            onClick={() => decide('apply')}
          >
            {draftActionLabel(change)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="director-dismiss"
            busy={busy === 'dismiss'}
            disabled={busy !== undefined}
            onClick={() => decide('dismiss')}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </article>
  );
}

function ActivitySection({ page }: { page: DirectorPayload | undefined }): JSX.Element {
  const { cockpit } = useFeed();
  const titleOf = (id: string): string =>
    cockpit?.streams.find((s) => s.id === id)?.title ?? 'a node';
  const rows = page?.activity ?? [];
  return (
    <DetailSection title="Activity" testid="director-activity-section">
      {rows.length === 0 ? (
        <p className="cr-dsec-empty" data-testid="director-activity-empty">
          Nothing routed to the Director yet. Your messages and the events it watches show here.
        </p>
      ) : (
        <ol className="cr-timeline cr-dir-activity" data-testid="director-activity">
          {rows.slice(0, 40).map((row) => {
            const detail = eventDetail(row.event, titleOf);
            return (
              <li
                key={row.event.id}
                className="cr-timeline-row"
                data-testid="director-activity-row"
                data-delivery={row.status}
                title={[row.session, eventTime(row.event.at)].filter(Boolean).join(' · ')}
              >
                <EventGlyph type={row.event.type} />
                <div className="cr-timeline-main">
                  <span className="cr-timeline-type">{eventTitle(row.event)}</span>
                  {detail !== undefined && <span className="cr-dir-act-detail">{detail}</span>}
                  <span className="cr-dir-act-status">{activityDelivery(row, [], 'Director')}</span>
                </div>
                <time className="cr-timeline-time" dateTime={row.event.at}>
                  {ago(row.event.at)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </DetailSection>
  );
}

function AutonomyList(): JSX.Element | null {
  const { cockpit } = useFeed();
  const { select } = useShell();
  const projects = cockpit?.projects ?? [];
  if (projects.length === 0) return null;
  return (
    <DetailSection title="What it may do">
      <ul className="cr-dir-autonomy" data-testid="director-autonomy">
        {projects.map((p) => {
          const level = DIRECTOR_AUTONOMY[p.autonomy?.director ?? 'advise'];
          return (
            <li key={p.id}>
              <button
                type="button"
                className="cr-dir-autonomy-row"
                title={`${level.hint} Change it on the ${p.name} page.`}
                onClick={() => select(p.root)}
              >
                <Icon name="layers" size={13} />
                <span className="cr-dir-autonomy-name">{p.name}</span>
                <span className="cr-dir-autonomy-level">{level.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="cr-dsec-note">
        Advise drafts work for you to create; Organise creates and starts it itself. Merging is
        always yours.
      </p>
    </DetailSection>
  );
}

export function DirectorPage(): JSX.Element {
  const { cockpit } = useFeed();
  const toast = useToast();
  const [page, setPage] = useState<DirectorPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [seq, setSeq] = useState(0);
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const composer = useRef<ComposerHandle>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` (the pushed frame) and `seq` are re-read triggers.
  useEffect(() => {
    let live = true;
    getDirector()
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [cockpit, seq]);

  const session = page?.record?.session;
  const state = directorState(session, page?.live === true);
  const thread = page?.thread ?? [];
  const proposals = page?.proposals ?? [];

  const authorOf = useMemo(
    () =>
      (by: string): ChatAuthor => {
        if (by === 'human') return { name: 'You' };
        if (by === 'daemon') return { name: 'agile' };
        return { name: 'Director', ...(session ? { vendor: session.vendor } : {}) };
      },
    [session],
  );

  const send = async (): Promise<void> => {
    const line = draft.trim();
    if (!line) return;
    setSending(true);
    try {
      await sayToDirector(line);
      setDraft('');
      setError(undefined);
      setSeq((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const decide = async (proposal: AutonomyProposal, decision: 'apply' | 'dismiss') => {
    try {
      await decideProposal(proposal.id, decision);
      toast({
        tone: 'success',
        title: decision === 'apply' ? 'Done' : 'Dismissed',
        body: proposal.summary,
        duration: 3000,
      });
      setSeq((n) => n + 1);
    } catch (err) {
      toast({ tone: 'error', title: 'The Director could not do that', body: errorText(err) });
    }
  };

  // Below 1200px the panel slides over the chat: Escape puts it away (as on a node).
  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && window.innerWidth < 1200) setDetailsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detailsOpen, setDetailsOpen]);

  const empty = thread.length === 0 && !state.working;

  return (
    <section
      className="cr-node cr-dir"
      data-testid="director-page"
      data-details={detailsOpen ? 'open' : 'closed'}
    >
      <div className="cr-node-main">
        <header className="cr-node-hd">
          <div className="cr-node-hd-row">
            <div className="cr-node-hd-main">
              <div className="cr-node-title-row">
                <span className="cr-dir-mark" aria-hidden="true">
                  <Icon name="sparkles" size={15} />
                </span>
                <h1 className="cr-node-title">Director</h1>
                <span
                  className="cr-role-badge"
                  title="One agent above every project: it sees all of them, drafts and starts work, and never merges."
                >
                  <Icon name="layers" size={12} />
                  Every project
                </span>
              </div>
              <div className="cr-node-meta">
                <span className="cr-node-meta-line">
                  <span
                    className="cr-dir-live"
                    data-state={state.working ? 'working' : state.live ? 'live' : 'off'}
                    aria-hidden="true"
                  />
                  <span className="cr-meta-item" data-testid="director-session" title={session?.id}>
                    {state.text}
                  </span>
                </span>
              </div>
            </div>
            <div className="cr-node-actions">
              <IconButton
                icon="panel-right"
                label={detailsOpen ? 'Hide details' : 'Show details'}
                className="cr-details-toggle"
                aria-pressed={detailsOpen}
                data-testid="director-details-toggle"
                onClick={() => setDetailsOpen(!detailsOpen)}
              />
            </div>
          </div>
          {error && (
            <div className="cr-node-error" role="alert" data-testid="director-error">
              <Icon name="alert-circle" size={15} />
              <span>{error}</span>
              <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setError(undefined)} />
            </div>
          )}
        </header>
        <div className="cr-node-body">
          <div className="cr-chat">
            <ChatScroll
              tick={`${thread.length}:${state.working}:${proposals.length}`}
              resetKey="director"
              label="Conversation with the Director"
            >
              <MessageList
                entries={thread}
                authorOf={authorOf}
                byAttr={(by) => (by === 'human' || by === 'daemon' ? by : 'director')}
                testid="director-thread"
                label="Conversation with the Director"
              />
              {state.working && <Thinking name="Director" />}
              {empty && (
                <div className="cr-chat-empty" data-testid="director-empty">
                  <span className="cr-chat-empty-icon">
                    <Icon name="sparkles" size={20} />
                  </span>
                  <div className="cr-chat-empty-title">Ask the Director what needs you today…</div>
                  <p>
                    It sees every project at once: what waits on you, what is stuck, where work
                    overlaps. It drafts new work for you to create and, if a project lets it, starts
                    it. Merging is always yours.
                  </p>
                  <div className="cr-dir-suggest">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="cr-dir-chip"
                        onClick={() => {
                          setDraft(s);
                          composer.current?.focus();
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <section
                className="cr-decisions"
                data-testid="director-proposals"
                aria-label="Drafts waiting on you"
                hidden={proposals.length === 0}
              >
                {proposals.length > 0 && (
                  <div className="cr-decisions-hd">
                    <span className="cr-decisions-dot" aria-hidden="true" />
                    {proposals.length === 1
                      ? 'A draft waits on you'
                      : `${proposals.length} drafts wait on you`}
                  </div>
                )}
                {proposals.map((p) => (
                  <DraftCard key={p.id} proposal={p} onDecide={(d) => decide(p, d)} />
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
                  busy={sending}
                  placeholder="Ask the Director…"
                  hint={directorHint(state)}
                  label="Message the Director"
                  inputTestid="director-composer"
                  sendTestid="director-send"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {detailsOpen && (
        <aside
          className="cr-node-details"
          data-testid="director-details"
          aria-label="Director details"
        >
          <div className="cr-node-details-hd">
            <span>Details</span>
            <IconButton
              icon="x"
              label="Hide details"
              size="sm"
              onClick={() => setDetailsOpen(false)}
            />
          </div>
          <div className="cr-node-details-body">
            <ActivitySection page={page} />
            <AutonomyList />
          </div>
        </aside>
      )}
      {detailsOpen && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the panel closes with its own button too.
        <div className="cr-node-scrim" onClick={() => setDetailsOpen(false)} />
      )}
    </section>
  );
}
