/**
 * Filesystem primitives for the state store. Every mutation is atomic
 * (temp file + `rename` in the same directory), so a reader never sees a
 * partial file and a crash leaves the previous one intact. Callers
 * validate before writing. Atomic, not durable: no fsync on the temp file
 * or directory, so a power loss can still lose a write.
 *
 * Temp files are `.<basename>.tmp-<ts>-<rand>`: hidden, and never ending
 * in the entity's extension, so a crash orphan isn't listed.
 * `listDataFiles` is the one listing filter, and `sweepStaleTempFiles`
 * cleans orphans at open.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
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

/**
 * Writes `content` to `path` atomically (temp file + rename), creating parent dirs.
 * `mode` is applied to the temp file at creation, so the final path never exists
 * with looser permissions (e.g. a secret written at 0600).
 */
export function atomicWriteFile(path: string, content: string, mode?: number): void {
  ensureDir(dirname(path));
  const tmpPath = join(dirname(path), tempFileName(path));
  writeFileSync(tmpPath, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmpPath, mode);
  renameSync(tmpPath, path);
}

export function readYamlFile<T = unknown>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

export function writeYamlFileAtomic(path: string, data: unknown, mode?: number): void {
  atomicWriteFile(path, stringifyYaml(data), mode);
}

export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFileAtomic(path: string, data: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Appends one JSON line (one daemon process, appends serialized in
 * process, so no temp file). `{fsync: true}` (§7.4, gate and land events)
 * writes through an fd and fsyncs; everything else stays a cheap
 * page-cache append on the hot path.
 */
export function appendJsonlLine(
  path: string,
  value: unknown,
  options: { fsync?: boolean } = {},
): void {
  ensureDir(dirname(path));
  const line = `${JSON.stringify(value)}\n`;
  if (options.fsync !== true) {
    writeFileSync(path, line, { flag: 'a' });
    return;
  }
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

/** Filenames in `dirPath` ending in `extension`, minus hidden and temp files: the one listing filter. */
export function listDataFiles(dirPath: string, extension: string): string[] {
  if (!existsSync(dirPath)) return [];
  // Sorted numeric-aware: `readdirSync` order differs by filesystem.
  return readdirSync(dirPath)
    .filter((name) => name.endsWith(extension) && !isHiddenOrTempFile(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Removes every leftover temp file under `root`; returns the paths removed. */
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
