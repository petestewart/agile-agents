/** T324: status push and "Create issue" — against the local fake Jira only. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Stream } from '@agile-agents/shared';
import { GateService } from '../gates';
import { startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { type FakeJira, startFakeJira } from './fake-jira';
import { createJira } from './jira';
import { TrackerLinks } from './link';
import { TrackerStatusPush, pushPhase } from './push';

let home: string;
let stateRoot: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;
let jira: FakeJira;
let links: TrackerLinks;
let push: TrackerStatusPush;
let project: Project;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-trackerpush-'));
  stateRoot = runInit(home).stateRoot;
  store = StateStore.open(stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
  jira = await startFakeJira();
  const port = createJira({ base_url: jira.baseUrl, email: jira.email, token: jira.token });
  links = new TrackerLinks({
    streams,
    project: (id) => store.getProject(id),
    configured: () => ['jira'],
    tracker: () => port,
  });
  push = new TrackerStatusPush({ project: (id) => store.getProject(id), tracker: () => port });
  project = await projects.create({ name: 'Shop' });
});

afterEach(() => {
  jira.stop();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const writes = () =>
  jira.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);

async function linkedNode(): Promise<Stream> {
  jira.addIssue({ key: 'SHOP-11', title: 'Sale prices', description: 'AC: struck through' });
  const node = await streams.create('human', { title: 'Sale', goal: 'tbd', project: project.id });
  return links.link(node.id, 'SHOP-11', { system: 'jira' });
}

/** The phases in order: idle → working → PR open → merged. */
function lifecycle(s: Stream): Stream[] {
  const at = '2026-09-25T10:00:00Z';
  const pr = {
    number: 7,
    url: 'https://github.test/o/r/pull/7',
    head: 'stream/x',
    base: 'main',
    state: 'open' as const,
    draft: false,
    review: 'none' as const,
    checks: 'none' as const,
    mergeable: 'unknown' as const,
    auto_merge: 'off' as const,
    last_seen: {},
    polled_at: at,
  };
  const working = { ...s, agent: { ...s.agent, status: 'working' as const } };
  const review = {
    ...working,
    delivery_state: { mode: 'pr' as const, status: 'pr_open' as const, pr, at },
  };
  const merged = {
    ...review,
    delivery_state: { ...review.delivery_state, status: 'merged' as const },
  };
  return [s, working, review, merged];
}

async function run(states: Stream[]): Promise<void> {
  for (let i = 1; i < states.length; i++) {
    await push.onUpdated(states[i - 1] as Stream, states[i] as Stream);
  }
}

describe('status push (T324)', () => {
  test('push_status off (the default): nothing is sent', async () => {
    const node = await linkedNode();
    await projects.update(project.id, {
      tracker: { system: 'jira', status_map: { in_progress: 'In Progress', done: 'Done' } },
    });
    expect(store.getProject(project.id).tracker?.push_status).toBe(false);
    const before = jira.requests.length;
    await run(lifecycle(node));
    expect(jira.requests.length).toBe(before);
  });

  test('push_status on: the mapped transitions and the PR link; never a text edit or close', async () => {
    const node = await linkedNode();
    await projects.update(project.id, {
      tracker: {
        system: 'jira',
        push_status: true,
        status_map: { in_progress: 'In Progress', in_review: 'In Review', done: 'Done' },
      },
    });
    const before = jira.requests.length;
    const states = lifecycle(node);
    await run(states);
    // A repeat of the last update (no phase change) sends nothing more.
    await push.onUpdated(states[3] as Stream, states[3] as Stream);
    const issue = jira.issues.find((i) => i.key === 'SHOP-11');
    expect(issue?.status).toBe('Done');
    expect(issue?.links).toEqual([{ url: 'https://github.test/o/r/pull/7', title: 'PR #7: Sale' }]);
    expect(issue?.title).toBe('Sale prices');
    expect(issue?.description).toBe('AC: struck through');
    const sent = jira.requests.slice(before).filter((r) => r.method !== 'GET');
    const paths = sent.map((r) => `${r.method} ${r.path}`);
    // Only transitions and a remote link: no PUT (edit), no DELETE, no new issue.
    for (const p of paths) {
      expect(p).toMatch(/^POST \/rest\/api\/3\/issue\/SHOP-11\/(transitions|remotelink)$/);
    }
    expect(paths.filter((p) => p.endsWith('/transitions'))).toHaveLength(3);
    expect(paths.filter((p) => p.endsWith('/remotelink'))).toHaveLength(1);
  });

  test('an unmapped phase is skipped; a phase moving back is not pushed', async () => {
    const node = await linkedNode();
    await projects.update(project.id, {
      tracker: { system: 'jira', push_status: true, status_map: { done: 'Done' } },
    });
    const [idle, working, review, merged] = lifecycle(node) as [Stream, Stream, Stream, Stream];
    await run([idle, working, review]);
    expect(writes().filter((p) => p.endsWith('/transitions'))).toEqual([]);
    await push.onUpdated(review, working);
    await push.onUpdated(review, merged);
    expect(writes().filter((p) => p.endsWith('/transitions'))).toHaveLength(1);
    expect(pushPhase(idle)).toBe('none');
  });
});

