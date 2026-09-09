import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonlLine,
  atomicWriteFile,
  ensureDir,
  fileExists,
  isHiddenOrTempFile,
  listDataFiles,
  readJsonFile,
  readJsonlFile,
  readYamlFile,
  removeFile,
  sweepStaleTempFiles,
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

  // Review B4: the temp name must not end in the entity's own extension,
  // so a crash-orphaned temp file is never mistaken for a real entity by
  // an extension-filtered directory listing. (No leftover file at all on
  // success, matching "leaves no temp file behind" above, but for a
  // `.yaml`-suffixed path specifically.)
  test('succeeding write leaves only the target .yaml file, no temp remnant', () => {
    const path = join(dir, 'TKT-0001.yaml');
    atomicWriteFile(path, 'status: draft\n');
    expect(readdirSync(dir)).toEqual(['TKT-0001.yaml']);
  });
});

describe('isHiddenOrTempFile', () => {
  test('true for a leftover atomic-write temp file', () => {
    expect(isHiddenOrTempFile('.TKT-0001.yaml.tmp-1700000000000-abc123')).toBe(true);
  });

  test('true for a plain hidden file', () => {
    expect(isHiddenOrTempFile('.gitkeep')).toBe(true);
  });

  test('false for a real entity file', () => {
    expect(isHiddenOrTempFile('TKT-0001.yaml')).toBe(false);
  });
});

describe('listDataFiles', () => {
  test('returns only real entity files, skipping hidden/temp ones', () => {
    writeFileSync(join(dir, 'TKT-0001.yaml'), '');
    writeFileSync(join(dir, 'TKT-0002.yaml'), '');
    writeFileSync(join(dir, '.TKT-0003.yaml.tmp-123-abc'), ''); // crash-orphaned temp
    writeFileSync(join(dir, '.gitkeep'), '');
    writeFileSync(join(dir, 'README.md'), '');

    expect(listDataFiles(dir, '.yaml').sort()).toEqual(['TKT-0001.yaml', 'TKT-0002.yaml']);
  });

  test('returns [] for a missing directory', () => {
    expect(listDataFiles(join(dir, 'nope'), '.yaml')).toEqual([]);
  });
});

describe('sweepStaleTempFiles', () => {
  test('removes leftover temp files recursively, leaves everything else', () => {
    writeFileSync(join(dir, 'a.yaml'), 'kept');
    ensureDir(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.yaml'), 'kept');
    writeFileSync(join(dir, '.a.yaml.tmp-1-x'), 'stale');
    writeFileSync(join(dir, 'sub', '.b.yaml.tmp-2-y'), 'stale');

    const removed = sweepStaleTempFiles(dir);

    expect(removed.sort()).toEqual(
      [join(dir, '.a.yaml.tmp-1-x'), join(dir, 'sub', '.b.yaml.tmp-2-y')].sort(),
    );
    expect(existsSync(join(dir, 'a.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'sub', 'b.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.a.yaml.tmp-1-x'))).toBe(false);
    expect(existsSync(join(dir, 'sub', '.b.yaml.tmp-2-y'))).toBe(false);
  });

  test('a leftover temp file does not break listDataFiles (B4 regression)', () => {
    writeFileSync(join(dir, 'TKT-0001.yaml'), 'status: draft\n');
    writeFileSync(join(dir, '.TKT-0002.yaml.tmp-999-zzz'), 'garbage, not valid yaml: [');

    expect(listDataFiles(dir, '.yaml')).toEqual(['TKT-0001.yaml']);
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
