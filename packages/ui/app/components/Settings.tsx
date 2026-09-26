/**
 * Settings (T367, design/cockpit-ui.md): one screen, in sections, with a
 * sub-navigation on the left (a scrolling row of tabs on a phone):
 *
 *  - **General** — the theme (system, light, dark; per browser), browser
 *    notifications (T388; per browser, off by default) and the daemon this
 *    cockpit talks to.
 *  - **Agents** — T170 (D17) session defaults: global (`config.yaml`) and per
 *    repo (`repos.yaml`). An empty field inherits the next step.
 *  - **Repositories** — `SettingsRepos.tsx`: every repo with its icon,
 *    delivery and visibility; Add repository (`AddRepo.tsx`).
 *  - **Classifier** — T167: the TypeSafe API key, write-only (the daemon
 *    never sends it back, only where it comes from).
 *  - **Trackers** — T326: Jira's site and email, and a write-only token per
 *    tracker.
 *  - **Permissions** — who decides each gate kind (read-only: the human).
 *
 * The open section rides in the URL (`?view=settings&section=repos`), so a
 * reload or a shared link reopens it.
 */

import type {
  ClassifierKeyStatus,
  Policy,
  ProjectSessionDefaults,
  ResolvedSessionDefaults,
  SessionDefaultsFields,
  SessionDefaultsPatch,
  SessionDefaultsStatus,
  TrackerSettingsInput,
  TrackerSettingsStatus,
} from '@agile-agents/shared';
import { GATE_KINDS } from '@agile-agents/shared';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  type DaemonHealth,
  getClassifierKey,
  getHealth,
  getPolicy,
  getSessionDefaults,
  getTrackerSettings,
  removeClassifierKey,
  saveClassifierKey,
  saveHomeSessionDefaults,
  saveRepoSessionDefaults,
  saveTrackerSettings,
  updateProject,
} from '../lib/api';
import { agentLabel, sessionIdText } from '../lib/chat';
import { resolvedFor } from '../lib/defaults';
import { useOptionalFeed } from '../lib/feed-context';
import { useOptionalShell } from '../lib/shell';
import { type ThemeChoice, readTheme, saveTheme } from '../lib/theme';
import {
  type NotifyAccess,
  askNotifyAccess,
  notifyAccess,
  readNotifyOn,
  saveNotifyOn,
  sendTestNotification,
} from '../lib/use-notify';
import { Icon, type IconName } from './Icon';
import { type SessionChoice, SessionFields } from './SessionPicker';
import {
  FormError,
  SavedNote,
  SetCard,
  SetRow,
  SetSection,
  Switch,
  errorText,
  useSavedFlash,
} from './SettingsCard';
import { ReposSection } from './SettingsRepos';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  PageHeader,
  RepoIcon,
  Segmented,
  Spinner,
  useCopy,
} from './ui';

// ---------------------------------------------------------------- sections and the URL

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'repos', label: 'Repositories', icon: 'folder-git' },
  { id: 'classifier', label: 'Classifier', icon: 'shield-check' },
  { id: 'trackers', label: 'Trackers', icon: 'ticket' },
  { id: 'permissions', label: 'Permissions', icon: 'user' },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName }>;

export type SettingsSection = (typeof SECTIONS)[number]['id'];

function isSection(value: string | null): value is SettingsSection {
  return SECTIONS.some((s) => s.id === value);
}

function sectionFromUrl(): SettingsSection {
  const value = new URLSearchParams(window.location.search).get('section');
  return isSection(value) ? value : 'general';
}

/**
 * The section in `?section=` (General is no param). The shell (T348) owns
 * the rest of the query and rewrites it when the view or project changes —
 * after this screen's effects run — so the write waits a tick and re-runs
 * when the project filter moves. Replaced, never pushed: a section is not
 * a page of its own in the history.
 */
