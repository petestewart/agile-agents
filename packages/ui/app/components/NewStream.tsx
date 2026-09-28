/**
 * T162: "New node" from anywhere (cockpit design §9), opened by the
 * sidebar's button or the `n` key; on create, the new node's page opens.
 *
 * T365 (design/cockpit-ui.md §1.4, "defaults, not forms"): it leads with
 * what the agent should do (the goal; its first line is the title, shown
 * and editable). The project is asked only when nothing implies it (a row's
 * `+`, the open node, the rail's filter, a single project). Parent is
 * searchable within the project and defaults to the open node (T353: from
 * the first render). Repository picks the role: none is a Conversation, a
 * repo is Work on its own branch. "Start the agent now" is on, with the
 * model it will use named; Change picks another for this node.
 * Cmd/Ctrl+Enter creates from anywhere in the form, Enter from the title
 * (T435: not Enter in the goal, which is a long description, often several
 * paragraphs — design/cockpit-ui.md §7).
 *
 * T435: a proposal's Create node… opens it next to the proposing node, on
 * its repository (`NewStreamPreset.repo`); nested under a work node with a
 * repository, the Parent's hint says that node will coordinate it.
 */

import type { SessionDefaultsStatus } from '@agile-agents/shared';
import { Suspense, useEffect, useMemo, useState } from 'react';
import {
  type QuickDrafts,
  type RepoRow,
  attachSession,
  createStream,
  getQuickDrafts,
  getSessionDefaults,
  listRepos,
  sayOnStream,
} from '../lib/api';
import { coordinatesIt, focusComposerOn } from '../lib/ask';
import { agentLabel, sessionIdText } from '../lib/chat';
import { resolvedFor } from '../lib/defaults';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow, CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import { type NewStreamPreset, isShortcut, useShell } from '../lib/shell';
import { ROLE_LABEL } from '../lib/status';
import {
  defaultRepoOf,
  newNodeDefaults,
  projectOutline,
  splitRepos,
  titleFromGoal,
} from '../lib/tree';
import { lazyNamed } from './ErrorBoundary';
import { Icon } from './Icon';
import { type PickOption, PickerField } from './Pickers';
import { type SessionChoice, SessionFields } from './SessionPicker';
import { ROLE_GLYPH } from './StreamTree';
import { Button, Dialog, EmptyState, Field, Kbd, RepoIcon, repoKindLabel, useToast } from './ui';

// T408: loaded when first opened (New node is always mounted, for `n`); warmed after load (`App.tsx`).
const AddRepoDialog = lazyNamed(() => import('./AddRepo'), 'AddRepoDialog');

const LAST_PROJECT_KEY = 'agile.newnode.project';

function loadLastProject(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveLastProject(id: string | undefined): void {
  if (id === undefined) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // Storage blocked: the next New node just defaults to the first project.
  }
}

/** A repo as the picker shows it: the cockpit's row, with its path when Settings' list has it. */
type RepoInfo = CockpitRepoRow & { path?: string };

