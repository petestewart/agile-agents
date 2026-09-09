import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonlLine,
  atomicWriteFile,
  ensureDir,
  fileExists,
  readJsonFile,
  readJsonlFile,
  readYamlFile,
  removeFile,
  writeJsonFileAtomic,
  writeYamlFileAtomic,
} from './fs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-store-fs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  test('creates parent dirs and writes the file', () => {
    const path = join(dir, 'a', 'b', 'c.txt');
    atomicWriteFile(path, 'hello\n');
    expect(readJsonFileRaw(path)).toBe('hello\n');
  });

  test('leaves no temp file behind on success', () => {
    const path = join(dir, 'c.txt');
    atomicWriteFile(path, 'x');
    expect(readdirSync(dir)).toEqual(['c.txt']);
  });

  test('replaces existing content wholesale (rename over target)', () => {
    const path = join(dir, 'c.txt');
    atomicWriteFile(path, 'first');
    atomicWriteFile(path, 'second');
    expect(readJsonFileRaw(path)).toBe('second');
  });
});

describe('yaml round trip', () => {
  test('writeYamlFileAtomic + readYamlFile round-trips', () => {
    const path = join(dir, 'x.yaml');
    writeYamlFileAtomic(path, { a: 1, b: ['x', 'y'] });
    expect(readYamlFile<{ a: number; b: string[] }>(path)).toEqual({ a: 1, b: ['x', 'y'] });
  });
});

describe('json round trip', () => {
  test('writeJsonFileAtomic + readJsonFile round-trips', () => {
    const path = join(dir, 'x.json');
    writeJsonFileAtomic(path, { a: 1 });
    expect(readJsonFile<{ a: number }>(path)).toEqual({ a: 1 });
  });
});

describe('jsonl append/read', () => {
  test('appendJsonlLine appends newline-delimited JSON, in order', () => {
    const path = join(dir, 'log.jsonl');
    appendJsonlLine(path, { n: 1 });
    appendJsonlLine(path, { n: 2 });
    appendJsonlLine(path, { n: 3 });
    expect(readJsonlFile(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('readJsonlFile on a missing file returns []', () => {
    expect(readJsonlFile(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  test('readJsonlFile skips blank lines', () => {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, '{"n":1}\n\n{"n":2}\n');
    expect(readJsonlFile(path)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('fileExists / ensureDir / removeFile', () => {
  test('fileExists', () => {
    const path = join(dir, 'x');
    expect(fileExists(path)).toBe(false);
    writeFileSync(path, '');
    expect(fileExists(path)).toBe(true);
  });

  test('ensureDir creates nested dirs idempotently', () => {
    const nested = join(dir, 'a', 'b', 'c');
    ensureDir(nested);
    ensureDir(nested);
    expect(existsSync(nested)).toBe(true);
  });

  test('removeFile removes an existing file and is a no-op on a missing one', () => {
    const path = join(dir, 'x');
    writeFileSync(path, '');
    removeFile(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removeFile(path)).not.toThrow();
  });
});

function readJsonFileRaw(path: string): string {
  return readFileSync(path, 'utf8');
}
