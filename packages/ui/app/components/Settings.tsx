/**
 * Settings (T043's view, cut to what the cockpit has left in T160): who
 * decides each of the three surviving gate kinds (§3.1), read from
 * `policy.yaml` through `GET /api/policy`.
 *
 * Read-only for now: T043's per-row "ask me / EM decides" switch chose
 * between the human and the EM delegate, and the EM was deleted in T122,
 * so the only owner left that a gate can actually reach is the human.
 *
 * T167: the classifier's "TypeSafe API key" — write-only. The daemon never
 * sends the key back; this shows only where it comes from (config.yaml, the
 * environment, or nowhere). Save writes it to config.yaml and it is live at
 * once; Remove deletes it from config.yaml (an env key still applies).
 *
 * T170 (D17): the session defaults — home-wide (`config.yaml`) and per repo
 * (`repos.yaml`). An empty field inherits the next step of the order, which
 * each control names; the next attach uses the saved values, no restart.
 *
 * T326 (D31): Trackers — Jira's base URL and email (not secret) and a
 * write-only token per tracker. Only whether a token is set comes back.
 *
 * T206: Repos — register a repo by path (its git toplevel), name and
 * protected branches, through the same RPC as `agile repo add`.
 */

import type {
  ClassifierKeyStatus,
  Policy,
  ResolvedSessionDefaults,
  SessionDefaultsFields,
  SessionDefaultsPatch,
  SessionDefaultsStatus,
  TrackerSettingsInput,
  TrackerSettingsStatus,
} from '@agile-agents/shared';
import { GATE_KINDS } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import {
  type RepoRow,
  addRepo,
  getClassifierKey,
  getPolicy,
  getSessionDefaults,
  getTrackerSettings,
  listRepos,
  removeClassifierKey,
  saveClassifierKey,
  saveHomeSessionDefaults,
  saveRepoSessionDefaults,
  saveRepoSettings,
  saveTrackerSettings,
} from '../lib/api';
import { type SessionChoice, SessionFields } from './SessionPicker';

const GATE_TEXT: Record<(typeof GATE_KINDS)[number], { title: string; what: string }> = {
  land: { title: 'Landing a stream', what: 'Merging a finished stream into its target branch.' },
  rule_accept: {
    title: 'A proposed rule',
    what: 'A lesson from a finished stream, or a rule an agent proposed.',
  },
  classifier_review: {
    title: 'A routed tool call',
    what: 'The classifier was unsure about an action and routed it to you.',
  },
};

export function Settings(): JSX.Element {
  const [policy, setPolicy] = useState<Policy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getPolicy()
      .then(setPolicy)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <section className="cr-settings" data-testid="settings">
      <h1>Settings</h1>
      {error && <p className="cr-error">{error}</p>}
      <ClassifierKey />
      <Trackers />
      <Repos />
      <SessionDefaults />
      <h2>Who decides</h2>
      {GATE_KINDS.map((gate) => (
        <div className="cr-gate-row" key={gate} data-gate={gate}>
          <div>
            <div>{GATE_TEXT[gate].title}</div>
            <div className="what">{GATE_TEXT[gate].what}</div>
          </div>
          <code>{policy ? (policy.gates[gate] ?? 'human') : '…'}</code>
        </div>
      ))}
    </section>
  );
}

function keyText(status: ClassifierKeyStatus): string {
  if (status.source === 'none') return 'no key';
  const from = status.source === 'config' ? 'from config' : 'from environment';
  const off = status.loaded ? '' : ' — provider is off';
  return `key set (${from})${off}`;
}

