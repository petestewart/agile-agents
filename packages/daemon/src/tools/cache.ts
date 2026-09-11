/**
 * Tool result cache — "cache by content hash so a file is summarized once
 * per sprint, not once per agent" (§7 "Tool framework").
 *
 * Decision (manager, T011 session): cache files are host-local, not
 * `.agile/` git-tracked state — they're a pure performance optimization with
 * no audit value, and re-committing them on every tool call would be exactly
 * the "two commits per hot-ish call" problem T009 already fixed for hooks.
 * Filed under `<repoRoot>/.agile-daemon-cache/`, the same host-local
 * convention as `.agile-daemon.lock`/`.agile-daemon.sock` (T004) — gitignored
 * alongside them, never committed to `agile-state`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAEMON_CACHE_DIR } from '../subprocess-env';

/**
 * Sibling precedent: `.agile-daemon.lock`, `.agile-daemon.sock` (T004).
 * T034 round 2 (review): re-exported from `../subprocess-env` rather than
 * defined again here — this file and `subprocess-env.ts` used to each
 * define their own identical `'.agile-daemon-cache'` string constant.
 */
export const CACHE_DIR_NAME = DAEMON_CACHE_DIR;

export function toolCacheRoot(repoRoot: string): string {
  return join(repoRoot, CACHE_DIR_NAME, 'tools');
}

/** `sha256` over the given parts, joined with a `\n` separator (never itself a legal part — every caller's parts are single-line strings/hashes/JSON) so `['a', 'b']` and `['ab']` never collide. */
export function cacheKey(parts: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(parts.join('\n'));
  return hash.digest('hex');
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * `<repoRoot>/.agile-daemon-cache/tools/<toolName>/<sprint|nosprint>/<key>.json`
 * — "cache ... ttl: sprint" (§7): scoping the cache under the current sprint
 * id (or the literal `nosprint` when none is set, e.g. before the first
 * sprint exists) means a new sprint starts with a cold cache without this
 * module needing its own expiry/eviction logic.
 */
export function cacheEntryPath(
  repoRoot: string,
  toolName: string,
  sprintId: string | undefined,
  key: string,
): string {
  return join(toolCacheRoot(repoRoot), toolName, sprintId ?? 'nosprint', `${key}.json`);
}

export function readCacheEntry<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A corrupted/partial cache file is treated as a miss, never a crash.
    return undefined;
  }
}

export function writeCacheEntry(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/** For raw tool output that isn't itself cache data (`test_run`'s full log) — same host-local root, a different subtree so a cache sweep can't confuse the two. */
export function rawOutputPath(repoRoot: string, toolName: string, fileName: string): string {
  return join(repoRoot, CACHE_DIR_NAME, 'raw', toolName, fileName);
}

export function writeRawOutput(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
