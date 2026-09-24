/**
 * Repo visibility (projects-design §4.4, P13), the built-in path check.
 * A private repo is readable only by nodes in the projects it lists, and a
 * node only ever changes code in its own repo, whatever the visibility.
 * Pure: the caller resolves the node's repo, project and the registry.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { ReposConfig } from '@agile-agents/shared';

export interface VisibilityContext {
  /** The node's own repo (`stream.repo`); absent for a node with none. */
  ownRepo?: string;
  /** The node's project; absent reads no private repo. */
  project?: string;
  repos: ReposConfig;
  /** Relative tool paths resolve against it. */
  worktreePath: string;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The registered repo a path lies under (the deepest root wins), if any. */
export function repoOfPath(repos: ReposConfig, path: string): string | undefined {
  let best: { name: string; depth: number } | undefined;
  for (const [name, entry] of Object.entries(repos)) {
    const root = resolve(entry.path);
    if (contains(root, path) && (best === undefined || root.length > best.depth)) {
      best = { name, depth: root.length };
    }
  }
  return best?.name;
}

/** May a node in `project` read `repo`? Public (or unset) repos are readable by all. */
export function canReadRepo(
  repos: ReposConfig,
  repo: string,
  project: string | undefined,
): boolean {
  const visibility = repos[repo]?.visibility;
  if (visibility === undefined || visibility.mode === 'public') return true;
  return project !== undefined && (visibility.projects as readonly string[]).includes(project);
}

/** The deny reason for the first path the node may not touch, or `undefined`. */
export function visibilityDenyReason(
  ctx: VisibilityContext,
  paths: readonly string[],
  writes: boolean,
): string | undefined {
  for (const raw of paths) {
    const path = resolve(ctx.worktreePath, raw);
    const repo = repoOfPath(ctx.repos, path);
    if (repo === undefined || repo === ctx.ownRepo) continue;
    if (!canReadRepo(ctx.repos, repo, ctx.project)) {
      const visibility = ctx.repos[repo]?.visibility;
      const listed = visibility?.mode === 'private' ? visibility.projects.join(', ') : '';
      return `${raw} is in repo ${repo}, which is private to ${listed || 'no project'}; this node's project (${ctx.project ?? 'none'}) cannot read it.`;
    }
    if (writes) {
      return `${raw} is in repo ${repo}; code changes are limited to this node's own repo (${ctx.ownRepo ?? 'none'}).`;
    }
  }
  return undefined;
}
