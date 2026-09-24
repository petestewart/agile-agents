/**
 * T134 acceptance: a doc dropped into a repo shows up in the set the next
 * brief is built from, and `search` returns the file and the line.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { DOC_BODY_CAP_BYTES, DocsService } from './service';

let repo: string;
let home: string;
let store: StateStore;
let streams: StreamService;
let docs: DocsService;
let root: Stream;
let child: Stream;
let orphan: Stream;

function repoDocsDir(): string {
  return join(home, 'repos', 'ledger', 'docs');
}

function repoDoc(name: string, body: string): void {
  mkdirSync(repoDocsDir(), { recursive: true });
  writeFileSync(join(repoDocsDir(), name), body);
}

function streamDoc(streamId: string, name: string, body: string): void {
  mkdirSync(join(home, 'streams', `${streamId}.docs`), { recursive: true });
  writeFileSync(join(home, 'streams', `${streamId}.docs`, name), body);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-docs-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  // T214: a node needs a repo with a commit.
  Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: repo },
  );
  const init = runInit(repo);
  home = init.stateRoot;
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  await store.addRepo('ledger', { path: repo });
  docs = new DocsService(store, streams, home);
  root = await streams.create('human', { title: 'root', goal: 'g', repo: 'ledger' });
  child = await streams.create('human', {
    title: 'child',
    goal: 'g',
    parent: root.id,
    repo: 'ledger',
  });
  orphan = await streams.create('human', { title: 'no repo', goal: 'g' });
});

afterEach(() => {
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('legacy `.agile-docs/` import (T207, P3)', () => {
  function legacyDoc(name: string, body: string): void {
    mkdirSync(join(repo, '.agile-docs'), { recursive: true });
    writeFileSync(join(repo, '.agile-docs', name), body);
  }

  test('is copied into the home once, logged, and never deleted', () => {
    const lines: string[] = [];
    const logged = new DocsService(store, streams, home, (l) => lines.push(l));
    legacyDoc('brief.md', 'old brief\n');
    expect(logged.listRepoDocs('ledger').map((d) => d.path)).toEqual([
      join(repoDocsDir(), 'brief.md'),
    ]);
    expect(readFileSync(join(repoDocsDir(), 'brief.md'), 'utf8')).toBe('old brief\n');
    expect(existsSync(join(repo, '.agile-docs', 'brief.md'))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('may be removed');
    // Once the home dir exists the repo dir is no longer read.
    legacyDoc('later.md', 'ignored');
    expect(logged.listRepoDocs('ledger').map((d) => d.name)).toEqual(['brief.md']);
    expect(lines).toHaveLength(1);
  });

  test('home docs win: no import when the home dir already exists', () => {
    repoDoc('home.md', 'mine');
    legacyDoc('brief.md', 'old');
    expect(docs.listRepoDocs('ledger').map((d) => d.name)).toEqual(['home.md']);
  });

  test('a repo name that is not one path segment is refused', () => {
    expect(() => docs.repoDocsDir('../x')).toThrow('invalid repo name');
  });

  test('a bad repo name is skipped and logged, not fatal to a home-wide search', async () => {
    const lines: string[] = [];
    const logged = new DocsService(store, streams, home, (l) => lines.push(l));
    await store.addRepo('../bad', { path: repo });
    repoDoc('brief.md', 'shared truth\n');
    expect(await logged.search('shared truth', {})).toHaveLength(1);
    expect(lines.some((l) => l.includes('skipped repo'))).toBe(true);
  });
});

describe('DocsService (T134)', () => {
  test('a doc added to a repo shows up for a stream in that repo', () => {
    repoDoc('brief.md', '# Ledger\n\nthe product brief\n');
    const listed = docs.listRepoDocs('ledger');
    expect(listed.map((d) => d.name)).toEqual(['brief.md']);
    expect(listed[0]?.source).toBe('repo');
    expect(listed[0]?.body).toContain('the product brief');
    expect(docs.docsForStream(child.id).map((d) => d.name)).toEqual(['brief.md']);
  });

  test('only `.md` files directly in `<home>/repos/<name>/docs/` are docs', () => {
    repoDoc('brief.md', 'yes');
    writeFileSync(join(repoDocsDir(), 'notes.txt'), 'no');
    mkdirSync(join(repoDocsDir(), 'nested.md'), { recursive: true });
    expect(docs.listRepoDocs('ledger').map((d) => d.name)).toEqual(['brief.md']);
  });

  test('a repo with no docs dir, and an unregistered repo, have no docs', () => {
    expect(docs.listRepoDocs('ledger')).toEqual([]);
    expect(docs.listRepoDocs('nope')).toEqual([]);
  });

  test('stream docs come from `<home>/streams/<id>.docs/`, sorted', () => {
    streamDoc(child.id, 'b.md', 'second');
    streamDoc(child.id, 'a.md', 'first');
    const listed = docs.listStreamDocs(child.id);
    expect(listed.map((d) => d.name)).toEqual(['a.md', 'b.md']);
    expect(listed.every((d) => d.source === 'stream')).toBe(true);
  });

  test('docsForStream is repo docs plus the stream docs of every ancestor, root→leaf', () => {
    repoDoc('brief.md', 'brief');
    streamDoc(root.id, 'r.md', 'root note');
    streamDoc(child.id, 'c.md', 'child note');
    expect(docs.docsForStream(child.id).map((d) => d.name)).toEqual(['brief.md', 'r.md', 'c.md']);
  });

  test('a stream with no repo has no repo docs and no error', () => {
    repoDoc('brief.md', 'brief');
    streamDoc(orphan.id, 'o.md', 'only mine');
    expect(docs.docsForStream(orphan.id).map((d) => d.name)).toEqual(['o.md']);
  });

  test('a body over 16 KiB is truncated with a marker', () => {
    repoDoc('big.md', 'x'.repeat(DOC_BODY_CAP_BYTES + 500));
    const doc = docs.listRepoDocs('ledger')[0];
    expect(doc?.body).toContain('truncated');
    expect(doc?.body.length).toBeLessThan(DOC_BODY_CAP_BYTES + 200);
  });

  test('search returns the file and the 1-based line of each hit, case-insensitively', async () => {
    repoDoc('brief.md', 'line one\nthe Ledger invariant\nline three\n');
    const hits = await docs.search('LEDGER inVariant', { stream: child.id });
    expect(hits).toEqual([
      { path: join(repoDocsDir(), 'brief.md'), line: 2, text: 'the Ledger invariant' },
    ]);
    expect(await docs.search('absent', { stream: child.id })).toEqual([]);
  });

  test('search is a literal substring match, not a regex, and caps at 50 hits', async () => {
    streamDoc(child.id, 'c.md', `${'needle(\n'.repeat(60)}`);
    const hits = await docs.search('needle(', { stream: child.id });
    expect(hits).toHaveLength(50);
    expect(hits[0]?.line).toBe(1);
  });

  test('search without a stream covers every registered repo and every stream', async () => {
    repoDoc('brief.md', 'shared truth\n');
    streamDoc(orphan.id, 'o.md', 'shared truth\n');
    const hits = await docs.search('shared truth', {});
    expect(hits).toHaveLength(2);
  });

  test('an empty query matches nothing', async () => {
    repoDoc('brief.md', 'anything\n');
    expect(await docs.search('', { stream: child.id })).toEqual([]);
  });
});
