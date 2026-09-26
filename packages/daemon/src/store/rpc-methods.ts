/** The `state.*` RPC: the repo registry (`repos.yaml`, D9), used by `agile repo add|list` and Settings → Repos (T206). */

import { realpathSync } from 'node:fs';
import { type RepoEntry, RepoSettingsPatchSchema, formatZodError } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import { repoFromRemoteUrl } from '../github/rest';
import type { RpcMethodHandler } from '../rpc';
import { parseRemoteUrl } from './remote-url';
import type { StateStore } from './store';

function gitOut(args: string[], cwd: string): string | undefined {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
    return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : undefined;
  } catch {
    return undefined; // cwd gone: no answer, not a crash
  }
}

/**
 * A repo a stream can't cut a branch in is caller input: -32602 at add time,
 * not a fault later. The path must be the repo's toplevel, not a subdirectory.
 */
function assertGitToplevel(path: string): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new RpcParamError(`state.repo_add: ${path} does not exist`);
  }
  const top = gitOut(['rev-parse', '--show-toplevel'], real);
  if (top === undefined) throw new RpcParamError(`state.repo_add: ${path} is not a git repository`);
  if (realpathSync(top) !== real) {
    throw new RpcParamError(`state.repo_add: ${path} is not the repo's toplevel (that is ${top})`);
  }
}

/**
 * The branch a repo's work delivers to (projects-design §14.8 `main_branch`,
 * set by the T202 migration or later): `main_branch`, else `target_branch`, else the remote's
 * default branch, else `main`/`master` if present, else `main`.
 */
export function resolveMainBranch(entry: RepoEntry): string {
  if (entry.main_branch) return entry.main_branch;
  if (entry.target_branch) return entry.target_branch;
  const remote = gitOut(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], entry.path);
  if (remote) return remote.replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if (gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], entry.path) !== undefined)
      return b;
  }
  return 'main';
}

/**
 * T214: a repo whose main branch has no commit can't have a branch cut from it.
 * The one-line refusal, or undefined when HEAD (what worktrees branch from) resolves.
 */
export function emptyRepoMessage(name: string, entry: RepoEntry): string | undefined {
  // Only a real repo with an unborn HEAD; a missing path or non-repo fails elsewhere.
  if (gitOut(['rev-parse', '--git-dir'], entry.path) === undefined) return undefined;
  if (gitOut(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], entry.path) !== undefined) {
    return undefined;
  }
  return `${name} has no commits on ${resolveMainBranch(entry)}; make an initial commit first`;
}

/** A node can't start in a repo with no commits (T214): refused before anything is written. */
export class EmptyRepoError extends Error {
  constructor(name: string, entry: RepoEntry) {
    super(emptyRepoMessage(name, entry) ?? `${name} has no commits`);
    this.name = 'EmptyRepoError';
  }
}

/** Throws {@link EmptyRepoError} when the repo has no commits. */
export function assertRepoHasCommits(name: string, entry: RepoEntry): void {
  if (emptyRepoMessage(name, entry) !== undefined) throw new EmptyRepoError(name, entry);
}

export interface StateRpcOptions {
  /**
   * T221/T222: whether `gh` can supply a token. The pr refusal asks it;
   * absent means unavailable, so nothing here reaches a real `gh` unless
   * the daemon wires it.
   */
  githubAuth?: () => Promise<boolean>;
}

/**
 * T222 (§14.8): validate and apply one repo's delivery settings. `pr` is
 * refused unless the repo's remote is on github.com and GitHub auth is
 * available; accepted, the owner/repo is stored as `github`.
 */
export async function setRepoSettings(
  store: StateStore,
  name: string,
  input: unknown,
  options: StateRpcOptions & { by?: string } = {},
): Promise<RepoEntry> {
  const parsed = RepoSettingsPatchSchema.safeParse(input);
  if (!parsed.success) throw new RpcParamError(formatZodError('repo settings', parsed.error));
  const patch: Record<string, unknown> = { ...parsed.data };
  const entry = store.getRepos()[name];
  if (entry === undefined) throw new RpcParamError(`state.repo_set: no repo named ${name}`);
  const visibility = parsed.data.visibility;
  if (visibility?.mode === 'private') {
    for (const id of visibility.projects) {
      try {
        store.getProject(id);
      } catch {
        throw new RpcParamError(`state.repo_set: no project ${id}`);
      }
    }
  }
  const mode = parsed.data.delivery ?? entry.delivery ?? 'direct';
  if (parsed.data.delivery === 'pr' || (mode === 'pr' && parsed.data.remote !== undefined)) {
    const remote =
      (parsed.data.remote === undefined ? entry.remote : parsed.data.remote) ?? 'origin';
    const url = gitOut(['remote', 'get-url', remote], entry.path);
    if (url === undefined) {
      throw new RpcParamError(
        `state.repo_set: pr delivery needs a remote; ${name} has no remote ${remote}`,
      );
    }
    if (parseRemoteUrl(url)?.host !== 'github.com') {
      throw new RpcParamError(
        `state.repo_set: pr delivery needs a GitHub remote; ${remote} is not on github.com`,
      );
    }
    let github: { owner: string; repo: string };
    try {
      github = repoFromRemoteUrl(url);
    } catch (err) {
      throw new RpcParamError(
        `state.repo_set: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!(await (options.githubAuth?.() ?? Promise.resolve(false)))) {
      throw new RpcParamError(
        'state.repo_set: pr delivery needs GitHub auth — run `gh auth login` (see `agile daemon status`)',
      );
    }
    patch.github = github;
  }
  return store.setRepoSettings(name, patch, options.by ? { by: options.by } : {});
}

export function buildStateRpcMethods(
  store: StateStore,
  options: StateRpcOptions = {},
): Record<string, RpcMethodHandler> {
  return {
    'state.repo_set': async (params) => {
      const { name, ...patch } = (params ?? {}) as { name?: unknown } & Record<string, unknown>;
      if (typeof name !== 'string' || name.length === 0) {
        throw new RpcParamError('state.repo_set: name is required');
      }
      return setRepoSettings(store, name, patch, { ...options, by: 'human' });
    },
    'state.repo_list': () => store.getRepos(),
    'state.repo_add': async (params) => {
      const { name, ...entry } = params as { name?: string } & Record<string, unknown>;
      if (typeof name !== 'string' || name.length === 0) {
        throw new RpcParamError('state.repo_add: name is required');
      }
      const { path } = entry as { path?: unknown };
      if (typeof path !== 'string' || path.length === 0) {
        throw new RpcParamError('state.repo_add: path is required');
      }
      assertGitToplevel(path);
      // T378: re-registering a name keeps what was set on it (delivery, visibility,
      // GitHub, defaults) instead of resetting it to a fresh repo's.
      const existing = store.getRepos()[name];
      return store.addRepo(
        name,
        { ...(existing ?? {}), ...entry, path: realpathSync(path) },
        { by: 'human' },
      );
    },
  };
}
