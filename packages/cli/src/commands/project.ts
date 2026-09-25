/**
 * `agile project new|list|show|set` (T200) — the CLI over the daemon's
 * `project.*` RPC (projects-design §14.1). Thin, like `stream.ts`: parse
 * argv, call one method, print human or `--json`. `--repo` repeats and/or
 * takes a comma-separated list of names from `repos.yaml`.
 */

import type { Project, TrackerSettings } from '@agile-agents/shared';
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
    ['tracker', p.tracker ? trackerSummary(p.tracker) : '-'],
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

function trackerSummary(t: TrackerSettings): string {
  const map = Object.entries(t.status_map ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${t.system} push_status=${t.push_status ? 'on' : 'off'}${map ? ` status_map=${map}` : ''}`;
}

const TRACKER_SYSTEMS = ['jira', 'linear', 'none'] as const;
const STATUS_MAP_KEYS = ['in_progress', 'in_review', 'done'] as const;

/** The tracker flags of `project set`, parsed but not yet merged. `null` in `status_map` clears that key. */
export interface TrackerFlags {
  system?: (typeof TRACKER_SYSTEMS)[number];
  push_status?: boolean;
  status_map?: Record<string, string | null>;
}

/**
 * T327: `--tracker jira|linear|none`, `--push-status on|off` and
 * `--status-map in_progress=<Name>,in_review=<Name>,done=<Name>` (repeatable;
 * names may hold spaces; `key=` clears one). Undefined when none is given.
 */
export function parseTrackerFlags(args: ParsedArgs): TrackerFlags | undefined {
  const flags: TrackerFlags = {};
  const system = optionalString(args.options, 'tracker');
  if (system !== undefined) {
    if (!(TRACKER_SYSTEMS as readonly string[]).includes(system)) {
      throw new Error('--tracker must be jira, linear or none');
    }
    flags.system = system as TrackerFlags['system'];
  }
  const push = optionalString(args.options, 'push-status');
  if (push !== undefined) flags.push_status = onOff(push, 'push-status');
  const entries = optionalList(args, 'status-map');
  if (entries !== undefined) {
    const map: Record<string, string | null> = {};
    for (const entry of entries) {
      const eq = entry.indexOf('=');
      const key = eq < 0 ? entry : entry.slice(0, eq).trim();
      if (eq < 0 || !(STATUS_MAP_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `--status-map takes ${STATUS_MAP_KEYS.map((k) => `${k}=<Name>`).join(',')}`,
        );
      }
      const name = entry.slice(eq + 1).trim();
      map[key] = name.length > 0 ? name : null;
    }
    flags.status_map = map;
  }
  for (const flag of ['tracker', 'push-status', 'status-map']) {
    if (args.options[flag] === true) throw new Error(`--${flag} needs a value`);
  }
  if (Object.keys(flags).length === 0) return undefined;
  if (flags.system === 'none' && Object.keys(flags).length > 1) {
    throw new Error('--tracker none clears the tracker; it takes no --push-status or --status-map');
  }
  return flags;
}

/**
 * The project's next tracker block: `null` removes it. Fields merge into the
 * current block; switching system starts a fresh block (status names and
 * `base_url` belong to one system).
 */
export function mergeTracker(
  before: TrackerSettings | undefined,
  flags: TrackerFlags,
): TrackerSettings | null {
  if (flags.system === 'none') return null;
  const system = flags.system ?? before?.system;
  if (system === undefined) {
    throw new Error('the project has no tracker: pass --tracker jira|linear as well');
  }
  const { status_map: beforeMap, ...base } =
    before !== undefined && before.system === system ? before : { system, push_status: false };
  const map: Record<string, string> = {};
  for (const [key, name] of Object.entries({ ...beforeMap, ...flags.status_map })) {
    if (name) map[key] = name;
  }
  return {
    ...base,
    system,
    push_status: flags.push_status ?? base.push_status,
    ...(Object.keys(map).length > 0 ? { status_map: map } : {}),
  };
}

/**
 * `set <id> [--name n] [--repo a,b] [--vendor v] [--model m] [--effort e]
 * [--delivery direct|pr] [--auto-merge on|off] [--coordinator-autonomy a] [--director-autonomy a]
 * [--tracker jira|linear|none] [--push-status on|off] [--status-map k=Name,…]`.
 * Session, delivery and tracker fields merge into what the project already has.
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
    // T282: `--coordinator-autonomy`; the bare `--coordinator` stays as an alias.
    const value = optionalString(o, `${key}-autonomy`) ?? optionalString(o, key);
    if (value !== undefined) autonomy[key] = value;
  }

  const tracker = parseTrackerFlags(args);

  if (Object.keys(session).length > 0 || Object.keys(delivery).length > 0 || tracker) {
    const before = await callRpc<Project>(socketPath, 'project.get', { id });
    if (Object.keys(session).length > 0) patch.session = { ...before.session, ...session };
    if (Object.keys(delivery).length > 0) patch.delivery = { ...before.delivery, ...delivery };
    if (tracker) patch.tracker = mergeTracker(before.tracker, tracker);
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
