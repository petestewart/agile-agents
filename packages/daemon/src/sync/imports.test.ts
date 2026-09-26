/** T284: the import index and `symbol_changed`, against a real temp git repo and home; no vendor. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RoutedEvent, validateImportIndex } from '@agile-agents/shared';
import { CardService } from '../coordination/cards';
import { RoutedEventService, makeEmitter, summarize } from '../events';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { SymbolWatcher, resolveSpec, scanSource } from './imports';
import { OverlapTracker } from './overlap';

describe('scanSource (P14 regex scan)', () => {
  test('exports and imports of the common forms', () => {
    const s = scanSource(
      [
        "import def, { a, b as c } from './x';",
        "import * as ns from '../y.js';",
        "import type { T } from './t';",
        "import './side';",
        "import {\n  multi,\n  line,\n} from './m';",
        "export { local as renamed } from './z';",
        "export * from './all';",
        "const lazy = await import('./lazy');",
        '// import { commented } from "./nope";',
        'export const salePrice = (c: number) => c;',
        'export async function load() {}',
        'export default class Shop {}',
        'export interface Price { cents: number }',
        'function helper() {}',
        'export { helper };',
      ].join('\n'),
    );
    expect(s.exports).toEqual(['Price', 'default', 'helper', 'load', 'renamed', 'salePrice']);
    expect(s.imports.map((i) => [i.spec, i.names.sort()])).toEqual([
      ['./z', ['local']],
      ['./all', ['*']],
      ['./x', ['a', 'b', 'default']],
      ['../y.js', ['*']],
      ['./t', ['T']],
      ['./m', ['line', 'multi']],
      ['./side', ['*']],
      ['./lazy', ['*']],
    ]);
    expect(s.ranges.get('helper')).toEqual([17, 17]);
  });

  test('resolves relative specifiers to repo files; packages resolve to nothing', () => {
    const known = new Set(['src/prices.ts', 'src/lib/index.ts', 'src/util.tsx']);
    expect(resolveSpec('src/shop.ts', './prices', known)).toBe('src/prices.ts');
    expect(resolveSpec('src/shop.ts', './prices.js', known)).toBe('src/prices.ts');
    expect(resolveSpec('src/a/b.ts', '../lib', known)).toBe('src/lib/index.ts');
    expect(resolveSpec('src/shop.ts', './util', known)).toBe('src/util.tsx');
    expect(resolveSpec('src/shop.ts', 'zod', known)).toBeUndefined();
  });
});

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let cards: CardService | undefined;

function sh(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-imports-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-imports-repo-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 't@example.com'], repo);
  sh(['config', 'user.name', 'T'], repo);
  writeFileSync(
    join(repo, 'prices.ts'),
    [
      'export function salePrice(cents: number): number {',
      '  return cents;',
      '}',
      '',
      'export const listPrice = (cents: number) => cents;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'shop.ts'), "import { listPrice } from './prices';\nlistPrice(1);\n");
  writeFileSync(join(repo, 'posts.ts'), 'export const p = 1;\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);
  store = StateStore.open(runInit(home).stateRoot);

  streams = new StreamService(store, {
    onUpdated: async (_b, a) => void (await cards?.refresh(a)),
  });
  cards = new CardService({ store, streams });
  await store.putRepos({ api: { path: repo } });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('symbol_changed (T284)', () => {
  test('changing salePrice in prices.ts alerts the sibling that imports it, and nobody else', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const parent = await streams.create('human', {
      title: 'Show sale prices',
      goal: 'g',
      project: project.id,
    });
    const child = async (title: string) => {
      const node = await streams.create('human', {
        title,
        goal: 'g',
        project: project.id,
        parent: parent.id,
        repo: 'api',
      });
      const wt = join(repo, '.worktrees', title);
      sh(['worktree', 'add', '-q', wt, '-b', `stream/${title}`, 'main'], repo);
      await store.updateStream('daemon', node.id, (s) => ({ ...s, worktree: wt }));
      return { id: node.id, wt };
    };
    const api = await child('api');
    const web = await child('web');
    const blog = await child('blog');

    const emitted: RoutedEvent[] = [];
    const base = makeEmitter(new RoutedEventService(store), streams);
    const emit = async (input: Parameters<typeof base>[0]) => {
      const e = await base(input);
      if (e) emitted.push(e);
      return e;
    };
    const watcher = new SymbolWatcher({ store, streams, repos: () => store.getRepos(), emit });
    const tracker = new OverlapTracker({
      streams,
      repos: () => store.getRepos(),
      intervalMs: 0,
      emit,
      afterTouched: (id) => watcher.onTouched(id),
    });

    // web now uses salePrice; blog edits an unrelated file and imports only listPrice.
    writeFileSync(
      join(web.wt, 'shop.ts'),
      "import { listPrice, salePrice } from './prices';\nsalePrice(listPrice(1));\n",
    );
    writeFileSync(
      join(blog.wt, 'posts.ts'),
      "import { listPrice } from './prices';\nexport const p = listPrice(2);\n",
    );
    await tracker.recompute(web.id);
    await tracker.recompute(blog.id);
    expect(emitted).toEqual([]);

    // api changes salePrice's body.
    writeFileSync(
      join(api.wt, 'prices.ts'),
      [
        'export function salePrice(cents: number): number {',
        '  return Math.round(cents * 0.9);',
        '}',
        '',
        'export const listPrice = (cents: number) => cents;',
        '',
      ].join('\n'),
    );
    await tracker.recompute(api.id);

    expect(store.getCard(api.id)?.exports_changed).toEqual(['prices.ts:salePrice']);
    const symbol = emitted.filter((e) => e.type === 'symbol_changed');
    expect(symbol).toHaveLength(1);
    const e = symbol[0] as RoutedEvent;
    expect(e.payload).toEqual({ sibling: api.id, symbol: 'prices.ts:salePrice', file: 'shop.ts' });
    expect(e.routing.map((r) => [r.node, r.because])).toEqual([
      [web.id, 'sibling'],
      [parent.id, 'ancestor'],
    ]);
    const title = (id: string) => streams.get(id).title;
    expect(summarize(e, web.id, title)).toStartWith(
      'api changed prices.ts:salePrice, which you import in shop.ts.',
    );

    // The index is on disk, built from main.
    const index = store.getEntity('index/api.json', validateImportIndex);
    expect(index.files['shop.ts']?.imports).toEqual([{ from: 'prices.ts', names: ['listPrice'] }]);
    expect(index.files['prices.ts']?.exports).toEqual(['listPrice', 'salePrice']);

    // Unchanged exports: a second recompute alerts nobody again.
    writeFileSync(join(api.wt, 'README.md'), 'x\n');
    await tracker.recompute(api.id);
    expect(emitted.filter((x) => x.type === 'symbol_changed')).toHaveLength(1);
  });
});
