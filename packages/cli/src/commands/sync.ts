/**
 * `agile sync jira link <PROJECT> | unlink | status` — a thin client over the
 * daemon's `sync.jira_*` RPC methods (T045; `packages/daemon/src/sync/`).
 *
 * The CLI never sees a credential: the base URL and the `JIRA_EMAIL` /
 * `JIRA_API_TOKEN` pair are read by the daemon from the operator's own
 * environment, so the only thing that travels over the socket is a project
 * key. A daemon with Jira unconfigured has no `sync.*` methods at all — the
 * RPC error says so, and the hint below points at the environment.
 */

import type { ParsedArgs } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

interface JiraSyncStatusResult {
  linked: boolean;
  project?: string;
  source?: 'config' | 'env';
  cursor?: string;
  mapped: number;
}

export function syncUsage(): string {
  return [
    'usage: agile sync jira <link <PROJECT> | unlink | status>',
    '',
    'The linked project key is stored in agile.config.yaml (jira.project).',
    'Credentials come from the environment (JIRA_BASE_URL, JIRA_EMAIL,',
    'JIRA_API_TOKEN) and are never written to any file.',
  ].join('\n');
}

export async function runSync(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const [target, action, ...rest] = args.positionals;
  if (target !== 'jira') {
    console.error(syncUsage());
    return 1;
  }

  if (action === 'status' || action === undefined) {
    const result = await callRpc<JiraSyncStatusResult>(socketPath, 'sync.jira_status', {});
    if (json) printJson(result);
    else
      printFields([
        ['linked', String(result.linked)],
        ['project', result.project ?? '-'],
        ['source', result.source ?? '-'],
        ['synced through', result.cursor ?? '-'],
        ['mapped tickets', String(result.mapped)],
      ]);
    return 0;
  }

  if (action === 'link') {
    const project =
      rest[0] ?? (typeof args.options.project === 'string' ? args.options.project : undefined);
    if (!project) {
      console.error('usage: agile sync jira link <PROJECT>');
      return 1;
    }
    const link = await callRpc<JiraSyncStatusResult>(socketPath, 'sync.jira_link', { project });
    if (json) printJson(link);
    else
      printFields([
        ['linked', link.project ?? project],
        ['mapped tickets', String(link.mapped)],
      ]);
    return 0;
  }

  if (action === 'unlink') {
    const result = await callRpc<{ unlinked: boolean; project?: string; note?: string }>(
      socketPath,
      'sync.jira_unlink',
      {},
    );
    if (json) printJson(result);
    else {
      console.log(result.unlinked ? `unlinked: ${result.project}` : 'no jira project was linked');
      if (result.note) console.log(result.note);
    }
    return 0;
  }

  console.error(syncUsage());
  return 1;
}
