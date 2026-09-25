/**
 * T303 (projects-design §12 "Suggests norms"): findings that repeat across
 * projects wake the Director once; its `propose_knowledge` reaches the
 * operator as a `proposed` item carrying its sources.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, DIRECTOR_NODE, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { RoutedEventService } from '../events/service';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { MAX_NORM_WAKES_PER_DAY, NormWatch, similar } from './norms';

let home: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;
let events: RoutedEventService;
let rules: KnowledgeService;
let watch: NormWatch;
let verbs: VerbService;
let director: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-director-norms-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
  events = new RoutedEventService(store);
  rules = new KnowledgeService({ store, streams });
  watch = new NormWatch({ store, streams, events });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  verbs = new VerbService({ store, streams, questions, rules, onFinding: () => {} });
  director = ulid();
  await store.putAgent(director as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    last_seen: new Date().toISOString(),
    role: 'coordinator',
    worktree: join(home, 'sessions', director),
  });
  await store.putDirector({
    thread: DIRECTOR_NODE,
    created_at: new Date().toISOString(),
    session: {
      id: director,
      vendor: 'claude',
      model: 'sonnet',
      role: 'coordinator',
      status: 'running',
    },
  });
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A node in `project` with a worker session attached; returns the session. */
async function worker(project: string, title: string): Promise<string> {
  const node = await streams.create('human', { title, goal: 'g', project });
  const session = ulid();
  await store.putAgent(session as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    last_seen: new Date().toISOString(),
    role: 'reviewer',
    stream: node.id,
  });
  return session;
}

const wakes = () =>
  events.pendingFor(DIRECTOR_NODE).filter((p) => p.event.type === 'director_request');

async function find(session: string, file: string, text: string) {
  await verbs.finding({ session, severity: 'major', file, text });
  return watch.check();
}

test('three similar findings across two projects: one wake, then one proposal with its sources', async () => {
  const shop = await projects.create({ name: 'Shop' });
  const blog = await projects.create({ name: 'Blog' });
  const a = await worker(shop.id, 'Checkout');
  const b = await worker(shop.id, 'Cart');
  const c = await worker(blog.id, 'Posts');
  const d = await worker(blog.id, 'Comments');

  expect(
    await find(a, 'src/api/orders.ts', 'handler swallows the error from the database call'),
  ).toBeUndefined();
  expect(await find(d, 'README.md', 'typo in the heading')).toBeUndefined();
  expect(
    await find(b, 'src/api/cart.ts', 'catch block swallows the database error silently'),
  ).toBeUndefined();
  const event = await find(
    c,
    'lib/posts/load.ts',
    'swallows the database error instead of returning it',
  );
  expect(event?.type).toBe('director_request');
  expect(wakes()).toHaveLength(1);
  const body = (event?.payload as { body: string }).body;
  expect(body).toContain('3 similar findings across 2 projects');
  expect(body).not.toContain('typo');

  // Dedup: a fourth similar finding (one fresh source) and a rerun wake nothing.
  expect(await find(d, 'lib/comments/x.ts', 'swallows the database error again')).toBeUndefined();
  expect(await watch.check()).toBeUndefined();
  expect(wakes()).toHaveLength(1);

  // The Director proposes; the item is `proposed`, from the Director, with its sources.
  const ids = (store.readDirectorThread().find((l) => l.ref?.startsWith('norm:'))?.ref ?? '')
    .slice('norm:'.length)
    .split(',');
  expect(ids).toHaveLength(3);
  const line = await verbs.proposeKnowledge({
    session: director,
    text: 'Never swallow a database error: return or rethrow it.',
    scope: 'global',
    sources: ids,
  });
  expect(line).toMatchObject({ by: 'director', kind: 'proposal' });
  const items = rules.list().filter((k) => k.source.by === 'director');
  expect(items).toHaveLength(1);
  expect(items[0]?.status).toBe('proposed');
  expect(items[0]?.source.session).toBe(director);
  for (const id of ids) expect(items[0]?.source.finding).toContain(id);
});

test('repeats inside one project do not wake the Director', async () => {
  const shop = await projects.create({ name: 'Shop' });
  const a = await worker(shop.id, 'A');
  const b = await worker(shop.id, 'B');
  await find(a, 'src/api/a.ts', 'swallows the database error');
  await find(b, 'src/api/b.ts', 'swallows the database error');
  expect(await find(a, 'src/api/c.ts', 'swallows the database error')).toBeUndefined();
  expect(wakes()).toHaveLength(0);
});

test('norm wakes are capped per day', async () => {
  const p1 = await projects.create({ name: 'P1' });
  const p2 = await projects.create({ name: 'P2' });
  const a = await worker(p1.id, 'A');
  const b = await worker(p2.id, 'B');
  for (let i = 0; i < MAX_NORM_WAKES_PER_DAY + 1; i++) {
    await find(a, `area${i}/x.ts`, `issue ${i}`);
    await find(b, `area${i}/y.ts`, `issue ${i}`);
    await find(b, `area${i}/z.ts`, `issue ${i}`);
  }
  expect(wakes()).toHaveLength(MAX_NORM_WAKES_PER_DAY);
});

test('the Director must name a scope', async () => {
  await expect(
    verbs.proposeKnowledge({ session: director, text: 'x', scope: 'repo' }),
  ).rejects.toThrow(/name the scope/);
  await expect(verbs.proposeKnowledge({ session: director, text: 'x' })).rejects.toThrow(
    /name the scope/,
  );
});

test('similar: same file area or most of the wording', () => {
  const s = (file: string | undefined, text: string) => ({
    id: 'x',
    project: 'p',
    node: 'n',
    ...(file ? { file } : {}),
    text,
  });
  expect(similar(s('src/a/x.ts', 'one'), s('src/a/y.ts', 'two'))).toBe(true);
  expect(
    similar(
      s('x.ts', 'missing null check on user input'),
      s(undefined, 'null check missing on input'),
    ),
  ).toBe(true);
  expect(similar(s('x.ts', 'missing null check'), s('y.ts', 'slow loop'))).toBe(false);
});
