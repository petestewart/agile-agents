import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type JsonlLine,
  appendJsonlLine,
  atomicWriteFile,
  ensureDir,
  fileExists,
  forEachJsonlLine,
  isHiddenOrTempFile,
  lineNumberAt,
  listDataFiles,
  readJsonFile,
  readJsonlTail,
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

  // T167 review: a secret (the classifier key in config.yaml) must never sit
  // at its final path with looser permissions, so the mode is set on the
  // temp file before the rename — including when replacing a 0644 file.
  test('mode is applied before the rename, even over an existing looser file', () => {
    const path = join(dir, 'config.yaml');
    atomicWriteFile(path, 'a: 1\n');
    atomicWriteFile(path, 'secret: x\n', 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

  test('is sorted with numeric collation, whatever order the filesystem returns', () => {
    // CI (ext4) returned `b.yaml` before `a.yaml`, so a caller taking the
    // first entry got the wrong file; APFS/tmpfs happened to return them sorted.
    for (const name of ['S-10.yaml', 'S-2.yaml', 'S-1.yaml', 'S-3.yaml']) {
      writeFileSync(join(dir, name), '');
    }
    expect(listDataFiles(dir, '.yaml')).toEqual(['S-1.yaml', 'S-2.yaml', 'S-3.yaml', 'S-10.yaml']);
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
  const read = (path: string, options?: { endOffset?: number; mark?: string }): unknown[] => {
    const out: unknown[] = [];
    forEachJsonlLine(path, (line) => out.push(JSON.parse(line.text)), options);
    return out;
  };

  test('appendJsonlLine appends newline-delimited JSON, in order', () => {
    const path = join(dir, 'log.jsonl');
    appendJsonlLine(path, { n: 1 });
    appendJsonlLine(path, { n: 2 });
    appendJsonlLine(path, { n: 3 });
    expect(read(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test('a missing file has no lines', () => {
    expect(read(join(dir, 'missing.jsonl'))).toEqual([]);
    expect(readJsonlTail(join(dir, 'missing.jsonl'), 5)).toEqual({ lines: [], start: 0 });
  });

  test('blank lines are skipped', () => {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, '{"n":1}\n\n{"n":2}\n');
    expect(read(path)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

/**
 * T551: the chunked readers against a plain split of the whole file. The
 * reference keeps every non-empty line, trimmed, with the byte it starts at;
 * with `endOffset`, only lines whose newline falls before it.
 */
function referenceLines(bytes: Buffer, endOffset?: number): JsonlLine[] {
  const end = endOffset === undefined ? bytes.length : Math.min(endOffset, bytes.length);
  const stopAt = endOffset === undefined || end === 0 ? end : bytes.lastIndexOf(0x0a, end - 1) + 1;
  const out: JsonlLine[] = [];
  let start = 0;
  while (start < stopAt) {
    let newline = bytes.indexOf(0x0a, start);
    if (newline < 0 || newline >= stopAt) newline = stopAt;
    const text = bytes.toString('utf8', start, newline).trim();
    if (text.length > 0) out.push({ text, offset: start });
    start = newline + 1;
  }
  return out;
}

describe('T551: the event log read in chunks, forwards and from its tail', () => {
  const CHUNK = 256 * 1024;
  const forward = (path: string, options?: { endOffset?: number; mark?: string }) => {
    const out: JsonlLine[] = [];
    forEachJsonlLine(path, (line) => out.push(line), options);
    return out;
  };

  /** Lines of every awkward shape: longer than a chunk, multi-byte, CRLF, blank, no trailing newline. */
  function awkwardLog(seed: number, trailingNewline: boolean): Buffer {
    // mulberry32: a seeded generator, so a failure reproduces.
    let state = seed;
    const rand = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      const shape = rand(30);
      if (shape === 0) lines.push('');
      else if (shape === 1) lines.push(JSON.stringify({ i, big: 'x'.repeat(CHUNK + rand(CHUNK)) }));
      else if (shape === 2) lines.push(`${JSON.stringify({ i, crlf: true })}\r`);
      else
        lines.push(
          JSON.stringify({ i, kind: rand(3) === 0 ? 'mark' : 'other', s: 'é✓𝄞'.repeat(rand(400)) }),
        );
    }
    return Buffer.from(lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
  }

  test("the tail is the full read's newest lines, for any limit and end offset", () => {
    const path = join(dir, 'events.jsonl');
    for (const [seed, trailing] of [
      [1, true],
      [2, false],
      [3, true],
    ] as const) {
      const bytes = awkwardLog(seed, trailing);
      writeFileSync(path, bytes);
      expect(bytes.length).toBeGreaterThan(4 * CHUNK);
      // Ends at the file's end, at a line's newline, mid-line, mid-character, and nowhere.
      const nearCharSplit = bytes.indexOf(Buffer.from('𝄞')) + 2;
      for (const endOffset of [
        undefined,
        bytes.length,
        bytes.length - 1,
        bytes.indexOf(0x0a, CHUNK * 2) + 1,
        bytes.indexOf(0x0a, CHUNK * 2),
        nearCharSplit,
        CHUNK,
        0,
      ]) {
        const all = referenceLines(bytes, endOffset);
        expect(forward(path, { endOffset })).toEqual(all);
        for (const limit of [0, 1, 7, 150, 10_000]) {
          const tail = readJsonlTail(path, limit, endOffset);
          expect(tail.lines).toEqual(limit === 0 ? [] : all.slice(-limit));
        }
      }
    }
  });

  test('a multi-byte character across a chunk boundary, either way, decodes whole', () => {
    const path = join(dir, 'events.jsonl');
    // A run of 4-byte characters across both the forward boundary (CHUNK) and
    // the backward one (size - CHUNK), each falling inside a character.
    const long = JSON.stringify({ s: '𝄞'.repeat(CHUNK / 2) });
    writeFileSync(path, `\n${long}\n{"n":2}\n`);
    const size = statSync(path).size;
    const first = 1 + Buffer.from(long).indexOf(Buffer.from('𝄞'));
    expect((CHUNK - first) % 4).not.toBe(0);
    expect((size - CHUNK - first) % 4).not.toBe(0);
    expect(forward(path).map((l) => l.text)).toEqual([long, '{"n":2}']);
    expect(readJsonlTail(path, 2).lines).toEqual([
      { text: long, offset: 1 },
      { text: '{"n":2}', offset: 2 + Buffer.byteLength(long) },
    ]);
  });

  test('a partial last line at the end offset is left out; without one, the last line counts', () => {
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3');
    const size = statSync(path).size;
    const texts = (lines: JsonlLine[]) => lines.map((l) => l.text);
    expect(texts(readJsonlTail(path, 5, size).lines)).toEqual(['{"n":1}', '{"n":2}']);
    expect(texts(forward(path, { endOffset: size }))).toEqual(['{"n":1}', '{"n":2}']);
    expect(texts(readJsonlTail(path, 5).lines)).toEqual(['{"n":1}', '{"n":2}', '{"n":3']);
    expect(texts(forward(path))).toEqual(['{"n":1}', '{"n":2}', '{"n":3']);
    // A single unterminated line, and an empty file.
    writeFileSync(path, '{"n":1}');
    expect(readJsonlTail(path, 5, 7).lines).toEqual([]);
    expect(readJsonlTail(path, 5).lines).toEqual([{ text: '{"n":1}', offset: 0 }]);
    writeFileSync(path, '');
    expect(readJsonlTail(path, 5)).toEqual({ lines: [], start: 0 });
    expect(forward(path)).toEqual([]);
  });

  test('a tail read covers a bounded number of bytes however long the log is', () => {
    const path = join(dir, 'events.jsonl');
    const line = `${JSON.stringify({ kind: 'tool_call', data: { title: 'bun test packages/daemon' } })}\n`;
    writeFileSync(path, line.repeat(Math.ceil((16 * 1024 * 1024) / line.length)));
    const size = statSync(path).size;
    const tail = readJsonlTail(path, 200, size);
    expect(tail.lines).toHaveLength(200);
    // One chunk holds 200 short lines: the other 16 MB are never read.
    expect(size - tail.start).toBeLessThanOrEqual(CHUNK);
    expect(tail.lines[0]?.offset).toBe(size - 200 * line.length);
  });

  test('with a mark, only the lines carrying it are decoded', () => {
    const path = join(dir, 'events.jsonl');
    const bytes = awkwardLog(4, true);
    // A corrupt line without the mark is never parsed.
    writeFileSync(path, Buffer.concat([Buffer.from('not json at all\n'), bytes]));
    const marked = forward(path, { mark: '"kind":"mark"' });
    const expected = referenceLines(
      Buffer.concat([Buffer.from('not json at all\n'), bytes]),
    ).filter((l) => l.text.includes('"kind":"mark"'));
    expect(marked.length).toBeGreaterThan(10);
    expect(marked).toEqual(expected);
  });

  test('lineNumberAt counts the newlines before an offset, across chunks', () => {
    const path = join(dir, 'events.jsonl');
    const bytes = awkwardLog(5, true);
    writeFileSync(path, bytes);
    const all = referenceLines(bytes);
    for (const line of [all[0], all[Math.floor(all.length / 2)], all.at(-1)]) {
      if (line === undefined) throw new Error('no line');
      const expected = bytes.subarray(0, line.offset).toString('utf8').split('\n').length;
      expect(lineNumberAt(path, line.offset)).toBe(expected);
    }
    expect(lineNumberAt(path, 0)).toBe(1);
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
