/**
 * T367: Settings → Repositories. Every registered repo as one row: its
 * icon (local, GitHub over https or SSH, another host), name, path, remote
 * and main branch, then how it delivers finished work (T222: Direct or
 * Pull request, auto-merge for a PR), who may use it (public, or private to
 * projects picked by name) and its protected branches. Each control saves
 * as it changes. "Add repository" opens `AddRepoDialog`.
 */

import { type PropsWithChildren, useEffect, useState } from 'react';
import { type RepoRow, listDirs, listRepos, saveRepoSettings } from '../lib/api';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow } from '../lib/feed-types';
import { remoteSlug, remoteWebUrl, tildify } from '../lib/repos';
import { AddRepoDialog } from './AddRepo';
import { Icon } from './Icon';
import { FormError, SavedNote, SetSection, Switch, errorText, useSavedFlash } from './SettingsCard';
import {
  Button,
  EmptyState,
  Menu,
  RepoIcon,
  Segmented,
  Spinner,
  repoKindLabel,
  useCopy,
} from './ui';

type RepoPatch = Parameters<typeof saveRepoSettings>[1];

function deliveryHint(repo: RepoRow): string {
  return repo.delivery === 'pr'
    ? 'Merge opens a pull request; the agent sees it through.'
    : `Merge commits into ${repo.main_branch} on this machine.`;
}

/** One of a repo's settings: a small label, the control, a line on what it means. */
function RepoSetting({
  label,
  hint,
  children,
}: PropsWithChildren<{ label: string; hint: string }>): JSX.Element {
  return (
    <div className="cr-set-repo-cell">
      <div className="cr-set-repo-cell-label">{label}</div>
      {children}
      <div className="cr-set-repo-cell-hint">{hint}</div>
    </div>
  );
}

