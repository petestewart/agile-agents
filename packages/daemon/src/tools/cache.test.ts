import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheEntryPath, cacheKey, readCacheEntry, sha256Hex, writeCacheEntry } from './cache';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-tool-cache-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('cacheKey', () => {
  test('same parts -> same key', () => {
    expect(cacheKey(['abc', 'question'])).toBe(cacheKey(['abc', 'question']));
  });

  test('different parts -> different keys, and the join separator does not let parts alias', () => {
    expect(cacheKey(['ab', 'c'])).not.toBe(cacheKey(['a', 'bc']));
    expect(cacheKey(['abc', 'question'])).not.toBe(cacheKey(['abc', 'other question']));
  });
});

describe('sha256Hex', () => {
  test('deterministic and content-sensitive', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).not.toBe(sha256Hex('hellO'));
  });
});

describe('cache read/write round trip', () => {
  test('a miss reads undefined; a write is read back exactly', () => {
    const path = cacheEntryPath(repo, 'read_summary', 'S-01', cacheKey(['h', 'q']));
    const data = { summary: 'x', refs: [{ path: 'a.ts', lines: '1-2' }] };
    expect(readCacheEntry<typeof data>(path)).toBeUndefined();

    writeCacheEntry(path, data);
    expect(readCacheEntry<typeof data>(path)).toEqual(data);
  });

  test('scopes under the sprint id, and `nosprint` when none is given', () => {
    const key = cacheKey(['h', 'q']);
    const withSprint = cacheEntryPath(repo, 'read_summary', 'S-01', key);
    const noSprint = cacheEntryPath(repo, 'read_summary', undefined, key);
    expect(withSprint).not.toBe(noSprint);
    expect(noSprint).toContain('nosprint');

    writeCacheEntry(withSprint, { summary: 'sprint-scoped' });
    expect(readCacheEntry(noSprint)).toBeUndefined();
  });

  test('a corrupted cache file reads as a miss, not a crash', () => {
    const path = cacheEntryPath(repo, 'read_summary', undefined, 'deadbeef');
    writeCacheEntry(path, 'placeholder'); // valid JSON so the dir exists
    Bun.write(path, '{not valid json');
    expect(readCacheEntry(path)).toBeUndefined();
  });
});
