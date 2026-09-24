/**
 * `agile repo add <path>` / `agile repo list` (T111) — the repo registry in
 * the state home (`repos.yaml`, PLAN.md §5). One daemon serves many repos
 * (D9); registering one is how a repo becomes available to streams.
 */

import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RepoEntry, ReposConfig } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalList, optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printJson } from '../format';

export async function runRepoList(socketPath: string, json: boolean): Promise<number> {
  const repos = await callRpc<ReposConfig>(socketPath, 'state.repo_list', {});
  if (json) {
    printJson(repos);
    return 0;
  }
  const names = Object.keys(repos).sort();
  if (names.length === 0) {
    console.log('repos: (none registered)');
    return 0;
  }
  for (const name of names) {
    const entry = repos[name];
    if (entry === undefined) continue;
    console.log(
      `${name}  ${entry.path}  protected=${entry.protected_branches.join(',')}${
        entry.target_branch ? `  target=${entry.target_branch}` : ''
      }${entry.vendor ? `  vendor=${entry.vendor}` : ''}  delivery=${entry.delivery ?? 'direct'}${
        entry.auto_merge ? '  auto_merge=on' : ''
      }${entry.visibility?.mode === 'private' ? `  private=${entry.visibility.projects.join(',')}` : ''}`,
    );
  }
  return 0;
}

/**
 * `--name` defaults to the directory's basename. `--protected` is a
 * comma-separated list; omitted, the schema's `[main, master]` default (D8)
 * applies.
 */
export async function runRepoAdd(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  cwd: string,
): Promise<number> {
  const raw = requirePositional(args, 0, 'repo-path');
  const absolute = resolve(cwd, raw);
  let path: string;
  try {
    path = realpathSync(absolute);
  } catch {
    throw new Error(`agile repo add: ${absolute} does not exist`);
  }
  const name = optionalString(args.options, 'name') ?? basename(path);
  const protectedRaw = optionalString(args.options, 'protected');
  const target = optionalString(args.options, 'target-branch');
  const vendor = optionalString(args.options, 'vendor');

  const repos = await callRpc<ReposConfig>(socketPath, 'state.repo_add', {
    name,
    path,
    ...(protectedRaw !== undefined
      ? {
          protected_branches: protectedRaw
            .split(',')
            .map((b) => b.trim())
            .filter((b) => b.length > 0),
        }
      : {}),
    ...(target !== undefined ? { target_branch: target } : {}),
    ...(vendor !== undefined ? { vendor } : {}),
  });

  if (json) printJson(repos[name]);
  else console.log(`agile repo add: registered ${name} -> ${path}`);
  return 0;
}

/**
 * T222 (§14.8): `agile repo set <name> [--delivery direct|pr] [--auto-merge on|off]
 * [--remote r] [--main-branch b] [--visibility public|private] [--project P-…]…`.
 * `--project` (repeatable or comma-separated) names the projects that may
 * see a private repo. The daemon refuses `pr` without a GitHub remote and auth.
 */
export async function runRepoSet(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const name = requirePositional(args, 0, 'repo-name');
  const o = args.options;
  const patch: Record<string, unknown> = {};
  const delivery = optionalString(o, 'delivery');
  if (delivery !== undefined) {
    if (delivery !== 'direct' && delivery !== 'pr')
      throw new Error('agile repo set: --delivery must be direct or pr');
    patch.delivery = delivery;
  }
  const autoMerge = optionalString(o, 'auto-merge');
  if (autoMerge !== undefined) {
    if (autoMerge !== 'on' && autoMerge !== 'off')
      throw new Error('agile repo set: --auto-merge must be on or off');
    patch.auto_merge = autoMerge === 'on';
  }
  const remote = optionalString(o, 'remote');
  if (remote !== undefined) patch.remote = remote;
  const mainBranch = optionalString(o, 'main-branch');
  if (mainBranch !== undefined) patch.main_branch = mainBranch;
  const visibility = optionalString(o, 'visibility');
  const projects = optionalList(args, 'project');
  if (visibility === 'public') {
    if (projects !== undefined)
      throw new Error('agile repo set: --project applies to --visibility private only');
    patch.visibility = { mode: 'public' };
  } else if (visibility === 'private') {
    if (projects === undefined)
      throw new Error('agile repo set: --visibility private needs --project <P-id>');
    patch.visibility = { mode: 'private', projects };
  } else if (visibility !== undefined) {
    throw new Error('agile repo set: --visibility must be public or private');
  } else if (projects !== undefined) {
    throw new Error('agile repo set: --project needs --visibility private');
  }
  if (Object.keys(patch).length === 0) throw new Error('agile repo set: nothing to set');

  const entry = await callRpc<RepoEntry>(socketPath, 'state.repo_set', { name, ...patch });
  if (json) printJson(entry);
  else
    console.log(
      `agile repo set: ${name} delivery=${entry.delivery ?? 'direct'} auto_merge=${
        entry.auto_merge ? 'on' : 'off'
      } visibility=${entry.visibility?.mode ?? 'public'}${
        entry.github ? ` github=${entry.github.owner}/${entry.github.repo}` : ''
      }`,
    );
  return 0;
}