describe('create issue (T324)', () => {
  test('creates from the node and links it; the ancestor epic is the parent and the key default', async () => {
    jira.addIssue({ key: 'SHOP-1', title: 'Checkout', kind: 'epic' });
    const parent = await streams.create('human', {
      title: 'Checkout',
      goal: 'g',
      project: project.id,
    });
    await links.link(parent.id, 'SHOP-1', { system: 'jira' });
    const child = await streams.create('human', {
      title: 'Card form',
      goal: 'Add the card form',
      parent: parent.id,
    });
    const linked = await links.createIssue(child.id);
    const key = linked.external_link?.key as string;
    expect(key).toMatch(/^SHOP-\d+$/);
    expect(linked.goal).toBe('Add the card form');
    const issue = jira.issues.find((i) => i.key === key);
    expect(issue).toMatchObject({ title: 'Card form', parent: 'SHOP-1' });
    await expect(links.createIssue(child.id)).rejects.toMatchObject({ kind: 'validation' });
  });

  test('no project key and no linked ancestor is refused before any call', async () => {
    const node = await streams.create('human', { title: 'x', goal: 'g', project: project.id });
    const before = jira.requests.length;
    await expect(links.createIssue(node.id)).rejects.toMatchObject({ kind: 'validation' });
    expect(jira.requests.length).toBe(before);
    const made = await links.createIssue(node.id, { project: 'shop' });
    expect(made.external_link?.key).toMatch(/^SHOP-\d+$/);
  });
});

describe('POST /api/streams/:id/issue (T324)', () => {
  test('same-origin only, actor human; cross-origin is 403 and sends nothing', async () => {
    const questions = new QuestionService(store, streams);
    const gates = new GateService(store);
    const rules = new KnowledgeService({ store, streams });
    const server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates,
      streams,
      projects,
      questions,
      rules,
      inbox: new InboxService({ streams, questions, gates, rules }),
      trackerLinks: links,
    });
    try {
      const node = await streams.create('human', { title: 'x', goal: 'g', project: project.id });
      const url = `http://127.0.0.1:${server.port}/api/streams/${node.id}/issue`;
      const body = JSON.stringify({ project: 'SHOP' });
      const before = jira.requests.length;
      const foreign = await fetch(url, {
        method: 'POST',
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body,
      });
      expect(foreign.status).toBe(403);
      expect(jira.requests.length).toBe(before);
      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(ok.status).toBe(200);
      expect(streams.get(node.id).external_link?.key).toMatch(/^SHOP-\d+$/);
      const last = streams.readThread(node.id).entries.at(-1);
      expect(last?.by).toBe('human');
      expect(JSON.stringify(await ok.json())).not.toContain(jira.token);
    } finally {
      await server.stop();
    }
  });
});
