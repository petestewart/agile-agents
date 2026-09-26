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
 * 2. Each `rules/R-X.yaml` becomes `knowledge/K-X.yaml` (T260,
 *    `migrateRuleRecord`): `kind: standard`, `stream` scope → `subtree`,
 *    the old tier and stage → one enforcement, a classifier rule at stage
 *    `both` split into an `action` and a `ship` item (P6). A rule whose
 *    `K-X` exists is skipped. `rules/` is left on disk, read-only.
 *
 * One `home_migrated` event per run that changed something.
 */

import {
  type Project,
  type Stream,
  migrateRuleRecord,
  projectNameKey,
  splitFinding,
  ulid,
} from '@agile-agents/shared';
import type { ProjectService } from '../projects/service';
import type { QuestionService } from '../questions/service';
import { branchLabel } from '../runner/worktrees';
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
  /** Knowledge items written from legacy rules (step 2). */
  knowledge: number;
}

/** Step 2: every legacy rule without its `K-X` becomes knowledge. Returns the items written. */
export async function migrateRules(store: StateStore): Promise<number> {
  let written = 0;
  // A P6 twin has a fresh id, so it is found by its link to the rule
  // (`splitFinding`), not by id: a crash between the pair's two writes is
  // completed on the next start.
  const twins = new Set(
    store
      .listKnowledge()
      .map((item) => item.source.finding)
      .filter((f): f is string => f !== undefined),
  );
  for (const rule of store.listLegacyRules()) {
    const [base, twin] = migrateRuleRecord(rule, `K-${ulid()}`);
    if (base !== undefined && !store.hasKnowledge(base.id)) {
      await store.createKnowledge('daemon', base);
      written++;
    }
    if (twin !== undefined && !twins.has(splitFinding(rule.id))) {
      await store.createKnowledge('daemon', twin);
      written++;
    }
  }
  return written;
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
    knowledge: await migrateRules(store),
  };
  if (staleStreams.length === 0 && staleRepos.length === 0) {
    // Steps 1, 3 and 4 are done (a home migrated before T260): only step 2 may have run.
    if (result.knowledge === 0) return result;
    await store.appendEvent(
      buildEvent('home_migrated', {
        data: {
          reparented: 0,
          streams: 0,
          repos: [],
          parent_branches: 0,
          knowledge: result.knowledge,
        },
      }),
    );
    result.migrated = true;
    return result;
  }

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
    .map((s) => `${s.title}: branch ${branchLabel(s.branch ?? '')} in ${s.repo ?? 'no repo'}`)
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
        knowledge: result.knowledge,
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
