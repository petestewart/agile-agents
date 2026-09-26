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
 * Cmd/Ctrl+Enter creates from anywhere in the form, Enter from the title.
 */

import type { SessionDefaultsStatus } from '@agile-agents/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  type RepoRow,
  attachSession,
  createStream,
  getSessionDefaults,
  listRepos,
} from '../lib/api';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow, CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import { type NewStreamPreset, isShortcut, useShell } from '../lib/shell';
import { ROLE_LABEL } from '../lib/status';
import { newNodeDefaults, projectOutline, splitRepos, titleFromGoal } from '../lib/tree';
import { Icon } from './Icon';
import { type PickOption, PickerField } from './Pickers';
import { type SessionChoice, SessionFields, resolvedFor } from './SessionPicker';
import { ROLE_GLYPH } from './StreamTree';
import { Button, Dialog, EmptyState, Field, Kbd, RepoIcon, repoKindLabel, useToast } from './ui';

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
  const key = `${selected ?? ''}|${newStreamPreset?.parent ?? ''}|${newStreamPreset?.project ?? ''}`;
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
  const toast = useToast();
  const repos = useRepoList();
  const [defaults] = useState(() =>
    newNodeDefaults({ preset, selected, filter, rows, projects, lastUsed: loadLastProject() }),
  );
  const [goal, setGoal] = useState('');
  // `undefined` follows the goal's first line; typing in the title takes it over.
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [projectId, setProjectId] = useState(defaults.project);
  const [parent, setParent] = useState(defaults.parent);
  const [repo, setRepo] = useState('');
  const [start, setStart] = useState(true);
  const [session, setSession] = useState<SessionDefaultsStatus | undefined>(undefined);
  // Set once "Change" is pressed: this node's own vendor, model and effort.
  const [choice, setChoice] = useState<SessionChoice | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

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

  const close = (): void => setNewStreamOpen(false);
  const derived = titleFromGoal(goal);
  const finalTitle = (title ?? '').trim() || derived;
  const projectRow = projects.find((p) => p.id === projectId);
  const projectLabel = projectRow?.name;
  const outline = useMemo(() => projectOutline(rows, projectId), [rows, projectId]);
  const parentRow = parent ? rows.find((r) => r.id === parent) : undefined;
  const resolved = session ? resolvedFor(session, repo || undefined) : undefined;
  const custom =
    choice !== undefined &&
    resolved !== undefined &&
    (choice.vendor !== resolved.vendor ||
      choice.model.trim() !== (resolved.model ?? '') ||
      choice.effort !== resolved.effort);
  const needsProject = parent === '' && projectId === undefined;

  const submit = async (): Promise<void> => {
    if (busy || finalTitle === '' || needsProject) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await createStream({
        title: finalTitle,
        goal: goal.trim() || finalTitle,
        ...(parent ? { parent } : projectId !== undefined ? { project: projectId } : {}),
        ...(repo ? { repo } : {}),
        // A picked model starts it below, through the sessions' own attach.
        ...(!start || custom ? { start: false } : {}),
      });
      if (start && custom && choice) {
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

  const modelName = choice
    ? choice.model.trim() || `${choice.vendor} default model`
    : resolved
      ? (resolved.model ?? `${resolved.vendor} default model`)
      : 'the default model';
  const modelMeta = choice
    ? `${choice.vendor} · ${choice.effort} effort`
    : resolved
      ? `${resolved.vendor} · ${resolved.effort} effort`
      : undefined;

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
        <Field label="What should the agent do?" htmlFor="cr-newnode-goal">
          <textarea
            id="cr-newnode-goal"
            className="cr-newnode-goal"
            data-testid="new-stream-goal"
            data-autofocus
            rows={4}
            placeholder="Describe the task or the question. Its first line becomes the title."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>
        <Field label="Title" htmlFor="cr-newnode-title">
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
          <Field label="Parent" hint="Optional. It nests under this node.">
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
            repo ? (
              <>
                <b>{ROLE_LABEL.work}</b>: writes code on its own branch in {repo}, then hands it to
                you to merge.
              </>
            ) : (
              <>
                <b>{ROLE_LABEL.conversation}</b>: talks, researches and answers. No repository, no
                branch.
              </>
            )
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
                <span>
                  <b>{modelName}</b>
                  {modelMeta ? <span className="cr-faint"> · {modelMeta}</span> : null}
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
    </Dialog>
  );
}
