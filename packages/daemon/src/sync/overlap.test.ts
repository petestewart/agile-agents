/** T227: overlap tracking against a real temp git repo and state home; no vendor, no network. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoutedEvent } from '@agile-agents/shared';
import { RoutedEventService, makeEmitter, summarize } from '../events';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { OverlapTracker, findOverlaps, overlapMarked } from './overlap';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let tracker: OverlapTracker;

function sh(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-overlap-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-overlap-repo-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 't@example.com'], repo);
  sh(['config', 'user.name', 'T'], repo);
  writeFileSync(join(repo, 'prices.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'posts.ts'), 'export const p = 1;\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  await store.putRepos({ api: { path: repo } });
  tracker = new OverlapTracker({ streams, repos: () => store.getRepos(), intervalMs: 0 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function workNode(projectName: string, branch: string): Promise<{ id: string; wt: string }> {
  const project = await new ProjectService(store, streams).create({ name: projectName });
  const node = await streams.create('human', {
    title: `${projectName} api`,
    goal: 'g',
    project: project.id,
    repo: 'api',
  });
  const wt = join(repo, '.worktrees', branch);
  sh(['worktree', 'add', '-q', wt, '-b', branch, 'main'], repo);
  await store.updateStream('daemon', node.id, (s) => ({ ...s, worktree: wt }));
  return { id: node.id, wt };
}

describe('overlap tracking (T227)', () => {
  test('two live nodes on one repo in different projects sharing a file overlap within one recompute; a merge clears it', async () => {
    const shop = await workNode('Shop', 'shop');
    const blog = await workNode('Blog', 'blog');
    // Shop commits its change; Blog's is uncommitted, plus an untracked file.
    writeFileSync(join(shop.wt, 'prices.ts'), 'export const a = 2;\n');
    sh(['commit', '-qam', 'shop'], shop.wt);
    writeFileSync(join(blog.wt, 'prices.ts'), 'export const a = 3;\n');
    writeFileSync(join(blog.wt, 'new.ts'), 'x\n');

    await tracker.recompute(shop.id);
    await tracker.recompute(blog.id);
    expect(streams.get(blog.id).touched?.files).toEqual(['new.ts', 'prices.ts']);
    const overlaps = findOverlaps(streams.list());
    expect(overlaps).toEqual([{ repo: 'api', nodes: expect.any(Array), files: ['prices.ts'] }]);
    expect(new Set(overlaps[0]?.nodes)).toEqual(new Set([shop.id, blog.id]));
    // Both nodes and their ancestors (the project roots) carry the warning.
    const marked = overlapMarked(overlaps, streams.list());
    for (const id of [shop.id, blog.id]) {
      expect(marked.has(id)).toBe(true);
      expect(marked.has(streams.get(id).parent as string)).toBe(true);
    }

    await streams.update('daemon', shop.id, {
      delivery_state: { mode: 'direct', status: 'merged', at: new Date().toISOString() },
    });
    expect(findOverlaps(streams.list())).toEqual([]);
  });

  test('clears once a node stops touching the file; an unchanged recompute writes nothing', async () => {
    const shop = await workNode('Shop', 'shop');
    const blog = await workNode('Blog', 'blog');
    writeFileSync(join(shop.wt, 'prices.ts'), 'export const a = 2;\n');
    writeFileSync(join(blog.wt, 'prices.ts'), 'export const a = 3;\n');
    await tracker.recomputeAll();
    expect(findOverlaps(streams.list())).toHaveLength(1);

    const before = streams.get(shop.id).touched;
    await tracker.recompute(shop.id);
    expect(streams.get(shop.id).touched).toEqual(before);

    sh(['checkout', '--', 'prices.ts'], blog.wt);
    writeFileSync(join(blog.wt, 'posts.ts'), 'export const p = 2;\n');
    await tracker.recompute(blog.id);
    expect(findOverlaps(streams.list())).toEqual([]);
  });
});

describe('T534: one node never stops the overlap sweep', () => {
  test('a node whose worktree dir is gone is passed over; the node after it is recomputed', async () => {
    const gone = await workNode('Gone', 'gone');
    const blog = await workNode('Blog', 'blog');
    const order = streams.list().map((s) => s.id);
    expect(order.indexOf(gone.id)).toBeLessThan(order.indexOf(blog.id));
    rmSync(gone.wt, { recursive: true, force: true });
    writeFileSync(join(blog.wt, 'posts.ts'), 'export const p = 2;\n');

    await tracker.recomputeAll();
    expect(streams.get(blog.id).touched?.files).toEqual(['posts.ts']);
    expect(streams.get(gone.id).touched).toBeUndefined();
    expect(existsSync(gone.wt)).toBe(false);
  });

  test('a node whose recompute throws is logged; the node after it is recomputed', async () => {
    const shop = await workNode('Shop', 'shop');
    const blog = await workNode('Blog', 'blog');
    const order = streams.list().map((s) => s.id);
    expect(order.indexOf(shop.id)).toBeLessThan(order.indexOf(blog.id));
    writeFileSync(join(shop.wt, 'prices.ts'), 'export const a = 2;\n');
    writeFileSync(join(blog.wt, 'posts.ts'), 'export const p = 2;\n');
    const update = streams.update.bind(streams);
    streams.update = ((by, id, patch) => {
      if (id === shop.id) throw new Error('the store refused the write');
      return update(by, id, patch);
    }) as typeof streams.update;
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tracker.recomputeAll();
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(
        `overlap recompute of ${shop.id} failed`,
      );
    } finally {
      errors.mockRestore();
      streams.update = update;
    }
    expect(streams.get(blog.id).touched?.files).toEqual(['posts.ts']);
  });
});

describe('T550: a burst of edits is one recompute', () => {
  test('three edits inside the window recompute once; another after it runs again; the sweep is unchanged', async () => {
    const node = await workNode('Shop', 'stream/shop');
    let reads = 0;
    tracker = new OverlapTracker({
      streams,
      repos: () => {
        reads += 1;
        return store.getRepos();
      },
      intervalMs: 0,
      debounceMs: 40,
    });
    tracker.schedule(node.id);
    tracker.schedule(node.id);
    tracker.schedule(node.id);
    await Bun.sleep(150);
    expect(reads).toBe(1);
    tracker.schedule(node.id);
    await Bun.sleep(150);
    expect(reads).toBe(2);
    await tracker.recomputeAll();
    expect(reads).toBe(3);
    tracker.stop();
  });

  test('stop drops a waiting recompute', async () => {
    const node = await workNode('Shop', 'stream/shop');
    let reads = 0;
    tracker = new OverlapTracker({
      streams,
      repos: () => {
        reads += 1;
        return store.getRepos();
      },
      intervalMs: 0,
      debounceMs: 40,
    });
    tracker.schedule(node.id);
    tracker.stop();
    await Bun.sleep(120);
    expect(reads).toBe(0);
  });
});

describe('overlap routed events (T244)', () => {
  test('a new overlap reaches both nodes and their ancestors, once', async () => {
    const emitted: RoutedEvent[] = [];
    const base = makeEmitter(new RoutedEventService(store), streams);
    tracker = new OverlapTracker({
      streams,
      repos: () => store.getRepos(),
      intervalMs: 0,
      emit: async (input) => {
        const e = await base(input);
        if (e) emitted.push(e);
        return e;
      },
    });
    const shop = await workNode('Shop', 'stream/shop');
    const blog = await workNode('Blog', 'stream/blog');
    writeFileSync(join(shop.wt, 'prices.ts'), 'export const a = 2;\n');
    writeFileSync(join(blog.wt, 'prices.ts'), 'export const a = 3;\n');
    await tracker.recomputeAll();
    await tracker.recomputeAll();
    expect(emitted.map((e) => e.type)).toEqual(['overlap']);
    const e = emitted[0] as RoutedEvent;
    const shopRoot = streams.get(shop.id).parent as string;
    const blogRoot = streams.get(blog.id).parent as string;
    expect(e.routing.map((r) => [r.node, r.because])).toEqual([
      [blog.id, 'self'],
      [blogRoot, 'ancestor'],
      [shop.id, 'party'],
      [shopRoot, 'ancestor'],
    ]);
    const title = (id: string) => streams.get(id).title;
    expect(summarize(e, blog.id, title)).toStartWith('You and Shop api (P-');
    expect(summarize(e, blog.id, title)).toEndWith(
      "both changed prices.ts. Your coordinator decides who waits; don't rewrite their part.",
    );
    expect(summarize(e, shop.id, title)).toBe(
      `You and Blog api (${String(e.project)}) both changed prices.ts. Your coordinator decides who waits; don't rewrite their part.`,
    );
  });
});
