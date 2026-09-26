/**
 * T379: what a new session resolves to, as the cockpit shows it (New node's
 * "Starts with", the composer's model chip, the picker's prefill, Settings).
 * The same order as attach (`resolveSessionDefaults`, D17 and P5).
 */

import {
  type ProjectSessionDefaults,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
  resolveSessionDefaults,
} from '@agile-agents/shared';

/**
 * What a stream in `repo` (or no repo) resolves to with nothing named.
 * T379: its project's own defaults (P5) come before the repo's, as in attach.
 */
export function resolvedFor(
  status: SessionDefaultsStatus,
  repo: string | undefined,
  project?: ProjectSessionDefaults,
): ResolvedSessionDefaults {
  const base = (repo !== undefined ? status.repos[repo]?.resolved : undefined) ?? status.resolved;
  if (
    project?.vendor === undefined &&
    project?.model === undefined &&
    project?.effort === undefined
  ) {
    return base;
  }
  const repoFields = repo !== undefined ? status.repos[repo] : undefined;
  return resolveSessionDefaults({
    project,
    ...(repoFields ? { repo: repoFields } : {}),
    home: {
      ...(status.home.vendor !== undefined ? { default_vendor: status.home.vendor } : {}),
      ...(status.home.model !== undefined ? { default_model: status.home.model } : {}),
      ...(status.home.effort !== undefined ? { default_effort: status.home.effort } : {}),
    },
  });
}
