/**
 * T162: "New stream" from anywhere (cockpit design §9) — a title, an
 * optional parent and an optional repo. Opened by the top bar's button or
 * the `n` key; on create, the new stream's page opens. The goal is the
 * title unless the operator writes one: a stream's goal is refined on its
 * thread, not demanded up front.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createStream, listRepos } from '../lib/api';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import { projectForNew } from '../lib/streams';

export function NewStream({
  rows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element | null {
  const { newStreamOpen, setNewStreamOpen, selected } = useShell();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!newStreamOpen && isShortcut(event, 'n')) {
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
  return <NewStreamForm key={selected ?? ''} rows={rows} projects={projects} />;
}

function NewStreamForm({
  rows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const { setNewStreamOpen, select, selected, project } = useShell();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  // Parented under the open stream by default.
  const [parent, setParent] = useState(selected ?? '');
  const [repo, setRepo] = useState('');
  // T204: the node starts its agent on create unless this is ticked.
  const [startLater, setStartLater] = useState(false);
  const [repoNames, setRepoNames] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // T206: the picker lists what is registered now, including repos added in Settings.
    let live = true;
    listRepos()
      .then((repos) => {
        if (live) setRepoNames(repos.map((r) => r.name));
      })
      .catch(() => {
        if (live) setRepoNames([]);
      });
    titleRef.current?.focus();
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // T208: a parent carries its project; otherwise the current one.
      const into = parent ? undefined : projectForNew(project, selected, rows, projects);
      if (!parent && into === undefined) throw new Error('Pick a project in the rail first');
      const created = await createStream({
        title: t,
        goal: goal.trim() || t,
        ...(parent ? { parent } : {}),
        ...(into !== undefined ? { project: into } : {}),
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(startLater ? { start: false } : {}),
      });
      setNewStreamOpen(false);
      select(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cr-modal" data-testid="new-stream">
      <form className="cr-modal-card" onSubmit={submit} aria-label="New stream">
        <h2>New stream</h2>
        <label>
          Title
          <input
            ref={titleRef}
            data-testid="new-stream-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>
        <label>
          Goal <span>(optional)</span>
          <input
            data-testid="new-stream-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <label>
          Parent <span>(optional)</span>
          <select
            data-testid="new-stream-parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">— none —</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Repo <span>(optional, a registered name)</span>
          <input
            data-testid="new-stream-repo"
            list="new-stream-repo-names"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <datalist id="new-stream-repo-names" data-testid="new-stream-repo-names">
            {repoNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label>
          <input
            type="checkbox"
            data-testid="new-stream-start-later"
            checked={startLater}
            onChange={(e) => setStartLater(e.target.checked)}
          />{' '}
          Start later <span>(don't start the agent now)</span>
        </label>
        {error && (
          <p className="cr-error" role="alert" data-testid="new-stream-error">
            {error}
          </p>
        )}
        <div className="cr-modal-actions">
          <button type="button" className="cr-btn" onClick={() => setNewStreamOpen(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className="cr-btn signal"
            data-testid="new-stream-create"
            disabled={busy || !title.trim()}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
