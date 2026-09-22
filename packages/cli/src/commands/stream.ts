/**
 * `agile stream new|list|show|close|say` (T120) — the CLI over the daemon's
 * `stream.*` RPC (cockpit design §2). Thin, like `repo.ts`: parse argv,
 * call one method, print human or `--json`.
 *
 * Every write here is the human's: the daemon stamps the `human` principal
 * at the RPC edge and never accepts one from params (§2.2), so there is no
 * `--as` flag and never will be one on this path.
 */

import type { Stream, ThreadEntry } from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { hasFlag, optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';
import { formatSession } from './attach';

export interface StreamNode {
  stream: Stream;
  children: StreamNode[];
}

interface ThreadPage {
  entries: ThreadEntry[];
  from: number;
  total: number;
  next?: number;
}

/** `agent/human` status pair — the two halves the UI colours a dot from (§2.2). */
function statusPair(stream: Stream): string {
  return `${stream.agent.status}/${stream.human.status}${stream.archived ? ' (archived)' : ''}`;
}

export async function runStreamNew(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const title = requireOption(args.options, 'title');
  const goal = requireOption(args.options, 'goal');
  const parent = optionalString(args.options, 'parent');
  const repo = optionalString(args.options, 'repo');
  const targetBranch = optionalString(args.options, 'target-branch');

  const stream = await callRpc<Stream>(socketPath, 'stream.create', {
    title,
    goal,
    ...(parent !== undefined ? { parent } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(targetBranch !== undefined ? { target_branch: targetBranch } : {}),
  });

  if (json) printJson(stream);
  else console.log(`agile stream new: ${stream.id}  ${stream.title}`);
  return 0;
}

/**
 * Flattens the tree into `id title agent/human` rows, the indentation
 * carried in the id cell so the table still reads as a tree (T128).
 */
export function streamRows(nodes: StreamNode[], depth = 0): string[][] {
  const rows: string[][] = [];
  for (const node of nodes) {
    rows.push([
      `${'  '.repeat(depth)}${node.stream.id}`,
      node.stream.title,
      statusPair(node.stream),
    ]);
    rows.push(...streamRows(node.children, depth + 1));
  }
  return rows;
}

/** The header the tree and `agile status`'s stream block share (T128). */
export const STREAM_HEADERS = ['id', 'title', 'agent/human'];

/** `--all` includes archived streams (hidden by default, §7.2). */
export async function runStreamList(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const includeArchived = hasFlag(args.options, 'all');
  const result = await callRpc<{ tree: StreamNode[] }>(socketPath, 'stream.list', {
    ...(includeArchived ? { include_archived: true } : {}),
  });
  if (json) {
    printJson(result);
    return 0;
  }
  if (result.tree.length === 0) {
    console.log('streams: (none)');
    return 0;
  }
  printTable(STREAM_HEADERS, streamRows(result.tree));
  return 0;
}

const SHOW_THREAD_LINES = 20;

/**
 * The `stream show` field block. A repo-less stream can never gain a branch
 * or a worktree, so it prints `repo -` and nothing else git-shaped (T128);
 * with a repo, all three lines stay, placeholders and all.
 */
export function showFields(stream: Stream): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['id', stream.id],
    ['title', stream.title],
    ['goal', stream.goal],
    ['status', statusPair(stream)],
    ['parent', stream.parent ?? '-'],
  ];
  if (stream.repo === undefined) {
    fields.push(['repo', '-']);
  } else {
    fields.push(
      ['repo', stream.repo],
      ['branch', stream.branch ?? '- (created on first attach)'],
      ['worktree', stream.worktree ?? '- (created on first attach)'],
    );
  }
  fields.push(['created_at', stream.created_at]);
  return fields;
}

/**
 * One thread entry as printed lines (T137). A multi-line body is one
 * entry, not one entry per line: the header line carries the metadata and
 * the body's first line, and every continuation line is indented under it.
 * The live run printed a two-line agent message as two headerless-looking
 * rows, which read as two separate events.
 */
export function formatThreadEntry(entry: ThreadEntry): string[] {
  const [first = '', ...rest] = entry.body.split('\n');
  const head = `  ${entry.ts}  ${entry.by}  ${entry.kind}  ${first}${
    entry.ref ? `  [${entry.ref}]` : ''
  }`;
  return [head, ...rest.map((line) => `${THREAD_CONTINUATION_INDENT}${line}`)];
}

/** How far a continuation line of a thread body is indented under its header line. */
const THREAD_CONTINUATION_INDENT = '    ';

export async function runStreamShow(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'stream-id');
  const stream = await callRpc<Stream>(socketPath, 'stream.get', { id });
  // Read the tail: ask for the total first, then the last N lines.
  const head = await callRpc<ThreadPage>(socketPath, 'stream.thread_read', { id, limit: 1 });
  const after = Math.max(0, head.total - SHOW_THREAD_LINES) - 1;
  const page =
    head.total <= SHOW_THREAD_LINES
      ? await callRpc<ThreadPage>(socketPath, 'stream.thread_read', {
          id,
          limit: SHOW_THREAD_LINES,
        })
      : await callRpc<ThreadPage>(socketPath, 'stream.thread_read', {
          id,
          after,
          limit: SHOW_THREAD_LINES,
        });

  if (json) {
    printJson({ stream, thread: page });
    return 0;
  }

  printFields(showFields(stream));
  console.log('');
  // T130: the sessions strip — `id vendor/model effort status`, one line each.
  console.log(`sessions (${stream.sessions.length}):`);
  for (const session of stream.sessions) console.log(`  ${formatSession(session)}`);
  console.log('');
  console.log(`thread (${page.entries.length} of ${page.total}):`);
  if (page.entries.length === 0) console.log('  (empty)');
  for (const entry of page.entries) {
    for (const line of formatThreadEntry(entry)) console.log(line);
  }
  return 0;
}

export async function runStreamClose(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'stream-id');
  const note = optionalString(args.options, 'note');
  const stream = await callRpc<Stream>(socketPath, 'stream.close', {
    id,
    ...(note !== undefined ? { note } : {}),
  });
  if (json) printJson(stream);
  else console.log(`agile stream close: ${stream.id} is ${stream.human.status}`);
  return 0;
}

export async function runStreamArchive(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'stream-id');
  const stream = await callRpc<Stream>(socketPath, 'stream.archive', { id });
  if (json) printJson(stream);
  else console.log(`agile stream archive: ${stream.id} archived`);
  return 0;
}

/** `agile stream say <id> <text>` — one human `line` on the thread. */
export async function runStreamSay(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'stream-id');
  // Everything after the id is the text, so an unquoted sentence works.
  const text = args.positionals.slice(1).join(' ').trim();
  if (text.length === 0) throw new Error('agile stream say: <text> is required');
  const entry = await callRpc<ThreadEntry>(socketPath, 'stream.thread_append', {
    id,
    kind: 'line',
    body: text,
  });
  if (json) printJson(entry);
  else console.log(`agile stream say: appended to ${id}`);
  return 0;
}