function ClassifierKey(): JSX.Element {
  const [status, setStatus] = useState<ClassifierKeyStatus | undefined>(undefined);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getClassifierKey()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function act(fn: () => Promise<ClassifierKeyStatus>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await fn());
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cr-gate-row"
      data-testid="settings-classifier-key"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim().length > 0) void act(() => saveClassifierKey(value.trim()));
      }}
    >
      <div>
        <div>TypeSafe API key</div>
        <div className="what">
          The classifier&apos;s key (§6.2). Stored in config.yaml; never shown again.
        </div>
        <div className="what" data-testid="settings-key-status">
          {status ? keyText(status) : '…'}
          {status?.environment_also ? ' · an environment key is also set' : ''}
        </div>
        {error && (
          <p className="cr-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="cr-actions">
        <input
          type="password"
          autoComplete="off"
          aria-label="TypeSafe API key"
          data-testid="settings-key-input"
          value={value}
          placeholder={status?.source === 'none' ? 'paste a key' : 'replace the key'}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className="cr-btn signal"
          data-testid="settings-key-save"
          disabled={busy || value.trim().length === 0}
        >
          Save
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid="settings-key-remove"
          disabled={busy || status?.source !== 'config'}
          title={
            status?.source === 'environment'
              ? 'This key comes from TYPESAFE_API_KEY; unset it in the daemon environment'
              : 'Delete the key from config.yaml'
          }
          onClick={() => void act(removeClassifierKey)}
        >
          Remove
        </button>
      </div>
    </form>
  );
}

