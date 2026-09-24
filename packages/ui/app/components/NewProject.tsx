/**
 * T208: the rail's "New project" dialog — one name. On create, the
 * switcher moves to the new project so the next New stream or quick
 * capture files there.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createProject } from '../lib/api';
import { useShell } from '../lib/shell';

export function NewProject({ onClose }: { onClose(): void }): JSX.Element {
  const { setProject, select } = useShell();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await createProject(n);
      setProject(created.id);
      select(undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="cr-modal" data-testid="new-project">
      <form className="cr-modal-card" onSubmit={submit} aria-label="New project">
        <h2>New project</h2>
        <label>
          Name
          <input
            ref={nameRef}
            data-testid="new-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="cr-error" role="alert" data-testid="new-project-error">
            {error}
          </p>
        )}
        <div className="cr-modal-actions">
          <button type="button" className="cr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="cr-btn signal"
            data-testid="new-project-create"
            disabled={busy || !name.trim()}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