function ProjectPicker({
  testid,
  projects,
  selected,
  busy,
  onChange,
}: {
  testid: string;
  projects: readonly CockpitProjectRow[];
  selected: readonly string[];
  busy: boolean;
  onChange: (ids: string[]) => void;
}): JSX.Element {
  // A project id the list doesn't know (a deleted project) still shows, so it can be unticked.
  const known = new Set(projects.map((p) => p.id));
  const rows = [
    ...projects.map((p) => ({ id: p.id, name: p.name })),
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, name: 'Unknown project' })),
  ];
  if (rows.length === 0) {
    return (
      <p className="cr-set-muted" data-testid={testid}>
        There are no projects yet. Make one first, then pick it here.
      </p>
    );
  }
  return (
    <fieldset className="cr-set-projects" data-testid={testid} disabled={busy}>
      <legend className="cr-set-sr">Projects that may use it</legend>
      {rows.map((p) => (
        <label key={p.id} title={p.id}>
          <input
            type="checkbox"
            data-testid={`${testid}-${p.id}`}
            checked={selected.includes(p.id)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
              )
            }
          />
          <Icon name="layers" size={14} />
          <span>{p.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function RepoItem({
  repo,
  projects,
  home,
  onSaved,
}: {
  repo: RepoRow;
  projects: readonly CockpitProjectRow[];
  home: string | undefined;
  onSaved: (repos: RepoRow[]) => void;
}): JSX.Element {
  const id = `settings-repo-${repo.name}`;
  const copy = useCopy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // "Private" picked, but no project ticked yet: nothing to save until one is.
  const [privateDraft, setPrivateDraft] = useState(false);
  const { saved, markSaved, clear } = useSavedFlash();
  const remote = repo.remote;
  const slug = remoteSlug(remote);
  const web = remoteWebUrl(remote);
  const privateTo = repo.visibility.mode === 'private' ? repo.visibility.projects : [];
  const visibility = privateDraft ? 'private' : repo.visibility.mode;

  function save(patch: RepoPatch): void {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    clear();
    saveRepoSettings(repo.name, patch)
      .then((next) => {
        onSaved(next);
        setPrivateDraft(false);
        markSaved();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }

  return (
    <li
      className="cr-set-repo"
      data-testid={id}
      data-delivery={repo.delivery}
      data-visibility={repo.visibility.mode}
      data-busy={busy ? 'true' : undefined}
    >
      <div className="cr-set-repo-hd">
        <span className="cr-set-repo-icon">
          <RepoIcon remote={remote} size={18} />
        </span>
        <div className="cr-set-repo-title">
          <div className="cr-set-repo-line">
            <span className="cr-set-repo-name">{repo.name}</span>
            <span className="cr-set-repo-kind" data-testid={`${id}-kind`}>
              {repoKindLabel(remote)}
              {slug ? (
                <>
                  {' · '}
                  {web ? (
                    <a href={web} target="_blank" rel="noreferrer">
                      {slug}
                    </a>
                  ) : (
                    slug
                  )}
                </>
              ) : null}
            </span>
          </div>
          <div className="cr-set-repo-path" title={repo.path} data-testid={`${id}-path`}>
            {tildify(repo.path, home)}
          </div>
        </div>
        <div className="cr-set-repo-aside">
          {busy ? <Spinner size={12} /> : <SavedNote show={saved} testid={`${id}-saved`} />}
          <span className="cr-set-repo-branch" title="Its main branch: finished work merges here">
            <Icon name="git-branch" size={13} />
            <code data-testid={`${id}-main`}>{repo.main_branch}</code>
          </span>
          <Menu
            label={`${repo.name} actions`}
            testid={`${id}-menu`}
            items={[
              { label: 'Copy path', icon: 'copy', onSelect: () => copy(repo.path, 'Path copied') },
              {
                label: 'Open on the web',
                icon: 'external-link',
                hidden: web === undefined,
                onSelect: () => web && window.open(web, '_blank', 'noopener'),
              },
            ]}
          />
        </div>
      </div>

      <div className="cr-set-repo-body">
        <div className="cr-set-repo-grid">
          <RepoSetting label="Delivery" hint={deliveryHint(repo)}>
            <Segmented
              label={`${repo.name} delivery`}
              testid={`${id}-delivery`}
              value={repo.delivery}
              onChange={(next) => next !== repo.delivery && save({ delivery: next })}
              items={[
                { id: 'direct', label: 'Direct' },
                { id: 'pr', label: 'Pull request' },
              ]}
            />
            {repo.delivery === 'pr' ? (
              <Switch
                label="Auto-merge once checks pass"
                data-testid={`${id}-auto-merge`}
                checked={repo.auto_merge}
                disabled={busy}
                onChange={(e) => save({ auto_merge: e.target.checked })}
              />
            ) : null}
          </RepoSetting>
          <RepoSetting
            label="Visibility"
            hint={
              visibility === 'public' ? 'Every project can use it.' : 'Only the projects ticked.'
            }
          >
            <Segmented
              label={`${repo.name} visibility`}
              testid={`${id}-visibility`}
              value={visibility}
              onChange={(next) => {
                setError(undefined);
                if (next === 'public') {
                  setPrivateDraft(false);
                  if (repo.visibility.mode !== 'public') save({ visibility: { mode: 'public' } });
                } else if (repo.visibility.mode !== 'private') {
                  setPrivateDraft(true);
                }
              }}
              items={[
                { id: 'public', label: 'Public' },
                { id: 'private', label: 'Private' },
              ]}
            />
            {visibility === 'private' ? (
              <ProjectPicker
                testid={`${id}-projects`}
                projects={projects}
                selected={privateTo}
                busy={busy}
                onChange={(ids) =>
                  ids.length > 0
                    ? save({ visibility: { mode: 'private', projects: ids } })
                    : setError(
                        'A private repository needs at least one project. Or make it public.',
                      )
                }
              />
            ) : null}
          </RepoSetting>
          <RepoSetting label="Protected branches" hint="Agents never commit to these.">
            <div className="cr-set-chips">
              {repo.protected_branches.length > 0 ? (
                repo.protected_branches.map((b) => (
                  <span key={b} className="cr-set-chip">
                    <Icon name="lock" size={11} />
                    {b}
                  </span>
                ))
              ) : (
                <span className="cr-set-muted">None</span>
              )}
            </div>
          </RepoSetting>
        </div>
        <FormError error={error} testid={`${id}-error`} />
      </div>
    </li>
  );
}

export function ReposSection(): JSX.Element {
  const feed = useOptionalFeed();
  const projects = feed?.cockpit?.projects ?? [];
  // A repo added elsewhere (the CLI, New project) shows up without a reload.
  const cockpitRepos = (feed?.cockpit?.repos ?? []).map((r) => r.name).join('\u0000');
  const [repos, setRepos] = useState<RepoRow[] | undefined>();
  const [home, setHome] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the frame's repo names change.
  useEffect(() => {
    listRepos()
      .then((next) => {
        setRepos(next);
        setError(undefined);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [cockpitRepos]);

  // The home folder, so paths read `~/…`.
  useEffect(() => {
    let live = true;
    listDirs()
      .then((l) => live && setHome(l.home))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const addButton = (
    <Button
      variant="primary"
      icon="plus"
      data-testid="settings-repo-add"
      onClick={() => setAdding(true)}
    >
      Add repository
    </Button>
  );

  return (
    <SetSection
      title="Repositories"
      description="The git repositories your nodes work in, and how each one delivers finished work."
      actions={repos && repos.length > 0 ? addButton : undefined}
      testid="settings-repos"
    >
      <FormError error={error} />
      {repos === undefined && !error ? (
        <p className="cr-set-muted">
          <Spinner size={12} /> Loading repositories…
        </p>
      ) : null}
      {repos?.length === 0 ? (
        <div className="cr-set-card">
          <EmptyState
            icon="folder-git"
            title="No repositories yet"
            testid="settings-repos-empty"
            actions={addButton}
          >
            Add a folder on this machine, or clone one from GitHub. Nodes that change code work in a
            repository.
          </EmptyState>
        </div>
      ) : null}
      {repos && repos.length > 0 ? (
        <ul className="cr-set-repos" aria-label="Repositories">
          {repos.map((repo) => (
            <RepoItem
              key={repo.name}
              repo={repo}
              projects={projects}
              home={home}
              onSaved={setRepos}
            />
          ))}
        </ul>
      ) : null}
      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(_name, next) => {
          setRepos(next);
          feed?.refresh();
        }}
      />
    </SetSection>
  );
}
