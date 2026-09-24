/**
 * `agile project new|list|show|set` (T200) — the CLI over the daemon's
 * `project.*` RPC (projects-design §14.1). Thin, like `stream.ts`: parse
 * argv, call one method, print human or `--json`. `--repo` repeats and/or
 * takes a comma-separated list of names from `repos.yaml`.
 */

import type { Project } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { hasFlag, optionalList, optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

export async function runProjectNew(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const name = requireOption(args.options, 'name');
  const repos = optionalList(args, 'repo');
  const project = await callRpc<Project>(socketPath, 'project.create', {
    name,
    ...(repos !== undefined ? { repos } : {}),
  });
  if (json) printJson(project);
  else console.log(`agile project new: ${project.id}  ${project.name}  root=${project.root}`);
  return 0;
}

export const PROJECT_HEADERS = ['id', 'name', 'root', 'repos'];

export function projectRows(projects: Project[]): string[][] {
  return projects.map((p) => [
    p.id,
    `${p.name}${p.archived ? ' (archived)' : ''}`,
    p.root,
    p.repos.length > 0 ? p.repos.join(',') : '-',
  ]);
}

export async function runProjectList(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const { projects } = await callRpc<{ projects: Project[] }>(socketPath, 'project.list', {
    include_archived: hasFlag(args.options, 'all'),
  });
  if (json) {
    printJson(projects);
    return 0;
  }
  if (projects.length === 0) {
    console.log('projects: (none)');
    return 0;
  }
  printTable(PROJECT_HEADERS, projectRows(projects));
  return 0;
}

export function projectFields(p: Project): Array<[string, string]> {
  const session = p.session
    ? [p.session.vendor, p.session.model, p.session.effort].map((v) => v ?? '-').join('/')
    : '-';
  const delivery = p.delivery
    ? `${p.delivery.mode ?? '-'}${p.delivery.auto_merge === undefined ? '' : ` auto_merge=${p.delivery.auto_merge}`}`
    : '-';
  return [
    ['id', p.id],
    ['name', p.name],
    ['root', p.root],
    ['repos', p.repos.length > 0 ? p.repos.join(', ') : '-'],
    ['session', session],
    ['delivery', delivery],
    ['autonomy', `coordinator=${p.autonomy.coordinator} director=${p.autonomy.director}`],
    ['tracker', p.tracker ? p.tracker.system : '-'],
    ['archived', p.archived ? 'yes' : 'no'],
    ['created_at', p.created_at],
  ];
}

export async function runProjectShow(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'project-id');
  const project = await callRpc<Project>(socketPath, 'project.get', { id });
  if (json) printJson(project);
  else printFields(projectFields(project));
  return 0;
}

function onOff(value: string, flag: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`--${flag} must be on or off`);
}

/**
 * `set <id> [--name n] [--repo a,b] [--vendor v] [--model m] [--effort e]
 * [--delivery direct|pr] [--auto-merge on|off] [--coordinator a] [--director a]`.
 * Session and delivery fields merge into what the project already has.
 */
export async function runProjectSet(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'project-id');
  const o = args.options;
  const patch: Record<string, unknown> = {};
  const name = optionalString(o, 'name');
  if (name !== undefined) patch.name = name;
  const repos = optionalList(args, 'repo');
  if (repos !== undefined) patch.repos = repos;

  const session: Record<string, string> = {};
  for (const key of ['vendor', 'model', 'effort']) {
    const value = optionalString(o, key);
    if (value !== undefined) session[key] = value;
  }
  const delivery: Record<string, unknown> = {};
  const mode = optionalString(o, 'delivery');
  if (mode !== undefined) delivery.mode = mode;
  const autoMerge = optionalString(o, 'auto-merge');
  if (autoMerge !== undefined) delivery.auto_merge = onOff(autoMerge, 'auto-merge');
  const autonomy: Record<string, string> = {};
  for (const key of ['coordinator', 'director']) {
    const value = optionalString(o, key);
    if (value !== undefined) autonomy[key] = value;
  }

  if (Object.keys(session).length > 0 || Object.keys(delivery).length > 0) {
    const before = await callRpc<Project>(socketPath, 'project.get', { id });
    if (Object.keys(session).length > 0) patch.session = { ...before.session, ...session };
    if (Object.keys(delivery).length > 0) patch.delivery = { ...before.delivery, ...delivery };
  }
  if (Object.keys(autonomy).length > 0) patch.autonomy = autonomy;
  if (Object.keys(patch).length === 0) {
    throw new Error('agile project set: nothing to set (see `agile` for the flags)');
  }

  const project = await callRpc<Project>(socketPath, 'project.update', { id, ...patch });
  if (json) printJson(project);
  else console.log(`agile project set: ${project.id}  ${project.name}`);
  return 0;
}