/** The cockpit frame's repos, with anything newer from `GET /api/repos` (T206: a repo just added in Settings). */
export function useRepoList(): RepoInfo[] {
  const live = useOptionalFeed()?.cockpit?.repos;
  const [fetched, setFetched] = useState<RepoRow[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    listRepos()
      .then((rows) => {
        if (alive) setFetched(rows);
      })
      .catch(() => {
        if (alive) setFetched([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  return useMemo(() => {
    const byName = new Map<string, RepoInfo>();
    for (const r of live ?? []) byName.set(r.name, { ...r });
    for (const r of fetched ?? []) {
      const known = byName.get(r.name);
      byName.set(r.name, {
        name: r.name,
        delivery: r.delivery,
        path: r.path,
        ...((known?.remote ?? r.remote) !== undefined ? { remote: known?.remote ?? r.remote } : {}),
      });
    }
    return [...byName.values()];
  }, [live, fetched]);
}

export function NewStream({
  rows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element | null {
  const { newStreamOpen, setNewStreamOpen, selected, newStreamPreset } = useShell();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!newStreamOpen && isShortcut(event, 'n')) {
        // Not over another dialog (a rename, a confirm).
        if (document.querySelector('.cr-modal')) return;
        event.preventDefault();
        setNewStreamOpen(true);
      } else if (newStreamOpen && event.key === 'Escape') {
        setNewStreamOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newStreamOpen, setNewStreamOpen]);

  if (!newStreamOpen) return null;
  // T353: each opening (and a change of the open node) mounts a fresh form
  // whose first render already holds the default parent. Resetting it in an
  // effect after mount left one render with the last opening's parent, which
  // a fast reader (or a quick submit) could see as "— none —".
  const key = `${selected ?? ''}|${newStreamPreset?.parent ?? ''}|${newStreamPreset?.project ?? ''}|${newStreamPreset?.title ?? ''}|${newStreamPreset?.repo ?? ''}`;
  return <NewStreamForm key={key} rows={rows} projects={projects} preset={newStreamPreset} />;
}

function NewStreamForm({
  rows,
  projects,
  preset,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
  preset: NewStreamPreset | undefined;
}): JSX.Element {
  const { setNewStreamOpen, select, selected, project: filter, setNewProjectOpen } = useShell();
  const feed = useOptionalFeed();
  const toast = useToast();
  const repos = useRepoList();
  const [defaults] = useState(() =>
    newNodeDefaults({ preset, selected, filter, rows, projects, lastUsed: loadLastProject() }),
  );
  const [goal, setGoal] = useState(preset?.goal ?? '');
  // `undefined` follows the goal's first line; typing in the title takes it over.
  const [title, setTitle] = useState<string | undefined>(preset?.title);
  const [projectId, setProjectId] = useState(defaults.project);
  const [parent, setParent] = useState(defaults.parent);
  // T435 (#14): a proposal's node starts on the proposing node's repository. T445 (audit r7
  // #12): else, in a project with one repository, on that one ("No repository" is a pick away).
  // `undefined` follows the project's default; a pick (even "No repository") takes it over.
  const [repoPick, setRepo] = useState<string | undefined>(preset?.repo);
  // T373: Add a repository from here; the new repo is picked.
  const [addingRepo, setAddingRepo] = useState(false);
  const [start, setStart] = useState(true);
  // T477: no goal yet: the text is your first message, and you set the goal once you've talked.
  const [talkFirst, setTalkFirst] = useState(false);
  const [session, setSession] = useState<SessionDefaultsStatus | undefined>(undefined);
  // Set once "Change" is pressed: this node's own vendor, model and effort.
  const [choice, setChoice] = useState<SessionChoice | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // T445 (audit r7 #11): a title is only promised when the cheap model is on and there.
  const [drafts, setDrafts] = useState<QuickDrafts | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    getQuickDrafts()
      .then((status) => {
        if (alive) setDrafts(status);
      })
      .catch(() => {
        // Unknown: the hint promises nothing.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getSessionDefaults()
      .then((status) => {
        if (alive) setSession(status);
      })
      .catch(() => {
        // The model line just says "the default model".
      });
    return () => {
      alive = false;
    };
  }, []);

  // Opened before the first cockpit frame (a quick `n` on load): pick up the projects when they arrive.
  useEffect(() => {
    if (projectId !== undefined || parent !== '' || projects.length === 0) return;
    setProjectId(
      newNodeDefaults({ preset, selected, filter, rows, projects, lastUsed: loadLastProject() })
        .project,
    );
  }, [projectId, parent, projects, preset, selected, filter, rows]);

  const close = (): void => setNewStreamOpen(false);
  const derived = titleFromGoal(goal);
  const finalTitle = (title ?? '').trim() || derived;
  // T414 (D41): a title you didn't write is a placeholder the daemon replaces with a better one.
  const ownTitle = (title ?? '').trim() !== '' && title !== derived;
  const projectRow = projects.find((p) => p.id === projectId);
  const projectLabel = projectRow?.name;
  const defaultRepo = defaultRepoOf(
    projectRow?.repos,
    repos.map((r) => r.name),
  );
  const repo = repoPick ?? defaultRepo;
  const outline = useMemo(() => projectOutline(rows, projectId), [rows, projectId]);
  const parentRow = parent ? rows.find((r) => r.id === parent) : undefined;
  const resolved = session
    ? resolvedFor(session, repo || undefined, projectRow?.session)
    : undefined;
  const custom =
    choice !== undefined &&
    resolved !== undefined &&
    (choice.vendor !== resolved.vendor ||
      choice.model.trim() !== (resolved.model ?? '') ||
      choice.effort !== resolved.effort);
  const needsProject = parent === '' && projectId === undefined;
  // T435 (#3): a node with a repository under a work node makes that node coordinate it.
  const coordinates = repo !== '' ? coordinatesIt(parentRow) : undefined;

  const submit = async (): Promise<void> => {
    if (busy || finalTitle === '' || needsProject) return;
    setBusy(true);
    setError(undefined);
    try {
      const opener = goal.trim();
      const created = await createStream({
        title: finalTitle,
        ...(talkFirst ? {} : { goal: opener || finalTitle }),
        ...(parent ? { parent } : projectId !== undefined ? { project: projectId } : {}),
        ...(repo ? { repo } : {}),
        // A picked model starts it below, through the sessions' own attach; T477: a node with
        // no goal starts on your first message instead.
        ...(!start || custom || talkFirst ? { start: false } : {}),
        ...(!ownTitle && opener !== '' ? { auto_title: true } : {}),
      });
      if (talkFirst && opener !== '') {
        const model = choice?.model.trim();
        await sayOnStream(created.id, opener, {
          ...(start ? { start: true } : {}),
          ...(start && custom && choice
            ? {
                session: {
                  vendor: choice.vendor,
                  effort: choice.effort,
                  ...(model ? { model } : {}),
                },
              }
            : {}),
        }).catch((err: unknown) =>
          toast({
            title: 'The node was made, but your message didn’t reach it',
            body: err instanceof Error ? err.message : String(err),
            tone: 'error',
          }),
        );
      } else if (start && custom && choice) {
        const model = choice.model.trim();
        await attachSession(created.id, 'worker', {
          vendor: choice.vendor,
          effort: choice.effort,
          ...(model ? { model } : {}),
        }).catch((err: unknown) =>
          toast({
            title: 'The node was made, but its agent didn’t start',
            body: err instanceof Error ? err.message : String(err),
            tone: 'error',
          }),
        );
      }
      saveLastProject(parentRow?.project ?? projectId);
      // T445 (audit r7 #13): the new node's composer takes focus once its page shows.
      focusComposerOn(created.id);
      close();
      select(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Nothing to file into: no project, and no parent to take one from.
  if (projectId === undefined && parent === '') {
    return (
      <Dialog open onClose={close} title="New node" testid="new-stream" size="sm">
        <EmptyState
          icon="layers"
          title="Make a project first"
          testid="new-stream-no-project"
          actions={
            <Button
              variant="primary"
              icon="plus"
              data-autofocus
              onClick={() => {
                close();
                setNewProjectOpen(true);
              }}
            >
              New project
            </Button>
          }
        >
          Every node belongs to a project: the product it works on and the repositories it may use.
        </EmptyState>
      </Dialog>
    );
  }

  // ---- Parent: the project's top level, or any node in it.
  const parentOptions: PickOption[] = [
    {
      value: '',
      text: projectLabel ? `Top level of ${projectLabel}` : 'Top level',
      icon: <Icon name="layers" size={14} />,
      pinned: true,
      attrs: { 'data-node': '' },
    },
    ...outline
      .filter((o) => o.row.role !== 'project')
      .map(
        ({ row, depth }): PickOption => ({
          value: row.id,
          text: row.title,
          icon: <Icon name={ROLE_GLYPH[row.role]} size={14} />,
          depth: projectId !== undefined ? depth - 1 : depth,
          attrs: { 'data-node': row.id },
        }),
      ),
  ];
  const parentDisplay = parentRow ? (
    <>
      <Icon name={ROLE_GLYPH[parentRow.role]} size={14} />
      <span className="cr-pickfield-text">{parentRow.title}</span>
    </>
  ) : (
    <>
      <Icon name="layers" size={14} />
      <span className="cr-pickfield-text">
        {projectLabel ? `Top level of ${projectLabel}` : 'Top level'}
      </span>
    </>
  );

  // ---- Repository: none (a Conversation), the project's, the others.
  const { inProject, others } = splitRepos(repos, projectRow?.repos);
  const repoOption = (r: RepoInfo, group: string): PickOption => ({
    value: r.name,
    text: r.name,
    icon: <RepoIcon remote={r.remote} size={14} />,
    sub: repoKindLabel(r.remote),
    group,
    attrs: { 'data-repo': r.name },
  });
  const repoOptions: PickOption[] = [
    {
      value: '',
      text: 'No repository',
      icon: <Icon name="message-square" size={14} />,
      sub: 'Conversation',
      pinned: true,
      attrs: { 'data-repo': '' },
    },
    ...inProject.map((r) => repoOption(r, `In ${projectLabel ?? 'this project'}`)),
    ...others.map((r) =>
      repoOption(r, inProject.length > 0 ? 'Other repositories' : 'Repositories'),
    ),
  ];
  const repoRow = repos.find((r) => r.name === repo);
  const repoDisplay = repo ? (
    <>
      <RepoIcon remote={repoRow?.remote} size={14} />
      <span className="cr-pickfield-text">{repo}</span>
      <span className="cr-pickfield-sub">{repoKindLabel(repoRow?.remote)}</span>
    </>
  ) : (
    <>
      <Icon name="message-square" size={14} />
      <span className="cr-pickfield-text">No repository</span>
    </>
  );

  // T386: the model in words, as the composer and Running say it; the ids on hover.
  const startsWith = choice
    ? {
        vendor: choice.vendor,
        ...(choice.model.trim() !== '' ? { model: choice.model.trim() } : {}),
        effort: choice.effort,
      }
    : resolved;
  const modelName = startsWith ? agentLabel(startsWith) : 'the default model';
  const modelIds = startsWith ? sessionIdText(startsWith) : undefined;

  return (
    <Dialog
      open
      onClose={close}
      title="New node"
      description={
        defaults.implied && projectLabel ? (
          <>
            In <b>{projectLabel}</b>
          </>
        ) : undefined
      }
      size="md"
      testid="new-stream"
      label="New node"
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="cr-newnode-keys">
            <Kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>↵</Kbd> to create
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={finalTitle === '' || needsProject}
            data-testid="new-stream-create"
          >
            Create node
          </Button>
        </>
      }
    >
      <div
        className="cr-newnode"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field
          label={talkFirst ? 'What do you want to talk through?' : 'What should the agent do?'}
          htmlFor="cr-newnode-goal"
        >
          <textarea
            id="cr-newnode-goal"
            className="cr-newnode-goal"
            data-testid="new-stream-goal"
            data-autofocus
            rows={4}
            placeholder={
              talkFirst
                ? 'Your first message. You give it a goal once you’ve talked it through.'
                : 'Describe the task, or ask a question.'
            }
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>
        <label className="cr-switch-row cr-newnode-talk">
          <input
            type="checkbox"
            role="switch"
            aria-checked={talkFirst}
            className="cr-switch"
            data-testid="new-stream-talk-first"
            checked={talkFirst}
            onChange={(e) => setTalkFirst(e.target.checked)}
          />
          <span className="cr-switch-label">No goal yet: talk it through first</span>
        </label>
        <Field
          label="Title"
          htmlFor="cr-newnode-title"
          {...(ownTitle
            ? {}
            : {
                hint:
                  drafts?.on === true && drafts.available
                    ? 'Left as is, a short title is written for you once it’s made.'
                    : 'The goal’s first line — edit it if you like.',
              })}
        >
          <input
            id="cr-newnode-title"
            data-testid="new-stream-title"
            value={title ?? derived}
            placeholder={derived || 'A short name for the node'}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="cr-newnode-grid">
          {!defaults.implied && projects.length > 1 && (
            <Field label="Project" htmlFor="cr-newnode-project">
              <select
                id="cr-newnode-project"
                data-testid="new-stream-project"
                value={projectId ?? ''}
                onChange={(e) => {
                  setProjectId(e.target.value || undefined);
                  setParent('');
                  // Another project: its own default repository, unless a proposal named one.
                  if (preset?.repo === undefined) setRepo(undefined);
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="Parent"
            hint={
              coordinates !== undefined ? (
                <span data-testid="new-stream-coordinates">{coordinates}</span>
              ) : (
                'Optional. Nest it under another node in this project.'
              )
            }
          >
            <PickerField
              testid="new-stream-parent"
              label="Parent"
              value={parent}
              display={parentDisplay}
              options={parentOptions}
              placeholder="Search nodes…"
              onPick={setParent}
            />
          </Field>
        </div>
        <Field
          label="Repository"
          hint={
            <>
              {repo ? (
                <>
                  <b>{ROLE_LABEL.work}</b>: writes code on its own branch in {repo}, then hands it
                  to you to merge.
                  {repoPick === undefined && (
                    // T445 (audit r7 #12): the project's one repository was picked for you.
                    <>
                      {' '}
                      <button
                        type="button"
                        className="cr-link"
                        data-testid="new-stream-no-repo"
                        onClick={() => setRepo('')}
                      >
                        Just talk instead
                      </button>
                      {' ·'}
                    </>
                  )}
                </>
              ) : (
                <>
                  <b>{ROLE_LABEL.conversation}</b>: talks, researches and answers. No repository, no
                  branch.
                </>
              )}{' '}
              <button
                type="button"
                className="cr-link"
                data-testid="new-stream-add-repo"
                onClick={() => setAddingRepo(true)}
              >
                Add a repository…
              </button>
            </>
          }
        >
          <PickerField
            testid="new-stream-repo"
            label="Repository"
            value={repo}
            display={repoDisplay}
            options={repoOptions}
            placeholder="Search repositories…"
            search={repos.length > 6}
            onPick={setRepo}
          />
        </Field>
        <div className="cr-newnode-start" data-on={start ? 'true' : 'false'}>
          <label className="cr-switch-row">
            <input
              type="checkbox"
              role="switch"
              aria-checked={start}
              className="cr-switch"
              data-testid="new-stream-start"
              checked={start}
              onChange={(e) => setStart(e.target.checked)}
            />
            <span className="cr-switch-label">Start the agent now</span>
          </label>
          <div className="cr-newnode-model" data-testid="new-stream-model">
            {start ? (
              <>
                <Icon name="bot" size={14} />
                <span title={modelIds}>
                  <b>{modelName}</b>
                </span>
                {session && !choice ? (
                  <button
                    type="button"
                    className="cr-link"
                    data-testid="new-stream-model-change"
                    onClick={() =>
                      resolved &&
                      setChoice({
                        vendor: resolved.vendor,
                        model: resolved.model ?? '',
                        effort: resolved.effort,
                      })
                    }
                  >
                    Change
                  </button>
                ) : null}
              </>
            ) : (
              <span className="cr-faint">
                It waits. Start its agent from its page when you’re ready.
              </span>
            )}
          </div>
          {start && choice && session ? (
            <div className="cr-newnode-session">
              <SessionFields
                status={session}
                value={choice}
                onChange={setChoice}
                testid="new-stream-session"
              />
              <button
                type="button"
                className="cr-link"
                data-testid="new-stream-model-reset"
                onClick={() => setChoice(undefined)}
              >
                Use the default
              </button>
            </div>
          ) : null}
        </div>
        {error && (
          <p className="cr-error" role="alert" data-testid="new-stream-error">
            {error}
          </p>
        )}
      </div>
      {addingRepo && (
        <Suspense fallback={null}>
          <AddRepoDialog
            open
            onClose={() => setAddingRepo(false)}
            onAdded={(added) => {
              setRepo(added);
              feed?.refresh();
            }}
          />
        </Suspense>
      )}
    </Dialog>
  );
}
