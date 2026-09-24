/**
 * Repo visibility (projects-design §4.4, P13), the built-in path check.
 * A private repo is readable only by nodes in the projects it lists, and a
 * node only ever changes code in its own repo, whatever the visibility.
 * Pure: the caller resolves the node's repo, project and the registry.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { ReposConfig } from '@agile-agents/shared';
import { parseCommandIntoAtoms } from './command';

export interface VisibilityContext {
  /** The node's own repo (`stream.repo`); absent for a node with none. */
  ownRepo?: string;
  /** The node's project; absent reads no private repo. */
  project?: string;
  repos: ReposConfig;
  /** Set when repos.yaml could not be read: fail closed, only the worktree is touchable. */
  reposError?: string;
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
    if (ctx.reposError !== undefined) {
      if (contains(resolve(ctx.worktreePath), path)) continue;
      return `${raw} is outside this node's worktree and repos.yaml could not be read (${ctx.reposError}); repo visibility cannot be checked, so the call is denied.`;
    }
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

/** Commands whose path arguments are all written; `cp`/`mv` write only their last. */
const WRITERS = new Set(['rm', 'touch', 'mkdir', 'rmdir', 'tee', 'truncate', 'chmod', 'ln']);
const MOVERS = new Set(['cp', 'mv', 'rsync', 'install']);

/**
 * Best effort: the path-like arguments of a shell command, split into
 * reads and writes, via the same atom parse the pattern rules use.
 */
export function commandPaths(command: string): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const { tokens } of parseCommandIntoAtoms(command)) {
    const args: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i] ?? '';
      if (t === '>' || t === '>>') {
        const target = tokens[++i];
        if (target !== undefined) writes.push(target);
      } else if (!t.startsWith('-') && (t.includes('/') || t.startsWith('.'))) {
        args.push(t);
      }
    }
    const cmd = tokens[0] ?? '';
    const inPlace = cmd === 'sed' && tokens.some((t) => t.startsWith('-i'));
    if (WRITERS.has(cmd) || inPlace) writes.push(...args);
    else if (MOVERS.has(cmd) && args.length > 1) {
      writes.push(args.at(-1) as string);
      reads.push(...args.slice(0, -1));
    } else reads.push(...args);
  }
  return { reads, writes };
}
