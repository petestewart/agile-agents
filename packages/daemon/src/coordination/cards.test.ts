/** T283: status cards against a real temp git repo and state home; no vendor, no network. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { OverlapTracker } from '../sync';
import { CardService, cardFiles, cardState } from './cards';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let cards: CardService;
let tracker: OverlapTracker;
let verbs: VerbService;

function sh(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-cards-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-cards-repo-'));
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.email', 't@example.com'], repo);
  sh(['config', 'user.name', 'T'], repo);
  writeFileSync(join(repo, 'prices.ts'), 'export const a = 1;\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'init'], repo);
  store = StateStore.open(runInit(home).stateRoot);
  // Wired the way daemon.ts wires it: the card follows every record update.
  streams = new StreamService(store, {
    onUpdated: async (_b, after) => void (await cards.refresh(after)),
  });
  cards = new CardService({ store, streams });
  await store.putRepos({ api: { path: repo } });
  tracker = new OverlapTracker({ streams, repos: () => store.getRepos(), intervalMs: 0 });
  verbs = new VerbService({
    store,
    streams,
    questions: new QuestionService(store, streams),
    cards,
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function child(
  parent: string,
  project: string,
  title: string,
  branch?: string,
): Promise<Stream> {
  const node = await streams.create('human', { title, goal: 'g', project, parent, repo: 'api' });
  if (branch === undefined) return node;
  const wt = join(repo, '.worktrees', branch);
  sh(['worktree', 'add', '-q', wt, '-b', branch, 'main'], repo);
  return store.updateStream('daemon', node.id, (s) => ({ ...s, worktree: wt }));
}

async function session(stream: string): Promise<string> {
  const id = ulid();
  await store.putAgent(id as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    stream,
    last_seen: new Date().toISOString(),
    role: 'worker',
  });
  return id;
}

describe('status cards (T283)', () => {
  test('a card follows edits within one recompute, and progress sets doing', async () => {
    const shop = await new ProjectService(store, streams).create({ name: 'Shop' });
    const api = await child(shop.root, shop.id, 'api', 'T-api');
    writeFileSync(join(api.worktree as string, 'prices.ts'), 'export const salePrice = 2;\n');
    await tracker.recompute(api.id);
    expect(store.getCard(api.id)?.files).toEqual(['prices.ts']);

    writeFileSync(join(api.worktree as string, 'sale.ts'), 'export {};\n');
    await tracker.recompute(api.id);
    expect(store.getCard(api.id)?.files).toEqual(['prices.ts', 'sale.ts']);

    await verbs.progress({ session: await session(api.id), text: 'adding salePrice\nmore detail' });
    const card = store.getCard(api.id);
    expect(card?.doing).toBe('adding salePrice');
    expect(card?.files).toEqual(['prices.ts', 'sale.ts']);

    await streams.update('agent', api.id, { agent: { status: 'working' } });
    expect(store.getCard(api.id)?.state).toBe('working');
  });

  test('a sibling and a descendant can read it; a node in another project cannot', async () => {
    const projects = new ProjectService(store, streams);
    const shop = await projects.create({ name: 'Shop' });
    const blog = await projects.create({ name: 'Blog' });
    const api = await child(shop.root, shop.id, 'api');
    const web = await child(shop.root, shop.id, 'web');
    const helper = await child(web.id, shop.id, 'web helper');
    const posts = await child(blog.root, blog.id, 'posts');
    await streams.update('agent', api.id, { agent: { progress: 'wiring salePrice' } });

    const fromWeb = verbs.readCard({ session: await session(web.id), node: api.id });
    expect(fromWeb.doing).toBe('wiring salePrice');
    // An ancestor's card, from two levels down.
    expect(verbs.readCard({ session: await session(helper.id), node: shop.root }).node).toBe(
      shop.root,
    );
    // Not the sibling's child (not a sibling or an ancestor of api)…
    const fromApi = await session(api.id);
    expect(() => verbs.readCard({ session: fromApi, node: helper.id })).toThrow(
      /not a sibling or an ancestor/,
    );
    // …and nothing across projects.
    const other = await session(posts.id);
    expect(() => verbs.readCard({ session: other, node: api.id })).toThrow(
      /not a sibling or an ancestor/,
    );
  });

  test('the Director hook reads any card', async () => {
    const projects = new ProjectService(store, streams);
    const shop = await projects.create({ name: 'Shop' });
    const blog = await projects.create({ name: 'Blog' });
    const api = await child(shop.root, shop.id, 'api');
    const director = new CardService({ store, streams, isDirector: (id) => id === blog.root });
    expect(director.read(blog.root, api.id).node).toBe(api.id);
    expect(() => cards.read(blog.root, api.id)).toThrow();
  });

  test('files cap at 200 with a "+N more" line; state from both halves', () => {
    const files = Array.from({ length: 205 }, (_, i) => `f${i}.ts`);
    const s = {
      touched: { files, base: 'x', at: 'y' },
      agent: { status: 'question' },
      human: { status: 'open' },
    } as unknown as Stream;
    expect(cardFiles(s)).toHaveLength(201);
    expect(cardFiles(s).at(-1)).toBe('+5 more');
    expect(cardState(s)).toBe('blocked');
    expect(cardState({ ...s, human: { status: 'landed' } } as Stream)).toBe('done');
  });
});
