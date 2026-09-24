/**
 * T162: "New stream" from anywhere (cockpit design §9) — a title, an
 * optional parent and an optional repo. Opened by the top bar's button or
 * the `n` key; on create, the new stream's page opens. The goal is the
 * title unless the operator writes one: a stream's goal is refined on its
 * thread, not demanded up front.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createStream, listRepos } from '../lib/api';
import type { CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';

export function NewStream({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element | null {
  const { newStreamOpen, setNewStreamOpen, select, selected } = useShell();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [parent, setParent] = useState('');
  const [repo, setRepo] = useState('');
  const [repoNames, setRepoNames] = useState<string[]>([]);
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
    // T206: the picker lists what is registered now, including repos added in Settings.
    listRepos()
      .then((repos) => setRepoNames(repos.map((r) => r.name)))
      .catch(() => setRepoNames([]));
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
      const created = await createStream({
        title: t,
        goal: goal.trim() || t,
        ...(parent ? { parent } : {}),
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
