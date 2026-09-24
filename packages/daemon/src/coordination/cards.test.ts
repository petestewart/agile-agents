/** T283: status cards against a real temp git repo and state home; no vendor, no network. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { buildCockpitFrame } from '../feed/snapshot';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { OverlapTracker } from '../sync';
import { CardService, cardFiles, cardState } from './cards';
import { ContractService } from './contracts';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let cards: CardService;
let tracker: OverlapTracker;
let verbs: VerbService;
let stateRoot: string;

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
  stateRoot = runInit(home).stateRoot;
  store = StateStore.open(stateRoot);
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
  test('a corrupt card is refused with path:line, never defaulted; the frame still renders the others', async () => {
    const shop = await new ProjectService(store, streams).create({ name: 'Shop' });
    const api = await child(shop.root, shop.id, 'api');
    const web = await child(shop.root, shop.id, 'web');
    await streams.update('agent', web.id, { agent: { progress: 'fine' } });
    const path = join(stateRoot, 'cards', `${api.id}.yaml`);
    const rel = `cards/${api.id}.yaml`;
    writeFileSync(path, `node: ${api.id}\ndoing: x\nstate: exploding\nfiles: []\n`);
    expect(() => store.getCard(api.id)).toThrow(`${rel}:3`);
    writeFileSync(path, 'node: [unclosed\n');
    expect(() => store.getCard(api.id)).toThrow(new RegExp(`${rel}:\\d+: `));

    const frame = buildCockpitFrame(streams, undefined, undefined, {}, (id) => store.getCard(id));
    const bad = frame.cards.find((c) => c.node === api.id);
    expect(bad && 'error' in bad ? bad.error : '').toMatch(new RegExp(`${rel}:\\d+: `));
    const good = frame.cards.find((c) => c.node === web.id);
    expect(good && 'doing' in good ? good.doing : '').toBe('fine');
  });

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
      /not a sibling, an ancestor or a descendant/,
    );
    // The parent's coordinator reads its children, and any ancestor its subtree.
    expect(verbs.readCard({ session: await session(web.id), node: helper.id }).node).toBe(
      helper.id,
    );
    expect(cards.read(shop.root, helper.id).node).toBe(helper.id);
    // …and nothing across projects.
    const other = await session(posts.id);
    expect(() => verbs.readCard({ session: other, node: api.id })).toThrow(
      /not a sibling, an ancestor or a descendant/,
    );
  });

  test('relies_on comes from the contracts the node is a party to (T281)', async () => {
    const shop = await new ProjectService(store, streams).create({ name: 'Shop' });
    const api = await child(shop.root, shop.id, 'api');
    await child(shop.root, shop.id, 'web');
    const contracts = new ContractService({ store, streams });
    const c = await contracts.write(
      shop.root,
      { title: 'Sale API', body: 'GET /sale', parties: [api.id] },
      'human',
    );
    const withContracts = new CardService({
      store,
      streams,
      reliesOn: (s) => contracts.forParty(s.id).map((x) => x.id),
    });
    await withContracts.refresh(streams.get(api.id));
    expect(store.getCard(api.id)?.relies_on).toEqual([c.id]);
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
