/**
 * The one-shot home migration into projects (projects-design §17.1, T202).
 *
 * Runs on every daemon start and is idempotent: it acts only while a stream
 * has no `project` or a repo entry has no `delivery`/`visibility`, so a
 * second start finds nothing to do and writes nothing.
 *
 * 1. Project "Unfiled" (reused by name if present); every parentless stream
 *    that is not a project root becomes a child of its root, and every
 *    stream gets `project`. Ids are kept (P2).
 * 3. `repos.yaml` entries get `delivery: direct`, `visibility: public`, and
 *    `target_branch` carried over as `main_branch` (kept too, until T203
 *    removes the parent-branch target), with a note on the Unfiled thread.
 * 4. Branches of parents in the old integration model that are not landed
 *    are listed in one inbox card (a question on the Unfiled root).
 *
 * Step 2 (rules → knowledge) is T260. One `home_migrated` event per run
 * that changed something.
 */

import { type Project, type Stream, projectNameKey } from '@agile-agents/shared';
import type { ProjectService } from '../projects/service';
import type { QuestionService } from '../questions/service';
import type { StreamService } from '../streams/service';
import { buildEvent } from './events';
import type { StateStore } from './store';

export const UNFILED_PROJECT = 'Unfiled';

export interface HomeMigrationDeps {
  store: StateStore;
  streams: StreamService;
  projects: ProjectService;
  questions: QuestionService;
}

export interface HomeMigrationResult {
  migrated: boolean;
  project?: string;
  reparented: number;
  streams: number;
  repos: string[];
  parent_branches: string[];
}

function needsRepoMigration(entry: { delivery?: unknown; visibility?: unknown }): boolean {
  return entry.delivery === undefined || entry.visibility === undefined;
}

export async function migrateHome(deps: HomeMigrationDeps): Promise<HomeMigrationResult> {
  const { store, streams, projects, questions } = deps;
  const all = store.listStreams();
  const repos = store.getRepos();
  const staleStreams = all.filter((s) => s.project === undefined);
  const staleRepos = Object.keys(repos)
    .filter((name) => needsRepoMigration(repos[name] ?? {}))
    .sort();
  const result: HomeMigrationResult = {
    migrated: false,
    reparented: 0,
    streams: 0,
    repos: [],
    parent_branches: [],
  };
  if (staleStreams.length === 0 && staleRepos.length === 0) return result;

  // Made only when a stream or a note needs a home: a repos-only run makes no project.
  let unfiledCache: Project | undefined;
  const unfiled = async (): Promise<Project> => {
    unfiledCache ??= await unfiledProject(projects);
    result.project = unfiledCache.id;
    return unfiledCache;
  };

  // Step 1: each stream's project is its top ancestor's (a project root's
  // own), or Unfiled for a legacy tree.
  const byId = new Map(all.map((s) => [s.id, s] as const));
  const projectOf = async (s: Stream): Promise<string> => {
    let top = s;
    const seen = new Set<string>();
    while (top.parent !== undefined && !seen.has(top.id)) {
      seen.add(top.id);
      const up = byId.get(top.parent);
      if (up === undefined) break;
      top = up;
    }
    return top.project ?? (await unfiled()).id;
  };
  for (const s of staleStreams) {
    const project = await projectOf(s);
    const reparent = s.parent === undefined && s.id !== (await unfiled()).root;
    await store.updateStream('daemon', s.id, (before) => ({
      ...before,
      project,
      ...(reparent ? { parent: unfiledCache?.root } : {}),
    }));
    result.streams++;
    if (reparent) result.reparented++;
  }

  // Step 3.
  if (staleRepos.length > 0) {
    const next = { ...repos };
    const notes: string[] = [];
    for (const name of staleRepos) {
      const entry = repos[name];
      if (entry === undefined) continue;
      next[name] = {
        ...entry,
        delivery: entry.delivery ?? 'direct',
        visibility: entry.visibility ?? { mode: 'public' },
        ...(entry.target_branch !== undefined && entry.main_branch === undefined
          ? { main_branch: entry.target_branch }
          : {}),
      };
      if (entry.target_branch !== undefined && entry.main_branch === undefined) {
        notes.push(`${name}: target_branch ${entry.target_branch} is now main_branch`);
      }
    }
    await store.putRepos(next);
    result.repos = staleRepos;
    if (notes.length > 0) {
      await streams.appendThread('daemon', (await unfiled()).root, {
        kind: 'event',
        body: `home migration: ${notes.join('; ')}`,
      });
    }
  }

  // Step 4: parents in the old integration model — a branch plus live
  // children — whose branch was never landed.
  const hasLiveChild = new Set(
    all.filter((s) => s.archived !== true && s.parent !== undefined).map((s) => s.parent),
  );
  const parentBranches = all
    .filter(
      (s) =>
        s.branch !== undefined &&
        s.archived !== true &&
        hasLiveChild.has(s.id) &&
        s.human.status !== 'landed' &&
        s.human.status !== 'closed',
    )
    .map((s) => `${s.branch} (${s.repo ?? 'no repo'}, stream ${s.id} "${s.title}")`)
    .sort();
  result.parent_branches = parentBranches;
  if (parentBranches.length > 0) {
    await questions.raise({
      stream: (await unfiled()).root,
      raised_by: 'daemon',
      text: `Home migration: these parent integration branches are not merged. Children now deliver to the repo's main branch, so deliver or close each one:\n${parentBranches.map((b) => `- ${b}`).join('\n')}`,
    });
  }

  await store.appendEvent(
    buildEvent('home_migrated', {
      data: {
        ...(result.project !== undefined ? { project: result.project } : {}),
        reparented: result.reparented,
        streams: result.streams,
        repos: result.repos,
        parent_branches: parentBranches.length,
      },
    }),
  );
  result.migrated = true;
  return result;
}

async function unfiledProject(projects: ProjectService): Promise<Project> {
  const key = projectNameKey(UNFILED_PROJECT);
  const existing = projects
    .list({ include_archived: true })
    .find((p) => projectNameKey(p.name) === key);
  return existing ?? projects.create({ name: UNFILED_PROJECT });
}
