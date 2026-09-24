/** `docs.*` params are validated at the edge (T134), like every other RPC table. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildDocsRpcMethods } from './rpc';
import { DocsService } from './service';

let repo: string;
let store: StateStore;
let methods: Record<string, (params: unknown) => unknown>;
let stream: Stream;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-docs-rpc-'));
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
  store = StateStore.open(init.stateRoot);
  const streams = new StreamService(store);
  await store.addRepo('ledger', { path: repo });
  methods = buildDocsRpcMethods(new DocsService(store, streams, init.stateRoot));
  stream = await streams.create('human', { title: 's', goal: 'g', repo: 'ledger' });
  const docsDir = join(init.stateRoot, 'repos', 'ledger', 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, 'brief.md'), 'the invariant\n');
});

afterEach(() => {
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

test("docs.list returns the stream's docs", () => {
  const result = methods['docs.list']?.({ stream: stream.id }) as { docs: Array<{ name: string }> };
  expect(result.docs.map((d) => d.name)).toEqual(['brief.md']);
});

test('docs.search returns path and line', async () => {
  const result = (await methods['docs.search']?.({ query: 'invariant' })) as {
    hits: Array<{ line: number }>;
  };
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.line).toBe(1);
});

test('a bad stream id or a missing query is a param error, not a TypeError', () => {
  expect(() => methods['docs.list']?.({ stream: 'nope' })).toThrow(RpcParamError);
  expect(() => methods['docs.list']?.('nope')).toThrow(RpcParamError);
  expect(methods['docs.search']?.({})).rejects.toThrow(RpcParamError);
  expect(methods['docs.search']?.({ query: 'x', stream: 'nope' })).rejects.toThrow(RpcParamError);
});
