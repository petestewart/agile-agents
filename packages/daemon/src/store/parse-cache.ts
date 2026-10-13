/**
 * T547 (perf P2): `StateStore`'s cache of parsed, validated files. Parsing
 * the YAML is most of every store read, and the daemon re-reads the same
 * unchanged records on every tick and every cockpit frame, so a file is
 * parsed again only when it has changed.
 *
 * An entry is keyed by the file's absolute path and checked on every read
 * against `stat`: `ino:size:mtimeNs:ctimeNs`. An atomic write renames a new
 * inode in, an in-place write moves mtime and ctime, and ctime can't be set
 * back with `utimes`. An entry holds the validated value per validator (a
 * file read through two validators never shares a value), and every read
 * returns a `structuredClone`, so a caller that mutates what it got changes
 * nothing here. A failure is never cached: a corrupt file throws, with its
 * path and line, on every read.
 *
 * Racy entries (git's "racily clean" files): a second change in the same
 * filesystem timestamp tick, at the same size and on the same inode (in
 * place, or a freed inode number reused by an atomic write), leaves the stat
 * key as it was. So an entry read within `PARSE_CACHE_RACY_NS` of its
 * file's ctime keeps the text it was parsed from, and a hit on it reads the
 * file and compares the text (no parse) until the ctime is old enough that
 * any later change must move it.
 *
 * Bounded: past `maxEntries`, the least recently read entry goes first.
 */

import { type BigIntStats, readFileSync, statSync } from 'node:fs';

/** The most files one store keeps parsed (≈20k records; each is a few KB in memory). */
export const PARSE_CACHE_MAX_ENTRIES = 20_000;

/** Longer than any filesystem's timestamp tick (FAT's is 2 s; ext4's and APFS's a clock tick). */
export const PARSE_CACHE_RACY_NS = 3_000_000_000n;

/** A file is read through one validator in practice; a few more is a caller building one per read. */
const MAX_VALUES_PER_ENTRY = 4;

/** The part of a file's `stat` an entry is checked against. */
export type ParseCacheStat = Pick<BigIntStats, 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>;

export interface ParseCacheOptions {
  /** Default `PARSE_CACHE_MAX_ENTRIES`. */
  maxEntries?: number;
  /** Test seam: a file's stat (default `statSync(path, {bigint: true})`). */
  stat?: (absPath: string) => ParseCacheStat;
  /** Test seam: the wall clock in ns since the epoch (default `Date.now()`). */
  nowNs?: () => bigint;
}

interface Entry {
  /** `ino:size:mtimeNs:ctimeNs` when the values were parsed. */
  key: string;
  /** The text the values came from, kept while the entry is racy (see the file header). */
  text: string | undefined;
  /** Validated value per validator. */
  values: Map<object, unknown>;
}

export class ParseCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly stat: (absPath: string) => ParseCacheStat;
  private readonly nowNs: () => bigint;
  private parseCount = 0;

  constructor(options: ParseCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? PARSE_CACHE_MAX_ENTRIES;
    this.stat = options.stat ?? ((absPath) => statSync(absPath, { bigint: true }));
    this.nowNs = options.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  }

  /**
   * `parse(text)` of the file at `absPath` (it parses and validates, and
   * throws on a corrupt file), from the cache when the file is unchanged.
   * `validator` names what `parse` produces: one value is kept per validator.
   */
  read<T>(absPath: string, validator: object, parse: (text: string) => T): T {
    // Taken before the stat: a change that lands after it reads as racy.
    const now = this.nowNs();
    let stat: ParseCacheStat;
    try {
      stat = this.stat(absPath);
    } catch (err) {
      this.entries.delete(absPath);
      throw err;
    }
    const key = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const settled = now - stat.ctimeNs >= PARSE_CACHE_RACY_NS;

    let entry = this.entries.get(absPath);
    if (entry !== undefined && entry.key !== key) entry = undefined;
    let text: string | undefined;
    if (entry?.text !== undefined) {
      text = readFileSync(absPath, 'utf8');
      if (text !== entry.text) entry = undefined;
      else if (settled) entry.text = undefined;
    }

    if (entry === undefined) {
      this.entries.delete(absPath);
    } else {
      // Most recently read goes last: the Map's order is the eviction order.
      this.entries.delete(absPath);
      this.entries.set(absPath, entry);
      if (entry.values.has(validator)) return structuredClone(entry.values.get(validator) as T);
    }

    text ??= readFileSync(absPath, 'utf8');
    this.parseCount += 1;
    // A throw here caches nothing, and a stale entry is already gone.
    const value = parse(text);
    if (entry === undefined) {
      entry = { key, text: settled ? undefined : text, values: new Map() };
      this.entries.set(absPath, entry);
      if (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    if (entry.values.size >= MAX_VALUES_PER_ENTRY) entry.values.clear();
    entry.values.set(validator, value);
    return structuredClone(value);
  }

  /** Forgets one file: the store calls this when it writes or removes it. */
  drop(absPath: string): void {
    this.entries.delete(absPath);
  }

  /** Test seam (T547): files parsed so far, and entries held. */
  stats(): { parses: number; entries: number } {
    return { parses: this.parseCount, entries: this.entries.size };
  }
}