function useSectionInUrl(): [SettingsSection, (next: SettingsSection) => void] {
  const [section, setSection] = useState<SettingsSection>(sectionFromUrl);
  const project = useOptionalShell()?.project;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shell's project write drops the param; write it back after.
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') !== 'settings') return;
      if (section === 'general') params.delete('section');
      else params.set('section', section);
      const query = params.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
      if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(window.history.state, '', url);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [section, project]);
  useEffect(() => {
    const onPop = (): void => setSection(sectionFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return [section, setSection];
}

export function Settings(): JSX.Element {
  const [section, setSection] = useSectionInUrl();
  const nav = useRef<HTMLElement>(null);
  // On a phone the sections are a scrolling row: keep the open one in view.
  useEffect(() => {
    nav.current
      ?.querySelector<HTMLElement>(`[data-section="${section}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  return (
    <div className="cr-settings" data-testid="settings" data-section={section}>
      <div className="cr-set-wrap">
        <PageHeader title="Settings" />
        <div className="cr-set-layout">
          <nav className="cr-set-nav" aria-label="Settings sections" ref={nav}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                data-section={s.id}
                data-testid={`settings-nav-${s.id}`}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                <Icon name={s.icon} size={15} />
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="cr-set-body">
            {section === 'general' ? (
              <GeneralSection />
            ) : section === 'agents' ? (
              <AgentsSection onOpenRepos={() => setSection('repos')} />
            ) : section === 'repos' ? (
              <ReposSection />
            ) : section === 'classifier' ? (
              <ClassifierSection />
            ) : section === 'trackers' ? (
              <TrackersSection />
            ) : (
              <PermissionsSection />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A small status pill: a dot and a word. */
function Pill({
  tone,
  children,
  title,
}: {
  tone: 'green' | 'gray' | 'amber';
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span className="cr-set-pill" data-tone={tone} title={title}>
      <span className="cr-set-pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- General

function formatUptime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

function GeneralSection(): JSX.Element {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [health, setHealth] = useState<DaemonHealth | undefined>();
  const [healthError, setHealthError] = useState<string | undefined>();
  const connected = useOptionalFeed()?.connected ?? false;
  const copy = useCopy();

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setHealthError(errorText(err)));
  }, []);

  const themeIcon = (icon: IconName, label: string): JSX.Element => (
    <>
      <Icon name={icon} size={14} />
      {label}
    </>
  );

  return (
    <SetSection
      title="General"
      description="How the cockpit looks, how it tells you something needs you, and the daemon it talks to."
    >
      <SetCard title="Appearance" icon="sun" testid="settings-appearance">
        <SetRow label="Theme" hint="Follow your system, or pick one. Kept in this browser.">
          <Segmented
            label="Theme"
            testid="settings-theme"
            value={theme}
            onChange={(next) => {
              saveTheme(next);
              setTheme(next);
            }}
            items={[
              {
                id: 'system',
                label: themeIcon('monitor', 'System'),
                testid: 'settings-theme-system',
              },
              { id: 'light', label: themeIcon('sun', 'Light'), testid: 'settings-theme-light' },
              { id: 'dark', label: themeIcon('moon', 'Dark'), testid: 'settings-theme-dark' },
            ]}
          />
        </SetRow>
      </SetCard>

      <NotificationsCard />

      <SetCard
        title="Daemon"
        icon="terminal"
        description={
          <>
            The background process that runs your agents and keeps all state. Start and stop it with{' '}
            <code>agile daemon</code>.
          </>
        }
        testid="settings-daemon"
        status={
          <Pill tone={connected ? 'green' : 'amber'}>
            <span data-testid="settings-daemon-status">
              {connected ? 'Connected' : 'Reconnecting…'}
            </span>
          </Pill>
        }
      >
        <dl className="cr-set-facts">
          <div>
            <dt>Address</dt>
            <dd>
              <code>{window.location.host}</code>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{health ? health.version : healthError ? '—' : '…'}</dd>
          </div>
          <div>
            <dt>Running for</dt>
            <dd>{health ? formatUptime(health.uptime) : healthError ? '—' : '…'}</dd>
          </div>
          <div>
            <dt>Home folder</dt>
            <dd className="cr-set-facts-path">
              {health ? (
                <>
                  <code title={health.stateRoot}>{health.stateRoot}</code>
                  <button
                    type="button"
                    className="cr-set-copy"
                    aria-label="Copy the home folder path"
                    title="Copy"
                    onClick={() => copy(health.stateRoot, 'Path copied')}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                </>
              ) : healthError ? (
                '—'
              ) : (
                '…'
              )}
            </dd>
          </div>
        </dl>
      </SetCard>
    </SetSection>
  );
}

/** T388: why the switch can't turn on, in words; `undefined` when nothing stands in the way. */
function notifyNote(
  access: NotifyAccess,
  dismissed: boolean,
): { tone: 'amber' | 'gray'; text: ReactNode } | undefined {
  switch (access) {
    case 'unsupported':
      return { tone: 'gray', text: 'This browser can’t show notifications.' };
    case 'insecure':
      return {
        tone: 'gray',
        text: (
          <>
            Browsers only show notifications for a secure address. Open the cockpit at{' '}
            <code>localhost</code> or over https to use them.
          </>
        ),
      };
    case 'denied':
      return {
        tone: 'amber',
        text: 'Your browser blocks notifications from the cockpit. To allow them, click the icon at the left of the address bar, set Notifications to Allow, then turn this on.',
      };
    default:
      return dismissed
        ? {
            tone: 'gray',
            text: 'The browser wasn’t given permission. Turn this on again and choose Allow.',
          }
        : undefined;
  }
}

/**
 * T388: the per-browser switch for notifications (`lib/use-notify.ts`).
 * Turning it on asks the browser; a refusal, or a browser that can't,
 * is said in words and the switch stays off.
 */
function NotificationsCard(): JSX.Element {
  const [access, setAccess] = useState<NotifyAccess>(notifyAccess);
  const [wanted, setWanted] = useState(readNotifyOn);
  const [asking, setAsking] = useState(false);
  /** The browser's prompt was closed without an answer. */
  const [dismissed, setDismissed] = useState(false);
  const [test, setTest] = useState<'sent' | 'failed' | undefined>();
  const on = wanted && access === 'granted';
  const available = access !== 'unsupported' && access !== 'insecure';
  const note = notifyNote(access, dismissed);

  // The permission can change behind the page (the browser's site settings): re-read it on the way back.
  useEffect(() => {
    const reread = (): void => setAccess(notifyAccess());
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, []);

  async function toggle(next: boolean): Promise<void> {
    setDismissed(false);
    setTest(undefined);
    if (!next) {
      saveNotifyOn(false);
      setWanted(false);
      return;
    }
    setAsking(true);
    const result = await askNotifyAccess();
    setAsking(false);
    setAccess(result);
    saveNotifyOn(result === 'granted');
    setWanted(result === 'granted');
    if (result === 'default') setDismissed(true);
  }

  const status = on
    ? { tone: 'green' as const, text: 'On' }
    : !available
      ? { tone: 'gray' as const, text: 'Not available' }
      : access === 'denied'
        ? { tone: 'amber' as const, text: 'Blocked' }
        : { tone: 'gray' as const, text: 'Off' };

  return (
    <SetCard
      title="Notifications"
      icon="bell"
      description="A browser notification when a new question, plan, merge or action to allow arrives while you’re in another tab or app. A click takes you to it. Kept in this browser."
      testid="settings-notifications"
      status={
        <Pill tone={status.tone}>
          <span data-testid="settings-notify-status">{status.text}</span>
        </Pill>
      }
    >
      <div className="cr-set-notify">
        <Switch
          label="Tell me when something new needs me"
          data-testid="settings-notify"
          checked={on}
          disabled={asking || !available}
          onChange={(e) => void toggle(e.target.checked)}
        />
        {on ? (
          <Button
            size="sm"
            icon="send"
            data-testid="settings-notify-test"
            onClick={() =>
              void sendTestNotification().then((sent) => setTest(sent ? 'sent' : 'failed'))
            }
          >
            Send a test
          </Button>
        ) : null}
      </div>
      {note ? (
        <p className="cr-set-note" data-tone={note.tone} data-testid="settings-notify-note">
          <Icon name={note.tone === 'amber' ? 'alert-triangle' : 'info'} size={14} />
          <span>{note.text}</span>
        </p>
      ) : null}
      {on && test ? (
        <output className="cr-set-note" data-tone="plain" data-testid="settings-notify-sent">
          <Icon name={test === 'sent' ? 'check' : 'info'} size={14} />
          <span>
            {test === 'sent'
              ? 'Sent. Nothing showed up? Check that your system lets this browser show notifications.'
              : 'The browser didn’t show it.'}
          </span>
        </output>
      ) : null}
    </SetCard>
  );
}

// ---------------------------------------------------------------- Agents

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

/** T379: a project's `session` block after a Settings patch; `null` when it names nothing. */
function projectSessionAfter(patch: SessionDefaultsPatch): ProjectSessionDefaults | null {
  const next: ProjectSessionDefaults = {
    ...(patch.vendor ? { vendor: patch.vendor } : {}),
    ...(patch.model ? { model: patch.model } : {}),
    ...(patch.effort ? { effort: patch.effort } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}

/** T379: what a project's nodes start with — one answer, or "varies" when its repos differ. */
function projectResolved(
  status: SessionDefaultsStatus,
  repos: readonly string[],
  fields: ProjectSessionDefaults | undefined,
): ResolvedSessionDefaults | string {
  const each = (repos.length > 0 ? repos : [undefined]).map((repo) =>
    resolvedFor(status, repo, fields),
  );
  const first = each[0] ?? resolvedFor(status, undefined, fields);
  const key = sessionIdText(first);
  return each.every((resolved) => sessionIdText(resolved) === key) ? first : 'Varies by repository';
}

function sameChoice(a: SessionChoice, b: SessionChoice): boolean {
  return a.vendor === b.vendor && a.model.trim() === b.model.trim() && a.effort === b.effort;
}

function SessionDefaultsCard({
  title,
  icon,
  description,
  testid,
  status,
  fields,
  inherit,
  resolved,
  save,
}: {
  title: ReactNode;
  icon?: IconName | ReactNode;
  description?: string;
  testid: string;
  status: SessionDefaultsStatus;
  fields: SessionDefaultsFields;
  inherit: ResolvedSessionDefaults;
  /** What a new agent here starts with; a sentence when that depends on the node. */
  resolved: ResolvedSessionDefaults | string;
  save: (patch: SessionDefaultsPatch) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState<SessionChoice>(() => toChoice(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { saved, markSaved, clear } = useSavedFlash();
  const dirty = !sameChoice(value, toChoice(fields));

  return (
    <SetCard
      title={title}
      icon={icon}
      description={description}
      testid={testid}
      label={typeof title === 'string' ? title : undefined}
      status={
        <span
          className="cr-set-resolved"
          title={`What a new agent here starts with${
            typeof resolved === 'string' ? '' : `: ${sessionIdText(resolved)}`
          }`}
        >
          <Icon name="bot" size={13} />
          <span data-testid={`${testid}-resolved`}>
            {typeof resolved === 'string' ? resolved : agentLabel(resolved)}
          </span>
        </span>
      }
      onSubmit={() => {
        if (busy || !dirty) return;
        setBusy(true);
        setError(undefined);
        save(toPatch(value))
          .then(markSaved)
          .catch((err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="cr-set-sf">
        <div className="cr-set-sf-labels" aria-hidden="true">
          <span>Agent</span>
          <span>Model</span>
          <span>Effort</span>
        </div>
        <SessionFields
          status={status}
          value={value}
          onChange={(next) => {
            setValue(next);
            clear();
          }}
          inherit={inherit}
          testid={`${testid}-field`}
        />
        <div className="cr-set-sf-save">
          {saved ? (
            <SavedNote show testid={`${testid}-saved`} />
          ) : (
            <Button
              type="submit"
              variant={dirty ? 'primary' : 'secondary'}
              busy={busy}
              disabled={!dirty}
              data-testid={`${testid}-save`}
            >
              Save
            </Button>
          )}
        </div>
      </div>
      <FormError error={error} />
    </SetCard>
  );
}

function AgentsSection({ onOpenRepos }: { onOpenRepos: () => void }): JSX.Element {
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  // T379: what a save returned, until the next frame carries it.
  const [savedProjects, setSavedProjects] = useState<
    Record<string, ProjectSessionDefaults | undefined>
  >({});
  const cockpit = useOptionalFeed()?.cockpit;
  const remotes = new Map((cockpit?.repos ?? []).map((r) => [r.name, r.remote] as const));
  const projects = cockpit?.projects ?? [];

  useEffect(() => {
    getSessionDefaults()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const repos = status ? Object.entries(status.repos) : [];
  return (
    <SetSection
      title="Agents"
      description="The agent, model and effort a node starts with: its project’s default, else its repository’s, else the global default. You can still pick another when you start one."
    >
      <FormError error={error} />
      {!status && !error ? (
        <p className="cr-set-muted">
          <Spinner size={12} /> Loading…
        </p>
      ) : null}
      {status ? (
        <>
          <SessionDefaultsCard
            title="Global default"
            icon="sparkles"
            description="Every node uses this unless its project or repository sets its own."
            testid="settings-session-home"
            status={status}
            fields={status.home}
            inherit={status.builtin}
            resolved={status.resolved}
            save={async (patch) => setStatus(await saveHomeSessionDefaults(patch))}
          />
          <div className="cr-set-subhd" data-testid="settings-session-repos-heading">
            <h3>Per repository</h3>
            <p>Each overrides the global default for nodes in that repository.</p>
          </div>
          {repos.length === 0 ? (
            <p className="cr-set-muted" data-testid="settings-session-repos-empty">
              No repositories yet.{' '}
              <button type="button" className="cr-link" onClick={onOpenRepos}>
                Add one
              </button>
            </p>
          ) : null}
          {repos.map(([name, repo]) => (
            <SessionDefaultsCard
              key={name}
              title={name}
              icon={<RepoIcon remote={remotes.get(name)} size={16} />}
              testid={`settings-session-repo-${name}`}
              status={status}
              fields={repo}
              inherit={status.resolved}
              resolved={repo.resolved}
              save={async (patch) => setStatus(await saveRepoSessionDefaults(name, patch))}
            />
          ))}
          {projects.length > 0 ? (
            <div className="cr-set-subhd" data-testid="settings-session-projects-heading">
              <h3>Per project</h3>
              <p>Each overrides its repositories’ defaults and the global default.</p>
            </div>
          ) : null}
          {projects.map((project) => {
            const fields =
              project.id in savedProjects ? savedProjects[project.id] : project.session;
            return (
              <SessionDefaultsCard
                key={project.id}
                title={project.name}
                icon="layers"
                testid={`settings-session-project-${project.id}`}
                status={status}
                fields={fields ?? {}}
                inherit={status.resolved}
                resolved={projectResolved(status, project.repos ?? [], fields)}
                save={async (patch) => {
                  const saved = await updateProject(project.id, {
                    session: projectSessionAfter(patch),
                  });
                  setSavedProjects((prev) => ({ ...prev, [project.id]: saved.session }));
                }}
              />
            );
          })}
        </>
      ) : null}
    </SetSection>
  );
}

// ---------------------------------------------------------------- Classifier

function keyStatusText(status: ClassifierKeyStatus): string {
  if (status.source === 'none') return 'No key';
  const from = status.source === 'environment' ? ' · from the environment' : '';
  return `Key set${from}${status.loaded ? '' : ' · classifier off'}`;
}

function ClassifierSection(): JSX.Element {
  const inputId = useId();
  const [status, setStatus] = useState<ClassifierKeyStatus | undefined>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { saved, markSaved, clear } = useSavedFlash();

  useEffect(() => {
    getClassifierKey()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function act(fn: () => Promise<ClassifierKeyStatus>, after?: () => void): Promise<void> {
    setBusy(true);
    setError(undefined);
    clear();
    try {
      setStatus(await fn());
      setValue('');
      after?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  const set = status !== undefined && status.source !== 'none';
  return (
    <SetSection
      title="Classifier"
      description="Some rules are checked by a classifier: before an agent acts, TypeSafe reads the action and says whether it breaks the rule."
    >
      <SetCard
        title="TypeSafe API key"
        icon="key"
        description="Without a key, classifier checks are off. The daemon keeps the key and never shows it again."
        testid="settings-classifier-key"
        status={
          <Pill tone={set ? 'green' : 'gray'}>
            <span data-testid="settings-key-status">{status ? keyStatusText(status) : '…'}</span>
          </Pill>
        }
        onSubmit={() => {
          if (value.trim().length > 0 && !busy)
            void act(() => saveClassifierKey(value.trim()), markSaved);
        }}
        footer={
          <>
            <FormError error={error} />
            <SavedNote show={saved} testid="settings-key-saved" />
            {status?.source === 'config' ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="settings-key-remove"
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                Remove key
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              variant={value.trim() ? 'primary' : 'secondary'}
              busy={busy}
              disabled={value.trim().length === 0}
              data-testid="settings-key-save"
            >
              {set ? 'Replace key' : 'Save key'}
            </Button>
          </>
        }
      >
        <Field
          label={set ? 'New key' : 'API key'}
          htmlFor={inputId}
          hint={
            status?.source === 'environment'
              ? 'This key comes from the TYPESAFE_API_KEY variable the daemon was started with. A key saved here replaces it.'
              : status?.environment_also
                ? 'An environment key is also set; the key saved here is the one used.'
                : undefined
          }
        >
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-testid="settings-key-input"
            value={value}
            placeholder={set ? 'Paste a new key to replace it' : 'Paste a key'}
            onChange={(e) => {
              setValue(e.target.value);
              clear();
            }}
          />
        </Field>
      </SetCard>
      <ConfirmDialog
        open={confirm}
        title="Remove the TypeSafe key?"
        confirmLabel="Remove key"
        danger
        busy={busy}
        testid="settings-key-remove-dialog"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void act(removeClassifierKey)}
      >
        <p className="cr-set-confirm">
          {status?.environment_also
            ? 'The key from the environment is used instead.'
            : 'Classifier checks stop until you add a key again. The key is never shown, so you can’t copy it first.'}
        </p>
      </ConfirmDialog>
    </SetSection>
  );
}

// ---------------------------------------------------------------- Trackers

function TrackerCard({
  system,
  status,
  onStatus,
}: {
  system: 'jira' | 'linear';
  status: TrackerSettingsStatus | undefined;
  onStatus: (next: TrackerSettingsStatus) => void;
}): JSX.Element {
  const ids = useId();
  const jira = status?.jira;
  const tokenSet = status ? status[system].token_set : undefined;
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState<string | undefined>();
  const [email, setEmail] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { saved, markSaved, clear } = useSavedFlash();
  const shownBaseUrl = baseUrl ?? jira?.base_url ?? '';
  const shownEmail = email ?? jira?.email ?? '';
  const label = system === 'jira' ? 'Jira' : 'Linear';
  const id = `settings-tracker-${system}`;

  async function act(input: TrackerSettingsInput): Promise<void> {
    setBusy(true);
    setError(undefined);
    clear();
    try {
      onStatus(await saveTrackerSettings(input));
      setToken('');
      setBaseUrl(undefined);
      setEmail(undefined);
      markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
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
  return (
    <>
      <SetCard
        title={label}
        icon="ticket"
        testid={id}
        description={
          system === 'jira'
            ? 'Jira Cloud: your site, your Atlassian email and an API token. Server or Data Center: leave the email empty and use a personal access token.'
            : 'A personal API key, from Linear → Settings → Security & access.'
        }
        status={
          <Pill tone={tokenSet ? 'green' : 'gray'}>
            <span data-testid={`${id}-status`}>
              {tokenSet === undefined ? '…' : tokenSet ? 'Token set' : 'No token'}
            </span>
          </Pill>
        }
        onSubmit={() => {
          if (dirty && !busy) submit();
        }}
        footer={
          <>
            <FormError error={error} />
            <SavedNote show={saved} testid={`${id}-saved`} />
            {tokenSet ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`${id}-clear`}
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                Remove token
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              variant={dirty ? 'primary' : 'secondary'}
              busy={busy}
              disabled={!dirty}
              data-testid={`${id}-save`}
            >
              Save
            </Button>
          </>
        }
      >
        {system === 'jira' ? (
          <div className="cr-set-grid2">
            <Field label="Site URL" htmlFor={`${ids}-url`}>
              <input
                id={`${ids}-url`}
                type="url"
                data-testid="settings-tracker-jira-base-url"
                value={shownBaseUrl}
                placeholder="https://your-site.atlassian.net"
                spellCheck={false}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  clear();
                }}
              />
            </Field>
            <Field label="Email" htmlFor={`${ids}-email`} hint="Jira Cloud only.">
              <input
                id={`${ids}-email`}
                type="email"
                data-testid="settings-tracker-jira-email"
                value={shownEmail}
                placeholder="you@example.com"
                spellCheck={false}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clear();
                }}
              />
            </Field>
          </div>
        ) : null}
        <Field label={system === 'jira' ? 'API token' : 'API key'} htmlFor={`${ids}-token`}>
          <input
            id={`${ids}-token`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-testid={`${id}-token`}
            value={token}
            placeholder={tokenSet ? 'Paste a new token to replace it' : 'Paste a token'}
            onChange={(e) => {
              setToken(e.target.value);
              clear();
            }}
          />
        </Field>
      </SetCard>
      <ConfirmDialog
        open={confirm}
        title={`Remove the ${label} token?`}
        confirmLabel="Remove token"
        danger
        busy={busy}
        testid={`${id}-clear-dialog`}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void act({ system, token: null })}
      >
        <p className="cr-set-confirm">
          Linking nodes to {label} issues stops working until you add a token again.
        </p>
      </ConfirmDialog>
    </>
  );
}

function TrackersSection(): JSX.Element {
  const [status, setStatus] = useState<TrackerSettingsStatus | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    getTrackerSettings()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  return (
    <SetSection
      title="Trackers"
      description="Link nodes to issues in Jira or Linear: an issue’s text becomes the node’s goal, and its status can follow the node. Tokens are kept by the daemon and never shown again."
      testid="settings-trackers"
    >
      <FormError error={error} />
      <TrackerCard system="jira" status={status} onStatus={setStatus} />
      <TrackerCard system="linear" status={status} onStatus={setStatus} />
    </SetSection>
  );
}

// ---------------------------------------------------------------- Permissions

const GATE_TEXT: Record<
  (typeof GATE_KINDS)[number],
  { title: string; what: string; icon: IconName }
> = {
  land: {
    title: 'Merging a node',
    what: 'Finished work goes into its main branch (or its pull request is opened) only when you press Merge.',
    icon: 'git-merge',
  },
  rule_accept: {
    title: 'Accepting knowledge',
    what: 'A lesson from a finished node, or a rule an agent proposed, applies only once you accept it.',
    icon: 'book-open',
  },
  classifier_review: {
    title: 'An action the classifier was unsure of',
    what: 'When the classifier can’t tell whether an agent’s action breaks a rule, it asks you.',
    icon: 'shield-check',
  },
};

function PermissionsSection(): JSX.Element {
  const [policy, setPolicy] = useState<Policy | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    getPolicy()
      .then(setPolicy)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  return (
    <SetSection
      title="Permissions"
      description="Who decides when an agent reaches one of these. Each one waits for you in Needs me."
      testid="settings-permissions"
    >
      <FormError error={error} />
      <div className="cr-set-card">
        <ul className="cr-set-gates">
          {GATE_KINDS.map((gate) => {
            const owner = policy ? (policy.gates[gate] ?? 'human') : undefined;
            return (
              <li key={gate} className="cr-set-gate" data-gate={gate}>
                <span className="cr-set-card-icon">
                  <Icon name={GATE_TEXT[gate].icon} size={16} />
                </span>
                <div className="cr-set-gate-text">
                  <div className="cr-set-gate-title">{GATE_TEXT[gate].title}</div>
                  <div className="cr-set-gate-what">{GATE_TEXT[gate].what}</div>
                </div>
                <Badge tone={owner === 'human' ? 'accent' : 'neutral'} icon="user">
                  {owner === undefined ? '…' : owner === 'human' ? 'You' : owner}
                </Badge>
              </li>
            );
          })}
        </ul>
      </div>
    </SetSection>
  );
}
