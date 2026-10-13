import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PARSE_CACHE_RACY_NS, ParseCache, type ParseCacheStat } from './parse-cache';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-parse-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Doc = { n: number; tags?: string[] };

function validateDoc(raw: unknown): Doc {
  const doc = raw as Doc;
  if (typeof doc?.n !== 'number') throw new Error('n must be a number');
  return { tags: [], ...doc };
}

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** A clock far past every file's ctime, so entries settle at once. */
const later = () => BigInt(Date.now() + 60_000) * 1_000_000n;

function readDoc(cache: ParseCache, path: string): Doc {
  return cache.read(path, validateDoc, (text) => validateDoc(parseYaml(text)));
}

describe('ParseCache (T547)', () => {
  test('an unchanged file is parsed once; a read returns a copy', () => {
    const cache = new ParseCache({ nowNs: later });
    const path = file('a.yaml', 'n: 1\n');
    const first = readDoc(cache, path);
    first.n = 99;
    first.tags?.push('mutated');
    expect(readDoc(cache, path)).toEqual({ n: 1, tags: [] });
    expect(cache.stats()).toEqual({ parses: 1, entries: 1 });
  });

  test('a change to the file is parsed again', () => {
    const cache = new ParseCache();
    const path = file('a.yaml', 'n: 1\n');
    expect(readDoc(cache, path).n).toBe(1);
    writeFileSync(path, 'n: 22\n');
    expect(readDoc(cache, path).n).toBe(22);
    expect(cache.stats().parses).toBe(2);
  });

  test('one value per validator: a file read through two never shares one', () => {
    const cache = new ParseCache({ nowNs: later });
    const path = file('a.yaml', 'n: 1\n');
    const doubled = (raw: unknown) => ({ n: validateDoc(raw).n * 2 });
    const double = () => cache.read(path, doubled, (text) => doubled(parseYaml(text)));
    expect(readDoc(cache, path).n).toBe(1);
    expect(double().n).toBe(2);
    expect(readDoc(cache, path).n).toBe(1);
    expect(double().n).toBe(2);
    expect(cache.stats()).toEqual({ parses: 2, entries: 1 });
  });

  test('a failure is never cached: a corrupt file throws on every read', () => {
    const cache = new ParseCache({ nowNs: later });
    const path = file('a.yaml', 'n: 1\n');
    readDoc(cache, path);
    writeFileSync(path, 'n: [1\n');
    expect(() => readDoc(cache, path)).toThrow(/line 2/);
    expect(() => readDoc(cache, path)).toThrow(/line 2/);
    expect(cache.stats()).toEqual({ parses: 3, entries: 0 });
    writeFileSync(path, 'n: 3\n');
    expect(readDoc(cache, path).n).toBe(3);
  });

  test('a missing file throws and forgets its entry; drop forgets one', () => {
    const cache = new ParseCache({ nowNs: later });
    const a = file('a.yaml', 'n: 1\n');
    const b = file('b.yaml', 'n: 2\n');
    readDoc(cache, a);
    readDoc(cache, b);
    rmSync(a);
    expect(() => readDoc(cache, a)).toThrow(/ENOENT/);
    expect(cache.stats().entries).toBe(1);
    cache.drop(b);
    expect(cache.stats().entries).toBe(0);
  });

  test('bounded: the least recently read entry goes first', () => {
    const cache = new ParseCache({ maxEntries: 2, nowNs: later });
    const [a, b, c] = ['a', 'b', 'c'].map((name, i) => file(`${name}.yaml`, `n: ${i}\n`));
    readDoc(cache, a as string);
    readDoc(cache, b as string);
    readDoc(cache, a as string); // a is now the most recent
    readDoc(cache, c as string); // b goes
    expect(cache.stats()).toEqual({ parses: 3, entries: 2 });
    readDoc(cache, a as string);
    expect(cache.stats().parses).toBe(3);
    readDoc(cache, b as string);
    expect(cache.stats().parses).toBe(4);
  });

  // The stat key can't see a second same-size change in one timestamp tick
  // on the same inode; a fixed stat stands in for that here, whatever the
  // host's filesystem does.
  describe('racy entries: a change the stat key cannot see', () => {
    const frozen = (ctimeNs: bigint): ((path: string) => ParseCacheStat) => {
      return () => ({ ino: 7n, size: 6n, mtimeNs: ctimeNs, ctimeNs });
    };

    test('read within the racy window, a same-key rewrite is still picked up', () => {
      const ctime = BigInt(Date.now()) * 1_000_000n;
      const cache = new ParseCache({ stat: frozen(ctime), nowNs: () => ctime });
      const path = file('a.yaml', 'n: 1\n');
      expect(readDoc(cache, path).n).toBe(1);
      // Unchanged: compared, not parsed.
      expect(readDoc(cache, path).n).toBe(1);
      expect(cache.stats().parses).toBe(1);
      writeFileSync(path, 'n: 2\n');
      expect(readDoc(cache, path).n).toBe(2);
      expect(cache.stats().parses).toBe(2);
    });

    test('once the ctime is old enough, the entry settles and trusts the stat key', () => {
      const ctime = BigInt(Date.now()) * 1_000_000n;
      let now = ctime;
      const cache = new ParseCache({ stat: frozen(ctime), nowNs: () => now });
      const path = file('a.yaml', 'n: 1\n');
      readDoc(cache, path);
      now = ctime + PARSE_CACHE_RACY_NS;
      // This hit compares the text one last time and settles the entry.
      expect(readDoc(cache, path).n).toBe(1);
      // Settled: the text is no longer compared (a real change moves the key).
      writeFileSync(path, 'n: 2\n');
      expect(readDoc(cache, path).n).toBe(1);
      expect(cache.stats().parses).toBe(1);
    });

    test('an entry first read long after its change settles at once', () => {
      const ctime = BigInt(Date.now()) * 1_000_000n - PARSE_CACHE_RACY_NS;
      const cache = new ParseCache({
        stat: frozen(ctime),
        nowNs: () => ctime + PARSE_CACHE_RACY_NS,
      });
      const path = file('a.yaml', 'n: 1\n');
      readDoc(cache, path);
      writeFileSync(path, 'n: 2\n');
      expect(readDoc(cache, path).n).toBe(1);
    });
  });

  test('the real stat: an in-place same-size rewrite keeps the inode and is picked up', () => {
    const cache = new ParseCache();
    const path = file('a.yaml', 'n: 1\n');
    const ino = statSync(path).ino;
    expect(readDoc(cache, path).n).toBe(1);
    writeFileSync(path, 'n: 2\n');
    expect(statSync(path).ino).toBe(ino);
    expect(readDoc(cache, path).n).toBe(2);
  });
});
