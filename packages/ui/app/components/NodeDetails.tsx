/**
 * T363: a node's details panel — everything on its page that is not the
 * conversation (design/cockpit-ui.md §3, principle 5). Sections, each shown
 * only where it applies: Delivery (a work node), Agent (its sessions),
 * Children, Waits on, Tracker, Autonomy (the coordinator's; on a project
 * root the Director's too), Project (a root's repositories and tracker),
 * Findings, About.
 */

import type {
  Autonomy,
  SessionRef,
  Stream,
  StreamFinding,
  TrackerSettings,
} from '@agile-agents/shared';
import { type PropsWithChildren, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  createNodeIssue,
  importChildren,
  linkNode,
  setNodeAutonomy,
  setProjectAutonomy,
  setProjectTracker,
  updateProject,
  waitOnStream,
} from '../lib/api';
import {
  AUTONOMY_LEVELS,
  type AutonomyWho,
  autonomyOption,
  autonomyWords,
  confirmsRun,
  inheritsOption,
  runConfirm,
} from '../lib/autonomy';
import {
  agentLabel,
  endedReasonText,
  sessionIdText,
  sessionRoleWord,
  sessionStatusWord,
} from '../lib/chat';
import { projectDrafts } from '../lib/drafts';
import { useOptionalFeed } from '../lib/feed-context';
import type {
  CockpitCardError,
  CockpitProjectRow,
  CockpitStatusCard,
  CockpitStreamRow,
  StreamPagePayload,
} from '../lib/feed-types';
import { useShell } from '../lib/shell';
import { ROLE_HINT, ROLE_LABEL } from '../lib/status';
import { childEntries, isLiveSession, sessionRows, worktreeName } from '../lib/streams';
import { Icon } from './Icon';
import { Linked } from './Markdown';
import { Button, ConfirmDialog, IconButton, RepoIcon, StatusPill, useCopy } from './ui';

type Act = (fn: () => Promise<unknown>) => Promise<void> | void;

