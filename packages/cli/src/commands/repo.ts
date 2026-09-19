/**
 * `agile repo add <path>` / `agile repo list` (T111) — the repo registry in
 * the state home (`repos.yaml`, PLAN.md §5). One daemon serves many repos
 * (D9); registering one is how a repo becomes available to streams.
 */

import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ReposConfig } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
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
      }${entry.vendor ? `  vendor=${entry.vendor}` : ''}`,
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
