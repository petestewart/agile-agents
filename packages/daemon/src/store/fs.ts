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
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/** Writes `content` to `path` atomically (temp file + rename), creating parent dirs. */
export function atomicWriteFile(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmpPath = join(
    dirname(path),
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.split('/').pop()}`,
  );
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
