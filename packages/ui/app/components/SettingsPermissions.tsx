/**
 * T457: Settings → General → Permissions. What an agent may read outside
 * its own worktree and the registered repos: **Trusted** (any path on disk,
 * never the agile home, other projects' private repos or credentials) or
 * **Ask** (the default: a read anywhere else waits in Needs me). The home's
 * choice, then each project's override ("Inherits Ask from the home") and
 * the dirs its "Always for this project" answers added, each removable.
 * Every change saves at once and says "Saved" in place.
 */

import type { PermissionPosture } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { getPermissions, setPermissions, updateProject } from '../lib/api';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow } from '../lib/feed-types';
import { FormError, SavedNote, SetCard, SetRow, errorText, useSavedFlash } from './SettingsCard';
import { IconButton, Segmented, Spinner } from './ui';

const WORDS: Record<PermissionPosture, string> = { trusted: 'Trusted', ask: 'Ask' };

/** One line each on what the choice means. */
const HINTS: Record<PermissionPosture, string> = {
  trusted:
    'Agents read any path on disk without asking: never the agile home, other projects’ private repos or credentials (~/.ssh, ~/.aws…).',
  ask: 'Agents read the registered repos; a read anywhere else waits for you in Needs me (Allow once, Always for this project, Deny).',
};

type ProjectChoice = PermissionPosture | 'inherit';

/** What a save returned for a project, until the next frame carries it. */
interface ProjectSaved {
  permissions?: PermissionPosture;
  read_roots?: string[];
}

export function PermissionsCard(): JSX.Element {
  const [home, setHome] = useState<PermissionPosture | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<Record<string, ProjectSaved>>({});
  const flash = useSavedFlash();
  const projects = useOptionalFeed()?.cockpit?.projects ?? [];

  useEffect(() => {
    getPermissions()
      .then((setting) => setHome(setting.posture))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function saveHome(next: PermissionPosture): Promise<void> {
    setBusy(true);
    setError(undefined);
    flash.clear();
    try {
      setHome((await setPermissions(next)).posture);
      flash.markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetCard
      title="Permissions"
      icon="lock"
      description="What agents may read outside their own worktree. Writes always stay in the node’s own worktree, and the calls that are always yours still ask."
      testid="settings-permissions"
      status={
        busy ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Saving
          </span>
        ) : (
          <SavedNote show={flash.saved} testid="settings-permissions-saved" />
        )
      }
    >
      <SetRow
        label="Every project"
        hint={home !== undefined ? HINTS[home] : undefined}
        testid="settings-permissions-home"
      >
        {home === undefined && error === undefined ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Loading…
          </span>
        ) : (
          <Segmented<PermissionPosture>
            label="Permissions"
            testid="settings-permissions-choice"
            value={home ?? 'ask'}
            onChange={(next) => void saveHome(next)}
            items={(['trusted', 'ask'] as const).map((id) => ({
              id,
              label: WORDS[id],
              testid: `settings-permissions-${id}`,
              title: HINTS[id],
              disabled: busy || home === undefined,
            }))}
          />
        )}
      </SetRow>
      {projects.map((project) => (
        <ProjectPermissionsRow
          key={project.id}
          project={project}
          home={home ?? 'ask'}
          saved={saved[project.id]}
          onSaved={(next) => {
            setSaved((prev) => ({ ...prev, [project.id]: next }));
            flash.markSaved();
          }}
          onError={setError}
        />
      ))}
      <FormError error={error} />
    </SetCard>
  );
}

function ProjectPermissionsRow({
  project,
  home,
  saved,
  onSaved,
  onError,
}: {
  project: CockpitProjectRow;
  home: PermissionPosture;
  saved: ProjectSaved | undefined;
  onSaved: (next: ProjectSaved) => void;
  onError: (error: string | undefined) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const permissions = saved !== undefined ? saved.permissions : project.permissions;
  const roots = (saved !== undefined ? saved.read_roots : project.read_roots) ?? [];
  const testid = `settings-permissions-project-${project.id}`;

  async function save(patch: {
    permissions?: PermissionPosture | null;
    read_roots?: string[] | null;
  }): Promise<void> {
    setBusy(true);
    onError(undefined);
    try {
      const next = await updateProject(project.id, patch);
      onSaved({
        ...(next.permissions !== undefined ? { permissions: next.permissions } : {}),
        ...(next.read_roots !== undefined ? { read_roots: next.read_roots } : {}),
      });
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const choice: ProjectChoice = permissions ?? 'inherit';
  return (
    <SetRow
      label={project.name}
      hint={
        permissions === undefined ? (
          <span data-testid={`${testid}-inherits`}>Inherits {WORDS[home]} from the home</span>
        ) : (
          HINTS[permissions]
        )
      }
      testid={testid}
    >
      <Segmented<ProjectChoice>
        label={`Permissions for ${project.name}`}
        testid={`${testid}-choice`}
        value={choice}
        onChange={(next) => void save({ permissions: next === 'inherit' ? null : next })}
        items={(['inherit', 'trusted', 'ask'] as const).map((id) => ({
          id,
          label: id === 'inherit' ? 'Inherit' : WORDS[id],
          testid: `${testid}-${id}`,
          disabled: busy,
          ...(id === 'inherit' ? { title: `Use the home’s choice (${WORDS[home]})` } : {}),
        }))}
      />
      {roots.length > 0 ? (
        <ul className="cr-set-roots" data-testid={`${testid}-roots`} aria-label="Always readable">
          {roots.map((root) => (
            <li key={root}>
              <code title={root}>{root}</code>
              <IconButton
                icon="x"
                size="sm"
                label={`Remove ${root}`}
                data-testid={`${testid}-root-remove`}
                disabled={busy}
                onClick={() => {
                  const rest = roots.filter((r) => r !== root);
                  void save({ read_roots: rest.length > 0 ? rest : null });
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </SetRow>
  );
}