export function DetailSection({
  title,
  aside,
  children,
  testid,
  className,
}: PropsWithChildren<{
  title: ReactNode;
  aside?: ReactNode;
  testid?: string;
  className?: string;
}>): JSX.Element {
  return (
    <section className={`cr-dsec${className ? ` ${className}` : ''}`} data-testid={testid}>
      <div className="cr-dsec-hd">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** T338: a node by its title, as a link that opens its page (never the raw id). */
export function NodeLink({
  id,
  titleOf,
}: {
  id: string;
  titleOf: (id: string) => string;
}): JSX.Element {
  const { select } = useShell();
  return (
    <a
      href={`#${id}`}
      className="cr-ref"
      data-node={id}
      title={id}
      onClick={(e) => {
        e.preventDefault();
        select(id);
      }}
    >
      {titleOf(id)}
    </a>
  );
}

// ---------------------------------------------------------------- Agent

const SESSION_STATUS_TONE: Record<SessionRef['status'], 'blue' | 'green' | 'gray' | 'red'> = {
  starting: 'blue',
  running: 'blue',
  idle: 'green',
  stopped: 'gray',
  error: 'red',
};

function SessionItem({ session }: { session: SessionRef }): JSX.Element {
  const ended = endedReasonText(session);
  return (
    <li
      className="cr-sess"
      data-testid="session"
      data-role={session.role}
      data-status={session.status}
      title={session.id}
    >
      <span
        className="cr-sess-dot"
        data-tone={SESSION_STATUS_TONE[session.status]}
        data-live={isLiveSession(session) ? 'true' : undefined}
        aria-hidden="true"
      />
      <div className="cr-sess-main">
        <div className="cr-sess-top">
          <strong className="cr-sess-role">{sessionRoleWord(session.role)}</strong>{' '}
          <span className="cr-sess-model">
            <span data-testid="session-model" title={sessionIdText(session)}>
              {agentLabel(session)}
            </span>{' '}
            · {sessionStatusWord(session.status)}
          </span>
        </div>
        {ended && (
          <div
            className="cr-sess-reason"
            data-testid="session-ended-reason"
            data-tone={ended.tone}
            title={session.ended_reason}
          >
            {ended.text}
          </div>
        )}
      </div>
    </li>
  );
}

/** T350 (D36 D4): live sessions as they are; ended ones behind one "N earlier sessions" row. */
export function SessionList({ sessions }: { sessions: readonly SessionRef[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { shown, earlier } = sessionRows(sessions);
  return (
    <ul className="cr-sess-list">
      {sessions.length === 0 && <li className="cr-sess-none">No sessions yet.</li>}
      {earlier.length > 0 && (
        <li className="cr-sess-earlier">
          <button
            type="button"
            className="cr-link"
            data-testid="sessions-earlier"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {earlier.length} earlier sessions
          </button>
        </li>
      )}
      {expanded && earlier.map((session) => <SessionItem key={session.id} session={session} />)}
      {shown.map((session) => (
        <SessionItem key={session.id} session={session} />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Children

/** A child's title; a click opens its page. (Its row carries `data-node`.) */
function ChildTitle({ id, title }: { id: string; title: string }): JSX.Element {
  const { select } = useShell();
  return (
    <button type="button" className="cr-child-title" title={title} onClick={() => select(id)}>
      {title}
    </button>
  );
}

/**
 * T283, T413: the node's children, each with its status in the words every
 * other place uses (`nodeStatus`, the rail's and the header's), and under
 * it what its agent last said it was doing (its status card), when it said.
 * Every child is listed, whether or not it ever posted a card. A project's
 * root leaves it out: its Overview lists them.
 */
export function ChildCards({
  parent,
  cards,
}: {
  parent: string;
  cards: ReadonlyArray<CockpitStatusCard | CockpitCardError>;
}): JSX.Element | null {
  const rows = useOptionalFeed()?.cockpit?.streams ?? [];
  const entries = childEntries(rows, parent, cards);
  if (entries.length === 0) return null;
  return (
    <DetailSection
      title="Children"
      testid="child-cards"
      aside={<span className="cr-count">{entries.length}</span>}
    >
      <ul className="cr-children">
        {entries.map(({ row, card, error }) => (
          <li
            key={row.id}
            className="cr-child"
            data-testid="status-card"
            data-node={row.id}
            data-state={card?.state}
          >
            <div className="cr-child-top">
              <ChildTitle id={row.id} title={row.title} />
              <StatusPill row={row} testid="status-card-state" />
            </div>
            {card !== undefined && card.doing !== '' && (
              <p className="cr-child-doing" data-testid="status-card-doing">
                {card.doing}
              </p>
            )}
            {card !== undefined && card.files.length > 0 && (
              <p className="cr-child-files" data-testid="status-card-files">
                {card.files.join(', ')}
              </p>
            )}
            {card !== undefined && card.relies_on.length > 0 && (
              <p className="cr-child-files" data-testid="status-card-relies">
                relies on <Linked text={card.relies_on.join(', ')} />
              </p>
            )}
            {error !== undefined && (
              <p className="cr-child-error" data-testid="status-card-error-text" title={error}>
                Couldn’t read what its agent last reported.
              </p>
            )}
          </li>
        ))}
      </ul>
    </DetailSection>
  );
}

// ---------------------------------------------------------------- Waits on

/** T413: a wait that is over, in words: "<node> merged, so this no longer waits on it". */
function WaitDone({ id, titleOf }: { id: string; titleOf: (id: string) => string }): JSX.Element {
  const closed =
    useOptionalFeed()?.cockpit?.streams.find((r) => r.id === id)?.human_status === 'closed';
  return (
    <>
      <NodeLink id={id} titleOf={titleOf} /> {closed ? 'closed' : 'merged'}, so this no longer waits
      on it
    </>
  );
}

export function WaitsOnSection({
  stream,
  open,
  busy,
  act,
  titleOf,
  canAdd,
  onAdd,
}: {
  stream: Stream;
  open: boolean;
  busy: boolean;
  act: Act;
  titleOf: (id: string) => string;
  canAdd: boolean;
  onAdd: () => void;
}): JSX.Element | null {
  const waits = stream.waits_on ?? [];
  if (waits.length === 0 && !open) return null;
  return (
    <DetailSection
      title="Waits on"
      aside={
        open ? (
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={busy || !canAdd}
            title="Hold this node's delivery until another node is merged"
            onClick={onAdd}
          >
            Add
          </Button>
        ) : undefined
      }
    >
      {waits.length === 0 ? (
        <p className="cr-dsec-empty">Nothing to wait for.</p>
      ) : (
        <ul className="cr-waits" data-testid="waits-on">
          {waits.map((w) => (
            <li key={w.node} data-satisfied={w.satisfied_at ? 'true' : undefined}>
              <Icon name={w.satisfied_at ? 'check-circle' : 'clock'} size={14} />
              <span className="cr-waits-text">
                {w.satisfied_at ? (
                  <WaitDone id={w.node} titleOf={titleOf} />
                ) : (
                  <>
                    Waits on <NodeLink id={w.node} titleOf={titleOf} />
                  </>
                )}
              </span>
              {open && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="waits-on-remove"
                  disabled={busy}
                  onClick={() => void act(() => waitOnStream(stream.id, w.node, true))}
                >
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

// ---------------------------------------------------------------- Tracker

/**
 * T321 (§10): the node's Jira/Linear link; linking sets the goal from the issue.
 * T347 (D36 D1): offered only when the node's project has a tracker; a node
 * already linked always shows its link. `opened` is lifted so the ⋯ menu's
 * "Tracker issue…" can open the form.
 */
export function TrackerSection({
  stream,
  project,
  rollup,
  busy,
  act,
  opened,
  setOpened,
}: {
  stream: Stream;
  project: CockpitProjectRow | undefined;
  rollup: StreamPagePayload['rollup'];
  busy: boolean;
  act: Act;
  opened: boolean;
  setOpened: (open: boolean) => void;
}): JSX.Element | null {
  const [key, setKey] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const link = stream.external_link;
  useEffect(() => {
    if (opened) input.current?.focus();
  }, [opened]);
  if (link === undefined && project?.tracker === undefined) return null;
  return (
    <DetailSection title="Tracker">
      {link !== undefined ? (
        <div className="cr-tracker" data-testid="tracker-link">
          <p className="cr-tracker-line">
            <Icon name="ticket" size={14} />
            <span>
              Linked to{' '}
              <a href={link.url} target="_blank" rel="noreferrer noopener">
                {link.key}
              </a>{' '}
              ({link.system})
            </span>
            {rollup !== undefined && (
              <span className="cr-dim" data-testid="tracker-rollup">
                {' '}
                · {rollup.merged}/{rollup.total} merged{' '}
              </span>
            )}
          </p>
          <div className="cr-dsec-actions">
            {link.kind === 'epic' ? (
              <Button
                size="sm"
                data-testid="tracker-import-children"
                disabled={busy}
                onClick={() => void act(() => importChildren(stream.id))}
              >
                Import children
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              data-testid="tracker-unlink"
              disabled={busy}
              onClick={() => void act(() => linkNode(stream.id, null))}
            >
              Unlink
            </Button>
          </div>
        </div>
      ) : !opened ? (
        <div className="cr-tracker-empty">
          <p className="cr-dsec-empty">Not linked to an issue.</p>
          <Button
            size="sm"
            icon="ticket"
            data-testid="tracker-link-open"
            title="Link this node to a Jira or Linear issue, or create one"
            disabled={busy}
            onClick={() => setOpened(true)}
          >
            Tracker issue…
          </Button>
        </div>
      ) : (
        <form
          className="cr-tracker-form"
          data-testid="tracker-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            const k = key.trim();
            if (k) void act(() => linkNode(stream.id, k).then(() => setKey('')));
          }}
        >
          <label className="cr-field-label" htmlFor={`tracker-${stream.id}`}>
            Issue key
          </label>
          <input
            id={`tracker-${stream.id}`}
            ref={input}
            data-testid="tracker-link-input"
            placeholder="SHOP-11"
            value={key}
            disabled={busy}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="cr-dsec-actions">
            <Button type="submit" size="sm" variant="primary" disabled={busy || key.trim() === ''}>
              Link
            </Button>
            <Button
              size="sm"
              data-testid="tracker-create-issue"
              title="Create an issue from this node (type a project key like SHOP, or leave empty to use the linked parent's)"
              disabled={busy || /-\d+$/.test(key.trim())}
              onClick={() =>
                void act(() =>
                  createNodeIssue(stream.id, key.trim() || undefined).then(() => setKey('')),
                )
              }
            >
              Create issue
            </Button>
          </div>
        </form>
      )}
    </DetailSection>
  );
}

// ---------------------------------------------------------------- Autonomy

/** One labelled picker in the Autonomy group, with the chosen level's sentence under it. */
function AutonomyRow({
  who,
  label,
  value,
  level,
  inherited,
  busy,
  testid,
  selectTestid,
  onChange,
}: {
  who: AutonomyWho;
  label: string;
  /** The select's value: a level, or `inherit` (a coordinating node following its project). */
  value: Autonomy | 'inherit';
  /** The level in force. */
  level: Autonomy;
  /** The project's level, for "Inherits Advise from the project"; absent where it can't inherit. */
  inherited?: Autonomy;
  busy: boolean;
  testid: string;
  selectTestid: string;
  onChange: (next: Autonomy | 'inherit') => void;
}): JSX.Element {
  const id = `${testid}-select`;
  return (
    <div className="cr-autonomy-row" data-testid={testid}>
      <label className="cr-autonomy-label" htmlFor={id}>
        {label}
      </label>
      <div className="cr-autonomy-control">
        <select
          id={id}
          data-testid={selectTestid}
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value as Autonomy | 'inherit')}
        >
          {inherited !== undefined && <option value="inherit">{inheritsOption(inherited)}</option>}
          {AUTONOMY_LEVELS.map((l) => (
            <option key={l} value={l}>
              {autonomyOption(who, l)}
            </option>
          ))}
        </select>
        <span className="cr-field-hint" data-testid={`${testid}-hint`}>
          {autonomyWords(who)[level].hint}
        </span>
      </div>
    </div>
  );
}

/**
 * T282 (§9 Autonomy): how far this node's coordinator acts on its own. On
 * a project root it sets the project's level; elsewhere it overrides it.
 * T347 (D36 D6): only where a coordinator runs, a coordinating node or a root.
 * T423 (audit finding 15): one Autonomy group — Coordinator, and on a root
 * the project's Director (§12) — each level in words with its sentence. A
 * change saves at once, but a change up to Run (the agent acts without
 * asking) is confirmed first.
 */
export function AutonomySection({
  stream,
  role,
  project,
  busy,
  act,
}: {
  stream: Stream;
  role: CockpitStreamRow['role'] | undefined;
  project: CockpitProjectRow | undefined;
  busy: boolean;
  act: Act;
}): JSX.Element | null {
  const [asking, setAsking] = useState<{ who: AutonomyWho; apply: () => void } | undefined>(
    undefined,
  );
  if (project === undefined) return null;
  const isRoot = project.root === stream.id;
  if (!isRoot && role !== 'coordinating') return null;
  const inherited = project.autonomy?.coordinator ?? 'advise';
  const coordinatorValue: Autonomy | 'inherit' = isRoot
    ? inherited
    : (stream.autonomy ?? 'inherit');
  const coordinatorLevel = coordinatorValue === 'inherit' ? inherited : coordinatorValue;
  const directorLevel = project.autonomy?.director ?? 'advise';
  /** Saves at once, unless it raises the level to Run: that asks first. */
  const change = (who: AutonomyWho, before: Autonomy, after: Autonomy, save: () => void): void => {
    if (confirmsRun(before, after)) setAsking({ who, apply: save });
    else save();
  };
  const confirm = asking ? runConfirm(asking.who, project.name) : undefined;
  return (
    <DetailSection title="Autonomy" testid="autonomy-group">
      <AutonomyRow
        who="coordinator"
        label="Coordinator"
        value={coordinatorValue}
        level={coordinatorLevel}
        {...(isRoot ? {} : { inherited })}
        busy={busy}
        testid="autonomy"
        selectTestid="autonomy-select"
        onChange={(next) => {
          const after = next === 'inherit' ? inherited : next;
          change(
            'coordinator',
            coordinatorLevel,
            after,
            () =>
              void act(() =>
                isRoot
                  ? setProjectAutonomy(project.id, { coordinator: after })
                  : setNodeAutonomy(stream.id, next === 'inherit' ? null : next),
              ),
          );
        }}
      />
      {isRoot && (
        <AutonomyRow
          who="director"
          label="Director"
          value={directorLevel}
          level={directorLevel}
          busy={busy}
          testid="director-autonomy"
          selectTestid="director-autonomy-select"
          onChange={(next) => {
            if (next === 'inherit') return;
            change(
              'director',
              directorLevel,
              next,
              () => void act(() => setProjectAutonomy(project.id, { director: next })),
            );
          }}
        />
      )}
      <ConfirmDialog
        open={confirm !== undefined}
        title={confirm?.title ?? ''}
        confirmLabel={confirm?.confirm ?? 'Set to Run'}
        testid="autonomy-run-confirm"
        onCancel={() => setAsking(undefined)}
        onConfirm={() => {
          asking?.apply();
          setAsking(undefined);
        }}
      >
        <p className="cr-confirm-text">{confirm?.body}</p>
      </ConfirmDialog>
    </DetailSection>
  );
}

// ---------------------------------------------------------------- Project

/**
 * T377: the project's repositories, editable in place (T372's route): every
 * registered repo with its icon, ticked when the project uses it. New nodes
 * offer the project's repos first. T423: part of the Project group's one Save.
 */
function ProjectRepos({
  current,
  chosen,
  setChosen,
  busy,
}: {
  current: readonly string[];
  chosen: readonly string[];
  setChosen: (next: string[]) => void;
  busy: boolean;
}): JSX.Element {
  const all = useOptionalFeed()?.cockpit?.repos ?? [];
  const names = [...new Set([...all.map((r) => r.name), ...current])].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    <div className="cr-dsec-field" data-testid="project-repos">
      <span className="cr-field-label">Repositories</span>
      {names.length === 0 ? (
        <p className="cr-dsec-note">No repositories registered yet (Settings → Repositories).</p>
      ) : (
        <div className="cr-checklist cr-checklist-compact">
          {names.map((name) => {
            const on = chosen.includes(name);
            return (
              <label key={name} className="cr-check-row" data-checked={on ? 'true' : undefined}>
                <input
                  type="checkbox"
                  data-testid="project-repo"
                  data-repo={name}
                  checked={on}
                  disabled={busy}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked ? [...chosen, name] : chosen.filter((x) => x !== name),
                    )
                  }
                />
                <RepoIcon remote={all.find((r) => r.name === name)?.remote} size={14} />
                <span className="cr-check-name">{name}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

type StatusMapKey = 'in_progress' | 'in_review' | 'done';
const STATUS_MAP_FIELDS: ReadonlyArray<{ key: StatusMapKey; label: string }> = [
  { key: 'in_progress', label: 'In progress' },
  { key: 'in_review', label: 'In review' },
  { key: 'done', label: 'Done' },
];

interface TrackerDraft {
  system: '' | 'jira' | 'linear';
  push: boolean;
  map: Record<StatusMapKey, string>;
}

function trackerDraft(tracker: TrackerSettings | undefined): TrackerDraft {
  return {
    system: tracker?.system ?? '',
    push: tracker?.push_status ?? false,
    map: {
      in_progress: tracker?.status_map?.in_progress ?? '',
      in_review: tracker?.status_map?.in_review ?? '',
      done: tracker?.status_map?.done ?? '',
    },
  };
}

function sameTracker(a: TrackerDraft, b: TrackerDraft): boolean {
  if (a.system !== b.system) return false;
  if (a.system === '') return true;
  return (
    a.push === b.push && STATUS_MAP_FIELDS.every((f) => a.map[f.key].trim() === b.map[f.key].trim())
  );
}

/**
 * T338: a project's own controls, on its root node's page: its
 * repositories and the tracker block (§10: system, push status, status
 * map). Credentials stay in Settings → Trackers. T423: one Save for the
 * group (with Cancel), shown once something in it changed; the autonomy
 * levels are the Autonomy group's.
 */
export function ProjectSection({
  project,
  busy,
  act,
}: {
  project: CockpitProjectRow;
  busy: boolean;
  act: Act;
}): JSX.Element {
  // A fresh form whenever the saved project changes (a save, or a change made elsewhere).
  const key = `${(project.repos ?? []).join(',')}|${JSON.stringify(project.tracker ?? null)}`;
  return <ProjectForm key={key} base={key} project={project} busy={busy} act={act} />;
}

function ProjectForm({
  project,
  base,
  busy,
  act,
}: {
  project: CockpitProjectRow;
  /** The saved settings the form starts from (its key). */
  base: string;
  busy: boolean;
  act: Act;
}): JSX.Element {
  const tracker = project.tracker;
  const current = project.repos;
  const saved = trackerDraft(tracker);
  // T436 (audit r6 #22): unsaved changes wait for you, per project, when you go elsewhere
  // (or reload), until Save or Cancel; a draft over settings changed since is dropped.
  const [kept] = useState(() => {
    const d = projectDrafts.get(project.id);
    return d !== undefined && d.base === base ? d : undefined;
  });
  const [repos, setRepos] = useState<string[]>(() => kept?.repos ?? [...(current ?? [])]);
  const [draft, setDraft] = useState<TrackerDraft>(() => kept?.tracker ?? saved);
  const reposDirty =
    current !== undefined &&
    (repos.length !== current.length || repos.some((name) => !current.includes(name)));
  const trackerDirty = !sameTracker(draft, saved);
  const dirty = reposDirty || trackerDirty;
  useEffect(() => {
    projectDrafts.set(project.id, dirty ? { base, repos, tracker: draft } : undefined);
  }, [project.id, base, dirty, repos, draft]);
  function save(): void {
    if (!dirty) return;
    void act(async () => {
      if (reposDirty) await updateProject(project.id, { repos });
      if (!trackerDirty) return;
      if (draft.system === '') {
        await setProjectTracker(project.id, null);
        return;
      }
      const statusMap = Object.fromEntries(
        STATUS_MAP_FIELDS.map((f) => [f.key, draft.map[f.key].trim()]).filter(([, v]) => v !== ''),
      );
      await setProjectTracker(project.id, {
        system: draft.system,
        ...(tracker?.base_url !== undefined ? { base_url: tracker.base_url } : {}),
        push_status: draft.push,
        ...(Object.keys(statusMap).length > 0 ? { status_map: statusMap } : {}),
      });
    });
  }
  return (
    <DetailSection title="Project" testid="project-controls" className="cr-project-controls">
      <form
        className="cr-dsec-form"
        data-testid="project-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {current !== undefined && (
          <ProjectRepos current={current} chosen={repos} setChosen={setRepos} busy={busy} />
        )}
        <div className="cr-dsec-form" data-testid="project-tracker-form">
          <label className="cr-dsec-field">
            <span className="cr-field-label">Tracker</span>
            <select
              data-testid="project-tracker-system"
              value={draft.system}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, system: e.target.value as TrackerDraft['system'] })
              }
            >
              <option value="">None</option>
              <option value="jira">Jira</option>
              <option value="linear">Linear</option>
            </select>
          </label>
          {draft.system !== '' && (
            <>
              <label className="cr-dsec-check">
                <input
                  type="checkbox"
                  data-testid="project-tracker-push"
                  checked={draft.push}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, push: e.target.checked })}
                />
                Push status to the tracker
              </label>
              {STATUS_MAP_FIELDS.map((f) => (
                <label key={f.key} className="cr-dsec-field">
                  <span className="cr-field-label">{f.label}</span>
                  <input
                    data-testid={`project-tracker-map-${f.key}`}
                    value={draft.map[f.key]}
                    placeholder="Its status in the tracker"
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, map: { ...draft.map, [f.key]: e.target.value } })
                    }
                  />
                </label>
              ))}
            </>
          )}
        </div>
        {dirty && (
          <div className="cr-dsec-actions" data-testid="project-save-bar">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              data-testid="project-save"
              busy={busy}
            >
              Save changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="project-cancel"
              onClick={() => {
                setRepos([...(current ?? [])]);
                setDraft(saved);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </form>
    </DetailSection>
  );
}

// ---------------------------------------------------------------- Findings

export function FindingsSection({
  findings,
}: {
  findings: readonly StreamFinding[];
}): JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <DetailSection
      title="Findings"
      testid="findings"
      aside={<span className="cr-count">{findings.length}</span>}
    >
      <ul className="cr-findings-list">
        {findings.map((finding, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: findings are append-only.
            key={i}
            data-testid="finding"
            data-severity={finding.severity}
          >
            <span className="sev" data-severity={finding.severity}>
              {finding.severity}
            </span>{' '}
            <code>
              {finding.file}
              {finding.line !== undefined ? `:${finding.line}` : ''}
            </code>{' '}
            — {finding.text}
          </li>
        ))}
      </ul>
    </DetailSection>
  );
}

// ---------------------------------------------------------------- About

/**
 * T413: the goal, in the details panel, when the chat leaves its Goal card
 * out (a project's root, or a goal that only repeats the title): still read
 * and edited here (Edit, then Save; Esc cancels).
 */
function GoalField({
  goal,
  onSave,
}: {
  goal: string;
  onSave?: (goal: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
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
  if (draft !== undefined) {
    return (
      <form
        className="cr-about-goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <textarea
          className="cr-about-goal-input"
          data-testid="goal-input"
          aria-label="Goal"
          value={draft}
          rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
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
        <div className="cr-dsec-actions">
          <Button size="sm" variant="primary" type="submit" busy={busy} data-testid="goal-save">
            Save goal
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="cr-about-goal" data-testid="about-goal">
      <span className="cr-about-goal-text" data-testid="about-goal-text">
        {goal}
      </span>
      {onSave && (
        <button
          type="button"
          className="cr-link cr-about-goal-edit"
          data-testid="goal-edit"
          title="Edit the goal. The agent reads the new goal on its next turn."
          onClick={() => setDraft(goal)}
        >
          Edit
        </button>
      )}
    </div>
  );
}

export function AboutSection({
  stream,
  role,
  goal,
}: {
  stream: Stream;
  role: CockpitStreamRow['role'] | undefined;
  /** T413: the goal, when the chat shows no Goal card; `onSave` where it may change. */
  goal?: { onSave?: (goal: string) => Promise<void> };
}): JSX.Element {
  const copy = useCopy();
  const created = new Date(stream.created_at);
  return (
    <DetailSection title="About">
      <dl className="cr-about">
        {role && (
          <>
            <dt>Role</dt>
            <dd>
              {ROLE_LABEL[role]}
              <span className="cr-about-hint">{ROLE_HINT[role]}</span>
            </dd>
          </>
        )}
        {goal && (
          <>
            <dt>Goal</dt>
            <dd>
              <GoalField
                key={stream.goal}
                goal={stream.goal}
                {...(goal.onSave ? { onSave: goal.onSave } : {})}
              />
            </dd>
          </>
        )}
        {stream.repo && (
          <>
            <dt>Repo</dt>
            <dd>{stream.repo}</dd>
          </>
        )}
        {stream.worktree && (
          <>
            <dt>Worktree</dt>
            {/* T413: the path is long and all id; it copies, and reads in the tooltip. */}
            <dd className="cr-about-worktree">
              <span className="cr-about-worktree-name">{worktreeName(stream.worktree)}</span>
              <button
                type="button"
                className="cr-link"
                data-testid="copy-worktree"
                title={stream.worktree}
                onClick={() => copy(stream.worktree ?? '', 'Copied the worktree path')}
              >
                <Icon name="copy" size={12} />
                Copy path
              </button>
            </dd>
          </>
        )}
        <dt>Created</dt>
        <dd>{Number.isNaN(created.getTime()) ? stream.created_at : created.toLocaleString()}</dd>
      </dl>
    </DetailSection>
  );
}

// ---------------------------------------------------------------- the agent section

/**
 * The node's agent: what runs (or what a start runs), its sessions, and Ask
 * an agent to review…. T423: the model is picked in one place, the
 * composer's chip (and the header's Start with…); this only shows it.
 */
export function AgentSection({
  stream,
  live,
  startWith,
  busy,
  onReview,
  canReview,
}: {
  stream: Stream;
  /** The live agent's model in words, if one runs. */
  live?: SessionRef;
  /** What a start would run. */
  startWith?: string;
  busy: boolean;
  onReview?: () => void;
  canReview: boolean;
}): JSX.Element {
  return (
    <DetailSection
      title="Agent"
      aside={
        <span className="cr-dsec-sub" title={live ? sessionIdText(live) : undefined}>
          {live ? agentLabel(live) : startWith ? `Starts as ${startWith}` : ''}
        </span>
      }
    >
      <div data-testid="sessions" className="cr-sessions-box">
        <SessionList key={stream.id} sessions={stream.sessions} />
      </div>
      {onReview && (
        <div className="cr-dsec-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="eye"
            disabled={busy || !canReview}
            onClick={onReview}
          >
            Ask an agent to review…
          </Button>
        </div>
      )}
    </DetailSection>
  );
}

/** The panel's shell: a header with its close button, then the sections. */
export function DetailsPanel({
  children,
  onClose,
}: PropsWithChildren<{ onClose: () => void }>): JSX.Element {
  // Below 1200px the panel slides over the page: Escape puts it away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && window.innerWidth < 1200) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="cr-node-details" data-testid="node-details" aria-label="Node details">
      <div className="cr-node-details-hd">
        <span>Details</span>
        <IconButton icon="x" label="Hide details" size="sm" onClick={onClose} />
      </div>
      <div className="cr-node-details-body">{children}</div>
    </aside>
  );
}
