/**
 * `ProjectService` (T200, projects-design §14.1, P2): a project is a record
 * in `projects/<id>.yaml` plus a root node — a parentless stream that
 * carries the project's thread. Create makes both; the store enforces
 * name uniqueness (case-insensitive) under its mutex.
 */

import {
  type Project,
  type ProjectUpdateInput,
  ulid,
  validateProjectCreateInput,
  validateProjectUpdateInput,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';
import { type StreamService, UnknownRepoError } from '../streams/service';

export interface ListProjectsOptions {
  include_archived?: boolean;
}

export class ProjectService {
  constructor(
    private readonly store: StateStore,
    private readonly streams: StreamService,
  ) {}

  private assertReposKnown(repos: readonly string[]): void {
    const known = this.store.getRepos();
    for (const repo of repos) {
      if (known[repo] === undefined) throw new UnknownRepoError(repo, Object.keys(known).sort());
    }
  }

  /** Creates the root stream, then the record that points at it. */
  async create(rawInput: unknown): Promise<Project> {
    const input = validateProjectCreateInput(rawInput);
    this.assertReposKnown(input.repos);
    // Fail fast before minting a root; the store re-checks under its mutex.
    this.store.assertProjectNameFree(input.name);
    const id = `P-${ulid()}`;
    const root = await this.streams.createRoot('human', id, input.name, `Project ${input.name}`);
    try {
      return await this.store.createProject({
        id,
        name: input.name,
        root: root.id,
        repos: [...new Set(input.repos)],
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      // A lost name race (or any refusal) must not leave a live orphan root.
      await this.streams.archive('daemon', root.id).catch(() => undefined);
      throw err;
    }
  }

  get(id: string): Project {
    return this.store.getProject(id);
  }

  list(options: ListProjectsOptions = {}): Project[] {
    const all = this.store.listProjects();
    return options.include_archived === true ? all : all.filter((p) => p.archived !== true);
  }

  /** Settings only; `null` clears an optional block, autonomy merges per field. */
  async update(id: string, rawPatch: unknown): Promise<Project> {
    const patch: ProjectUpdateInput = validateProjectUpdateInput(rawPatch);
    if (patch.repos !== undefined) this.assertReposKnown(patch.repos);
    return this.store.updateProject(id, (before) => {
      const next: Project = { ...before, autonomy: { ...before.autonomy, ...patch.autonomy } };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.repos !== undefined) next.repos = [...new Set(patch.repos)];
      for (const key of ['session', 'delivery', 'tracker'] as const) {
        const value = patch[key];
        if (value === null) delete next[key];
        else if (value !== undefined) (next as Record<string, unknown>)[key] = value;
      }
      return next;
    });
  }

  /** Hides the project from `list`; nothing moves on disk, the root stream is untouched. */
  async archive(id: string): Promise<Project> {
    return this.store.updateProject(id, (before) => ({ ...before, archived: true }));
  }
}
