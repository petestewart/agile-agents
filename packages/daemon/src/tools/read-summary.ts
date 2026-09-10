/**
 * `read_summary` (§7 "Tool framework": "Ship read_summary (path, question →
 * ≤400-token summary + line refs)"). Generic over any `runner.tier` reader
 * tool whose `cache.key` names `file_hash`/`question` — `read_summary` is the
 * one T011 seeds, but this module doesn't hard-code its name.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isPathInside } from '../permissions/command';
import { DAEMON_CACHE_DIR } from '../subprocess-env';
import { cacheEntryPath, cacheKey, readCacheEntry, sha256Hex, writeCacheEntry } from './cache';
import { charsPerToken } from './runner';
import type { LoadedTool, ToolCallContext, ToolRunner } from './types';

export interface ReadSummaryInput {
  path: string;
  question?: string;
}

export interface ReadSummaryRef {
  path: string;
  lines: string;
}

export interface ReadSummaryOutput {
  summary: string;
  refs: ReadSummaryRef[];
}

export class ReadSummaryError extends Error {}

const MAX_SUMMARY_TOKENS_DEFAULT = 400;

/**
 * Resolves `path` against `worktree` and refuses anything that escapes it —
 * same containment contract as every other worktree-scoped tool in this
 * package — with one deliberate second root: the daemon's own raw-output
 * tree (`<repoRoot>/.agile-daemon-cache/raw/`). `diff_summary` and
 * `test_run` hand out pointers into it ("raw output to files with pointers",
 * CLAUDE.md), and on the first live run every reviewer did the obvious thing
 * with the pointer — `read_summary` on it — and was refused. A relative path
 * is tried under the worktree first, then under the raw root (test_run's
 * pointer is relative to the raw tree).
 */
function resolveInWorktree(path: string, worktree: string, repoRoot: string): string {
  const rawRoot = resolve(repoRoot, DAEMON_CACHE_DIR, 'raw');
  if (isAbsolute(path)) {
    if (isPathInside(path, worktree) || isPathInside(path, rawRoot)) return path;
    throw new ReadSummaryError(`read_summary: path escapes the worktree: ${path}`);
  }
  const inWorktree = resolve(worktree, path);
  if (isPathInside(inWorktree, worktree) && existsSync(inWorktree)) return inWorktree;
  const inRaw = resolve(rawRoot, path);
  if (isPathInside(inRaw, rawRoot) && existsSync(inRaw)) return inRaw;
  if (isPathInside(inWorktree, worktree)) return inWorktree; // missing file: the caller's read reports ENOENT
  throw new ReadSummaryError(`read_summary: path escapes the worktree: ${path}`);
}

/**
 * The runner's reply is expected to be a JSON object `{summary, refs}` (see
 * the seeded `prompt.md`). A reply that isn't valid JSON, or is JSON but
 * missing `summary`, falls back to treating the whole reply text as the
 * summary with no refs — never throws on a malformed model reply, since
 * "the model said something odd" isn't a tool failure.
 */
function parseRunnerReply(text: string, path: string): ReadSummaryOutput {
  try {
    const parsed = JSON.parse(text) as Partial<ReadSummaryOutput>;
    if (typeof parsed.summary === 'string') {
      const refs = Array.isArray(parsed.refs)
        ? parsed.refs.filter(
            (r): r is ReadSummaryRef => typeof r?.path === 'string' && typeof r?.lines === 'string',
          )
        : [];
      return { summary: parsed.summary, refs };
    }
  } catch {
    // Not JSON — fall through to the raw-text fallback below.
  }
  return { summary: text.trim(), refs: [{ path, lines: 'unknown' }] };
}

function truncateSummary(summary: string, maxTokens: number): string {
  const maxChars = maxTokens * charsPerToken();
  return summary.length > maxChars ? summary.slice(0, maxChars) : summary;
}

export interface RunReadSummaryOptions {
  tool: LoadedTool;
  ctx: ToolCallContext;
  input: ReadSummaryInput;
  /** The ticket worktree `path` is resolved against, and the containment boundary. */
  worktree: string;
  /** For the host-local cache path — see `cache.ts`. */
  repoRoot: string;
  /** Cache TTL scope (§7: "ttl: sprint") — `undefined` reads/writes under `nosprint`. */
  sprintId: string | undefined;
  runner: ToolRunner;
}

export interface RunReadSummaryResult {
  output: ReadSummaryOutput;
  cache: 'hit' | 'miss';
  inTokens: number;
  outTokens: number;
  model: string;
}

export async function runReadSummary(opts: RunReadSummaryOptions): Promise<RunReadSummaryResult> {
  const { tool, input } = opts;
  const absPath = resolveInWorktree(input.path, opts.worktree, opts.repoRoot);
  const content = readFileSync(absPath, 'utf8');
  const fileHash = sha256Hex(content);
  const question = input.question ?? '';

  const key = cacheKey([fileHash, question]);
  const cachePath = cacheEntryPath(opts.repoRoot, tool.definition.name, opts.sprintId, key);
  const cached = readCacheEntry<ReadSummaryOutput>(cachePath);
  if (cached) {
    return { output: cached, cache: 'hit', inTokens: 0, outTokens: 0, model: '' };
  }

  const maxTokens = tool.definition.runner.max_output_tokens || MAX_SUMMARY_TOKENS_DEFAULT;
  const result = await opts.runner.run({
    tool: tool.definition,
    prompt: tool.prompt,
    input: { path: input.path, question, content },
    cwd: opts.worktree,
    maxOutputTokens: maxTokens,
  });

  const parsed = parseRunnerReply(result.text, input.path);
  const output: ReadSummaryOutput = {
    summary: truncateSummary(parsed.summary, maxTokens),
    refs: parsed.refs,
  };
  writeCacheEntry(cachePath, output);

  return {
    output,
    cache: 'miss',
    inTokens: result.inTokens,
    outTokens: result.outTokens,
    model: result.model,
  };
}
