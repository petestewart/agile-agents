/**
 * Filesystem primitives for the state store (T005 — see design
 * agile-agents-design.md §4 "State model", §5 "Storage").
 *
 * Every mutation goes through `atomicWriteFile`: write to a sibling temp
 * file, then `rename` over the target. A rename within the same directory
 * is atomic on POSIX filesystems, so a reader never observes a
 * partially-written file, and a crash mid-write leaves the previous file
 * (or no file) intact rather than a truncated one. Callers are expected to
 * validate the data with a shared zod schema *before* calling this — that
 * ordering is what "a failing validation leaves the previous file intact"
 * (T005 test plan) actually requires; this module has no opinion on schemas.
 *
 * Durability note (review nit, not fixed): the header above claims
 * *atomicity*, not durability — there is no `fsync` on the temp file or the
 * containing directory after `rename`, so a hard power loss (not a process
 * crash) could still lose the write or, on some filesystems, leave stale
 * metadata. Out of scope for T005's fix pass; flagged in the report.
 *
 * Temp-file naming (review B4 fix): the temp name is
 * `.<basename>.tmp-<ts>-<rand>` — a leading dot (hidden) plus a suffix that
 * never ends in the entity's own extension, so a crash-orphaned temp file
 * for `tickets/TKT-0001.yaml` is named `.TKT-0001.yaml.tmp-<ts>-<rand>`,
 * which does not end in `.yaml` and is not picked up by an
 * extension-filtered directory listing. `listDataFiles` below is the one
 * place every store `listX` should filter through (extension match, no
 * leading dot, no `.tmp-` — belt-and-braces on top of the naming fix), and
 * `sweepStaleTempFiles` gives `StateStore.open` a way to clean up anything
 * still orphaned from before this fix (or a still-more-unlucky crash
 * between the rename's temp-file write and the rename itself).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

const TEMP_FILE_MARKER = '.tmp-';

function tempFileName(targetPath: string): string {
  const rand = Math.random().toString(36).slice(2);
  return `.${basename(targetPath)}${TEMP_FILE_MARKER}${Date.now()}-${rand}`;
}

/** True for a hidden file or a leftover atomic-write temp file — never a real entity file. */
export function isHiddenOrTempFile(name: string): boolean {
  return name.startsWith('.') || name.includes(TEMP_FILE_MARKER);
}

/** Writes `content` to `path` atomically (temp file + rename), creating parent dirs. */
export function atomicWriteFile(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmpPath = join(dirname(path), tempFileName(path));
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

export function readYamlFile<T = unknown>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

export function writeYamlFileAtomic(path: string, data: unknown): void {
  atomicWriteFile(path, stringifyYaml(data));
}

export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFileAtomic(path: string, data: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Appends one JSON value as a line to a JSONL file, creating it (and parent
 * dirs) if missing. Single-daemon-process assumption (see store.ts's
 * mutex): appends are serialized in-process, so a plain `appendFileSync`
 * needs no temp-file dance — there is never a concurrent writer to race.
 */
export function appendJsonlLine(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

/** Reads every non-empty line of a JSONL file as JSON. Missing file → []. */
export function readJsonlFile<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Every filename in `dirPath` ending in `extension`, excluding hidden files
 * and atomic-write temp files (see `isHiddenOrTempFile`) — the one place
 * every store `listX` reader filters a directory, so a crash-orphaned temp
 * file (or a stray `.gitkeep`) never gets parsed as an entity (review B4).
 */
export function listDataFiles(dirPath: string, extension: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath).filter(
    (name) => name.endsWith(extension) && !isHiddenOrTempFile(name),
  );
}

/**
 * Recursively removes any leftover atomic-write temp file under `root`
 * (review B4: "StateStore.open sweeps stale temp files"). Returns the
 * absolute paths removed, for logging/tests.
 */
export function sweepStaleTempFiles(root: string): string[] {
  const removed: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.startsWith('.') && entry.name.includes(TEMP_FILE_MARKER)) {
        unlinkSync(full);
        removed.push(full);
      }
    }
  };
  walk(root);
  return removed;
}