function Trackers(): JSX.Element {
  const [status, setStatus] = useState<TrackerSettingsStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getTrackerSettings()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save(input: TrackerSettingsInput): Promise<boolean> {
    setError(undefined);
    try {
      setStatus(await saveTrackerSettings(input));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  return (
    <div data-testid="settings-trackers">
      <h2>Trackers</h2>
      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
      <TrackerRow system="jira" status={status} save={save} />
      <TrackerRow system="linear" status={status} save={save} />
    </div>
  );
}

function TrackerRow({
  system,
  status,
  save,
}: {
  system: 'jira' | 'linear';
  status: TrackerSettingsStatus | undefined;
  save: (input: TrackerSettingsInput) => Promise<boolean>;
}): JSX.Element {
  const jira = status?.jira;
  const tokenSet = status ? status[system].token_set : undefined;
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState<string | undefined>(undefined);
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const shownBaseUrl = baseUrl ?? jira?.base_url ?? '';
  const shownEmail = email ?? jira?.email ?? '';

  async function act(input: TrackerSettingsInput): Promise<void> {
    setBusy(true);
    if (await save(input)) {
      setToken('');
      setBaseUrl(undefined);
      setEmail(undefined);
    }
    setBusy(false);
  }

  function submit(): void {
    const input: TrackerSettingsInput = { system };
    if (system === 'jira') {
      if (baseUrl !== undefined) input.base_url = baseUrl.trim() === '' ? null : baseUrl.trim();
      if (email !== undefined) input.email = email.trim() === '' ? null : email.trim();
    }
    if (token.trim() !== '') input.token = token.trim();
    void act(input);
  }

  const dirty = token.trim() !== '' || baseUrl !== undefined || email !== undefined;
  const label = system === 'jira' ? 'Jira' : 'Linear';
  return (
    <form
      className="cr-gate-row"
      data-testid={`settings-tracker-${system}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) submit();
      }}
    >
      <div>
        <div>{label}</div>
        <div className="what">
          {system === 'jira'
            ? 'Base URL, and an email for Jira Cloud (Basic auth); without one the token is a Bearer PAT.'
            : 'A Linear API key.'}{' '}
          Stored in config.yaml; never shown again.
        </div>
        <div className="what" data-testid={`settings-tracker-${system}-status`}>
          {tokenSet === undefined ? '…' : tokenSet ? 'token set' : 'no token'}
        </div>
      </div>
      <div className="cr-actions">
        {system === 'jira' && (
          <>
            <input
              type="url"
              aria-label="Jira base URL"
              data-testid="settings-tracker-jira-base-url"
              value={shownBaseUrl}
              placeholder="https://your-site.atlassian.net"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <input
              type="email"
              aria-label="Jira email"
              data-testid="settings-tracker-jira-email"
              value={shownEmail}
              placeholder="email (optional)"
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        )}
        <input
          type="password"
          autoComplete="off"
          aria-label={`${label} token`}
          data-testid={`settings-tracker-${system}-token`}
          value={token}
          placeholder={tokenSet ? 'replace the token' : 'paste a token'}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          type="submit"
          className="cr-btn signal"
          data-testid={`settings-tracker-${system}-save`}
          disabled={busy || !dirty}
        >
          Set
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid={`settings-tracker-${system}-clear`}
          disabled={busy || !tokenSet}
          title="Delete the token from config.yaml"
          onClick={() => void act({ system, token: null })}
        >
          Clear
        </button>
      </div>
    </form>
  );
}

function toChoice(fields: SessionDefaultsFields): SessionChoice {
  return { vendor: fields.vendor ?? '', model: fields.model ?? '', effort: fields.effort ?? '' };
}

/** Empty = inherit: the field is removed from the file (`null`). */
function toPatch(choice: SessionChoice): SessionDefaultsPatch {
  const model = choice.model.trim();
  return {
    vendor: (choice.vendor || null) as SessionDefaultsPatch['vendor'],
    model: model.length > 0 ? model : null,
    effort: (choice.effort || null) as SessionDefaultsPatch['effort'],
  };
}

function resolvedText(resolved: ResolvedSessionDefaults): string {
  return `${resolved.vendor} / ${resolved.model ?? `${resolved.vendor} default model`} / ${resolved.effort}`;
}

function SessionDefaultsRow({
  label,
  what,
  testid,
  status,
  fields,
  inherit,
  resolved,
  save,
}: {
  label: string;
  what: string;
  testid: string;
  status: SessionDefaultsStatus;
  fields: SessionDefaultsFields;
  inherit: ResolvedSessionDefaults;
  resolved: ResolvedSessionDefaults;
  save: (patch: SessionDefaultsPatch) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState<SessionChoice>(() => toChoice(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="cr-gate-row"
      data-testid={testid}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        setSaved(false);
        save(toPatch(value))
          .then(() => setSaved(true))
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    >
      <div>
        <div>{label}</div>
        <div className="what">{what}</div>
        <div className="what" data-testid={`${testid}-resolved`}>
          Resolves to {resolvedText(resolved)}
          {saved ? ' · saved' : ''}
        </div>
        {error && (
          <p className="cr-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="cr-actions">
        <SessionFields
          status={status}
          value={value}
          onChange={(next) => {
            setValue(next);
            setSaved(false);
          }}
          inherit={inherit}
          testid={`${testid}-field`}
        />
        <button
          type="submit"
          className="cr-btn signal"
          data-testid={`${testid}-save`}
          disabled={busy}
        >
          Save
        </button>
      </div>
    </form>
  );
}

function SessionDefaults(): JSX.Element {
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getSessionDefaults()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <>
      <h2>Session defaults</h2>
      {error && <p className="cr-error">{error}</p>}
      {!status && !error && <p className="cr-dim">…</p>}
      {status && (
        <>
          <SessionDefaultsRow
            label="Global default"
            what="config.yaml — used for every stream unless its repo sets its own."
            testid="settings-session-home"
            status={status}
            fields={status.home}
            inherit={status.builtin}
            resolved={status.resolved}
            save={async (patch) => setStatus(await saveHomeSessionDefaults(patch))}
          />
          <h3 data-testid="settings-session-repos-heading">Per-repo defaults</h3>
          {Object.keys(status.repos).length === 0 && (
            <p className="cr-dim" data-testid="settings-session-repos-empty">
              No repos registered yet.
            </p>
          )}
          {Object.entries(status.repos).map(([name, repo]) => (
            <SessionDefaultsRow
              key={name}
              label={name}
              what="repos.yaml — overrides the global default for streams in this repo."
              testid={`settings-session-repo-${name}`}
              status={status}
              fields={repo}
              inherit={status.resolved}
              resolved={repo.resolved}
              save={async (patch) => setStatus(await saveRepoSessionDefaults(name, patch))}
            />
          ))}
        </>
      )}
    </>
  );
}

/** T222 (§14.8): one repo, with its delivery mode, auto-merge and visibility. */
function RepoRowView({
  repo,
  onSaved,
}: {
  repo: RepoRow;
  onSaved: (repos: RepoRow[]) => void;
}): JSX.Element {
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [projectsRaw, setProjectsRaw] = useState(
    repo.visibility.mode === 'private' ? repo.visibility.projects.join(', ') : '',
  );
  const id = `settings-repo-${repo.name}`;
  const save = (patch: Parameters<typeof saveRepoSettings>[1]) => {
    setBusy(true);
    setError(undefined);
    saveRepoSettings(repo.name, patch)
      .then(onSaved)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const projects = projectsRaw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return (
    <div className="cr-gate-row" data-testid={id} data-delivery={repo.delivery}>
      <div>
        <div>{repo.name}</div>
        <div className="what">{repo.path}</div>
        <div className="what">protected: {repo.protected_branches.join(', ') || '—'}</div>
        {repo.github && (
          <div className="what">
            GitHub: {repo.github.owner}/{repo.github.repo}
          </div>
        )}
        {error && (
          <p className="cr-error" role="alert" data-testid={`${id}-error`}>
            {error}
          </p>
        )}
      </div>
      <div className="cr-actions">
        <code data-testid={`${id}-main`}>{repo.main_branch}</code>
        <select
          aria-label="Delivery"
          data-testid={`${id}-delivery`}
          value={repo.delivery}
          disabled={busy}
          onChange={(e) => save({ delivery: e.target.value as RepoRow['delivery'] })}
        >
          <option value="direct">direct</option>
          <option value="pr">pr</option>
        </select>
        <label className="what">
          <input
            type="checkbox"
            data-testid={`${id}-auto-merge`}
            checked={repo.auto_merge}
            disabled={busy || repo.delivery !== 'pr'}
            onChange={(e) => save({ auto_merge: e.target.checked })}
          />{' '}
          auto-merge
        </label>
        <select
          aria-label="Visibility"
          data-testid={`${id}-visibility`}
          value={repo.visibility.mode}
          disabled={busy}
          onChange={(e) =>
            e.target.value === 'public'
              ? save({ visibility: { mode: 'public' } })
              : projects.length > 0
                ? save({ visibility: { mode: 'private', projects } })
                : setError('private needs at least one project id')
          }
        >
          <option value="public">public</option>
          <option value="private">private</option>
        </select>
        <input
          data-testid={`${id}-projects`}
          placeholder="P-… (private to)"
          value={projectsRaw}
          onChange={(e) => setProjectsRaw(e.target.value)}
        />
      </div>
    </div>
  );
}

function Repos(): JSX.Element {
  const [repos, setRepos] = useState<RepoRow[] | undefined>(undefined);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [protectedRaw, setProtectedRaw] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listRepos()
      .then(setRepos)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const trimmedPath = path.trim().replace(/\/+$/, '');
  const derivedName = name.trim() || trimmedPath.split('/').pop() || '';
  const branches = protectedRaw
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return (
    <>
      <h2>Repos</h2>
      {repos?.length === 0 && (
        <p className="cr-dim" data-testid="settings-repos-empty">
          No repos registered yet.
        </p>
      )}
      {repos?.map((repo) => (
        <RepoRowView key={repo.name} repo={repo} onSaved={setRepos} />
      ))}
      <form
        className="cr-gate-row"
        data-testid="settings-repo-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmedPath || !derivedName || busy) return;
          setBusy(true);
          setError(undefined);
          addRepo({
            name: derivedName,
            path: trimmedPath,
            ...(branches.length > 0 ? { protected_branches: branches } : {}),
          })
            .then((next) => {
              setRepos(next);
              setName('');
              setPath('');
              setProtectedRaw('');
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div>
          <div>Add a repo</div>
          <div className="what">
            The path to the repo's toplevel; the name defaults to its folder.
          </div>
          {error && (
            <p className="cr-error" role="alert" data-testid="settings-repo-add-error">
              {error}
            </p>
          )}
        </div>
        <div className="cr-actions">
          <input
            data-testid="settings-repo-add-path"
            placeholder="/path/to/repo"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <input
            data-testid="settings-repo-add-name"
            placeholder={derivedName || 'name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            data-testid="settings-repo-add-protected"
            placeholder="main, master"
            value={protectedRaw}
            onChange={(e) => setProtectedRaw(e.target.value)}
          />
          <button
            type="submit"
            className="cr-btn signal"
            data-testid="settings-repo-add-save"
            disabled={busy}
          >
            Add
          </button>
        </div>
      </form>
    </>
  );
}
