/**
 * T208: the "New project" dialog — a name, and (T338) the registered repos
 * it uses.
 *
 * T365: the repos are a vertical checklist, each with its host's icon
 * (local, GitHub, SSH) and where it lives. On create the rail stays on (or
 * goes back to) All projects — it never switches on its own — and the new
 * project's root page opens, so the next step (a first node) is one click.
 * T373: "Add a repository…" opens the Add repository dialog on top; the
 * repo it adds comes back ticked.
 */

import { useEffect, useState } from 'react';
import { createProject } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import { useShell } from '../lib/shell';
import { AddRepoDialog } from './AddRepo';
import { Icon } from './Icon';
import { useRepoList } from './NewStream';
import { Button, Dialog, Field, RepoIcon, repoKindLabel, useToast } from './ui';

export function NewProject({ onClose }: { onClose(): void }): JSX.Element {
  const { setProject, select } = useShell();
  const { refresh } = useFeed();
  const toast = useToast();
  const repos = [...useRepoList()].sort((a, b) => a.name.localeCompare(b.name));
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await createProject(n, chosen);
      // Pete: after creating a project the rail shows All projects, not just the new one.
      setProject(undefined);
      select(created.root);
      onClose();
      toast({ title: `Project ${created.name} created`, tone: 'success', duration: 4000 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // T373: Add a repository opens Settings' dialog on top; the new repo arrives ticked.
  const [adding, setAdding] = useState(false);
  const addRepo = (): void => setAdding(true);

  const toggle = (repo: string, on: boolean): void =>
    setChosen((prev) => (on ? [...prev, repo] : prev.filter((x) => x !== repo)));

  return (
    <Dialog
      open
      onClose={onClose}
      title="New project"
      description="A project holds the nodes for one product, and the repositories they may work in."
      testid="new-project"
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            data-testid="new-project-create"
          >
            Create project
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="cr-new-project-name">
        <input
          id="cr-new-project-name"
          data-testid="new-project-name"
          data-autofocus
          placeholder="e.g. Shop"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <fieldset className="cr-field cr-checkfield">
        <legend className="cr-field-label">
          Repositories
          {chosen.length > 0 ? <span className="cr-faint"> · {chosen.length} chosen</span> : null}
        </legend>
        {repos.length > 0 ? (
          <div className="cr-checklist" data-testid="new-project-repos">
            {repos.map((r) => {
              const on = chosen.includes(r.name);
              const where = r.remote?.url ?? r.path;
              return (
                <label key={r.name} className="cr-check-row" data-checked={on ? 'true' : undefined}>
                  <input
                    type="checkbox"
                    data-testid="new-project-repo"
                    data-repo={r.name}
                    checked={on}
                    onChange={(e) => toggle(r.name, e.target.checked)}
                  />
                  <RepoIcon remote={r.remote} />
                  <span className="cr-check-main">
                    <span className="cr-check-name">{r.name}</span>
                    <span className="cr-check-sub" title={where}>
                      {repoKindLabel(r.remote)}
                      {where ? ` · ${where}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
            <button
              type="button"
              className="cr-check-add"
              data-testid="new-project-add-repo"
              onClick={addRepo}
            >
              <Icon name="plus" size={14} />
              Add a repository…
            </button>
          </div>
        ) : (
          <div className="cr-checklist-empty" data-testid="new-project-repos">
            <p>No repositories yet. A project can start without one: conversations need none.</p>
            <button
              type="button"
              className="cr-link"
              data-testid="new-project-add-repo"
              onClick={addRepo}
            >
              Add a repository…
            </button>
          </div>
        )}
        {repos.length > 0 ? (
          <div className="cr-field-hint">
            The repositories its nodes work in. New nodes offer these first.
          </div>
        ) : null}
      </fieldset>
      {error && (
        <p className="cr-error" role="alert" data-testid="new-project-error">
          {error}
        </p>
      )}
      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(added) => {
          setChosen((prev) => (prev.includes(added) ? prev : [...prev, added]));
          refresh();
        }}
      />
    </Dialog>
  );
}
