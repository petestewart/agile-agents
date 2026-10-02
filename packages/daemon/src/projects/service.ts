/**
 * `ProjectService` (T200, projects-design §14.1, P2): a project is a record
 * in `projects/<id>.yaml` plus a root node — a parentless stream that
 * carries the project's thread. Create makes both; the store enforces
 * name uniqueness (case-insensitive) under its mutex.
 */

import {
  type ModelPolicyPartial,
  type Project,
  type ProjectUpdateInput,
  type StreamPrincipal,
  ulid,
  validateProjectCreateInput,
  validateProjectUpdateInput,
} from '@agile-agents/shared';
import { isPathInside } from '../permissions/command';
import { readRootRefusal } from '../permissions/policy-tables';
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

  /**
   * Creates the root stream, then the record that points at it. T482 (D54):
   * a new project's `model_policy` is `{}`, inheriting the home's model
   * choice; `options.modelPolicy` sets another (the migration's Default).
   */
  async create(
    rawInput: unknown,
    principal: StreamPrincipal = 'human',
    options: { modelPolicy?: ModelPolicyPartial } = {},
  ): Promise<Project> {
    const input = validateProjectCreateInput(rawInput);
    this.assertReposKnown(input.repos);
    // Fail fast before minting a root; the store re-checks under its mutex.
    this.store.assertProjectNameFree(input.name);
    const id = `P-${ulid()}`;
    const root = await this.streams.createRoot(principal, id, input.name, `Project ${input.name}`);
    try {
      return await this.store.createProject({
        id,
        name: input.name,
        root: root.id,
        repos: [...new Set(input.repos)],
        model_policy: options.modelPolicy ?? {},
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
    for (const root of patch.read_roots ?? []) assertReadRoot(root);
    return this.store.updateProject(id, (before) => {
      const next: Project = { ...before, autonomy: { ...before.autonomy, ...patch.autonomy } };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.repos !== undefined) next.repos = [...new Set(patch.repos)];
      for (const key of [
        'session',
        'vendor_failure',
        'delivery',
        'tracker',
        'permissions',
      ] as const) {
        const value = patch[key];
        if (value === null) delete next[key];
        else if (value !== undefined) (next as Record<string, unknown>)[key] = value;
      }
      // T457: the whole list (Settings removes one); empty is none.
      if (patch.read_roots === null || patch.read_roots?.length === 0) {
        Reflect.deleteProperty(next, 'read_roots');
      } else if (patch.read_roots !== undefined) next.read_roots = [...new Set(patch.read_roots)];
      return next;
    });
  }

  /**
   * T457: "Always for this project" — every node in the project may read
   * `root` from now on. A root already covered by one on the list is a no-op.
   */
  async addReadRoot(id: string, root: string): Promise<Project> {
    assertReadRoot(root);
    return this.store.updateProject(id, (before) => {
      const roots = before.read_roots ?? [];
      if (roots.some((existing) => isPathInside(root, existing))) return before;
      return { ...before, read_roots: [...roots, root] };
    });
  }

  /** Hides the project from `list`; nothing moves on disk, the root stream is untouched. */
  async archive(id: string): Promise<Project> {
    return this.store.updateProject(id, (before) => ({ ...before, archived: true }));
  }
}

/** T457: `/`, the home dir or a dir above it is refused as a read root (use Trusted instead). */
function assertReadRoot(root: string): void {
  const refusal = readRootRefusal(root);
  if (refusal !== undefined) throw new Error(`invalid read root ${refusal}`);
}
