/**
 * T162: "New stream" from anywhere (cockpit design §9) — a title, an
 * optional parent and an optional repo. Opened by the top bar's button or
 * the `n` key; on create, the new stream's page opens. The goal is the
 * title unless the operator writes one: a stream's goal is refined on its
 * thread, not demanded up front.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createStream } from '../lib/api';
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
  const { newStreamOpen, setNewStreamOpen, select, selected, project } = useShell();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [parent, setParent] = useState('');
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

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

  // Each opening starts clean, parented under the open stream by default.
  useEffect(() => {
    if (!newStreamOpen) return;
    setTitle('');
    setGoal('');
    setRepo('');
    setError(undefined);
    setParent(selected ?? '');
    titleRef.current?.focus();
  }, [newStreamOpen, selected]);

  if (!newStreamOpen) return null;

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
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
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
