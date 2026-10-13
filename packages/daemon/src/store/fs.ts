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
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  appendJsonlLines(path, [value], options);
}

/** Appends several JSON lines in one write (and one fsync when asked). */
export function appendJsonlLines(
  path: string,
  values: readonly unknown[],
  options: { fsync?: boolean } = {},
): void {
  ensureDir(dirname(path));
  const line = values.map((value) => `${JSON.stringify(value)}\n`).join('');
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

/** One non-empty line of a JSONL file: its text, trimmed, and the byte it starts at. */
export interface JsonlLine {
  text: string;
  offset: number;
}

/**
 * T551: the chunked JSONL readers' read size. They split on the newline
 * byte, which never occurs inside a multi-byte UTF-8 character, and decode
 * only whole lines, so a chunk boundary never splits a character.
 */
const JSONL_CHUNK_BYTES = 256 * 1024;

/** Fills `length` bytes from `position`, or throws: the log is append-only, so a short read means it shrank. */
function readExactly(fd: number, path: string, length: number, position: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buf, filled, length - filled, position + filled);
    if (read <= 0)
      throw new Error(`${path} shrank while it was read (at byte ${position + filled})`);
    filled += read;
  }
  return buf;
}

/** The end of a JSONL read: `endOffset`, at most the file's size. */
function readEnd(fd: number, endOffset: number | undefined): number {
  const size = fstatSync(fd).size;
  return endOffset === undefined ? size : Math.max(0, Math.min(endOffset, size));
}

/** `buf[start, stop)` as a line, unless it is blank. */
function lineAt(buf: Buffer, base: number, start: number, stop: number): JsonlLine | undefined {
  const text = buf.toString('utf8', start, stop).trim();
  return text.length > 0 ? { text, offset: base + start } : undefined;
}

/**
 * T551: visits each non-empty line of a JSONL file, oldest first, reading it
 * in chunks, so memory holds a chunk and the longest line, never the file.
 * With `mark`, only a line containing it is decoded (a byte search, as
 * `StepIndex` skips lines without its mark): a corrupt line without it is
 * never seen. With `endOffset` (a tailer's seam), the read stops after the
 * last newline at or before it, and a partial line there is left out (the
 * tailer delivers it); without, the file's last line counts even with no
 * newline.
 * Missing file: no visits.
 */
export function forEachJsonlLine(
  path: string,
  visit: (line: JsonlLine) => void,
  options: { endOffset?: number; mark?: string } = {},
): void {
  if (!existsSync(path)) return;
  const mark = options.mark === undefined ? undefined : Buffer.from(options.mark, 'utf8');
  const visitLines = (buf: Buffer, base: number): void => {
    let from = 0;
    while (from < buf.length) {
      let start = from;
      if (mark !== undefined) {
        const hit = buf.indexOf(mark, from);
        if (hit < 0) return;
        start = buf.lastIndexOf(0x0a, hit) + 1;
      }
      const newline = buf.indexOf(0x0a, start);
      const stop = newline < 0 ? buf.length : newline;
      const line = lineAt(buf, base, start, stop);
      if (line !== undefined) visit(line);
      from = stop + 1;
    }
  };
  const fd = openSync(path, 'r');
  try {
    const end = readEnd(fd, options.endOffset);
    // `carry` is the bytes from `pos` with no newline yet: the start of a line.
    let pos = 0;
    let carry: Buffer = Buffer.alloc(0);
    while (pos + carry.length < end) {
      const at = pos + carry.length;
      // Grows with the carry, so a line longer than a chunk is read in O(its length).
      const chunk = readExactly(
        fd,
        path,
        Math.min(Math.max(JSONL_CHUNK_BYTES, carry.length), end - at),
        at,
      );
      const buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const complete = buf.lastIndexOf(0x0a) + 1;
      if (complete > 0) visitLines(buf.subarray(0, complete), pos);
      pos += complete;
      carry = buf.subarray(complete);
    }
    if (options.endOffset === undefined && carry.length > 0) visitLines(carry, pos);
  } finally {
    closeSync(fd);
  }
}

/**
 * T551: the newest `limit` non-empty lines of a JSONL file, oldest first,
 * read backwards from `endOffset` (default the file's end) in chunks, so the
 * bytes read follow the lines kept, not the file's size. The same end rule
 * as `forEachJsonlLine`: with `endOffset`, a partial line there is left out.
 * `start` is the lowest byte read. Missing file: no lines.
 */
export function readJsonlTail(
  path: string,
  limit: number,
  endOffset?: number,
): { lines: JsonlLine[]; start: number } {
  if (!existsSync(path)) return { lines: [], start: 0 };
  const newestFirst: JsonlLine[] = [];
  const fd = openSync(path, 'r');
  try {
    const end = readEnd(fd, endOffset);
    let pos = end;
    // The bytes from `pos` whose line starts further back (no newline before them yet).
    let pending: Buffer = Buffer.alloc(0);
    // `pending` runs to `end`, not to a newline: the last line, possibly partial.
    let atEnd = true;
    const keep = (buf: Buffer, start: number, stop: number, unterminated: boolean): void => {
      // A partial line at the seam waits for the tailer; the file's own last line counts.
      if (unterminated && endOffset !== undefined) return;
      const line = lineAt(buf, pos, start, stop);
      if (line !== undefined) newestFirst.push(line);
    };
    while (newestFirst.length < limit && pos > 0) {
      const length = Math.min(Math.max(JSONL_CHUNK_BYTES, pending.length), pos);
      pos -= length;
      const chunk = readExactly(fd, path, length, pos);
      const buf = pending.length === 0 ? chunk : Buffer.concat([chunk, pending]);
      let stop = buf.length;
      let newline = buf.lastIndexOf(0x0a, stop - 1);
      while (newline >= 0 && newestFirst.length < limit) {
        keep(buf, newline + 1, stop, atEnd);
        atEnd = false;
        stop = newline;
        newline = stop > 0 ? buf.lastIndexOf(0x0a, stop - 1) : -1;
      }
      pending = buf.subarray(0, stop);
      // The file's first line has no newline before it.
      if (pos === 0 && newestFirst.length < limit) keep(pending, 0, pending.length, atEnd);
    }
    return { lines: newestFirst.reverse(), start: pos };
  } finally {
    closeSync(fd);
  }
}

/** T551: the 1-based line number of the line starting at byte `offset`, by counting the newlines before it. */
export function lineNumberAt(path: string, offset: number): number {
  const fd = openSync(path, 'r');
  try {
    let line = 1;
    for (let at = 0; at < offset; at += JSONL_CHUNK_BYTES) {
      const chunk = readExactly(fd, path, Math.min(JSONL_CHUNK_BYTES, offset - at), at);
      for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, i + 1)) line += 1;
    }
    return line;
  } finally {
    closeSync(fd);
  }
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
