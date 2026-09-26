/**
 * T301 (projects-design §12, P16): the Director's verbs through the autonomy
 * gate at each project's `director` level, and its hard refusals.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  type Autonomy,
  DIRECTOR_NODE,
  HUMAN_ONLY_ACTIONS,
  ulid,
} from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { type ActOutcome, AutonomyService, allowed } from '../coordination/autonomy';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';

let home: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;
let autonomy: AutonomyService;
let verbs: VerbService;
let started: string[];
let restarted: string[];
let director: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-director-tools-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
  autonomy = new AutonomyService({ store, streams, projects });
  started = [];
  restarted = [];
  autonomy.setAgents({
    start: async (node) => started.push(node),
    restart: async (node) => restarted.push(node),
  });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  verbs = new VerbService({ store, streams, questions, autonomy });
  // The Director's session, as `DirectorService.start` registers it: streamless, coordinator table.
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

async function shop(level: Autonomy) {
  const project = await projects.create({ name: 'Shop' });
  await projects.update(project.id, { autonomy: { director: level } });
  const node = await streams.create('human', { title: 'Checkout', goal: 'g', project: project.id });
  const blog = await streams.create('human', {
    title: 'Blog /posts',
    goal: 'g',
    project: project.id,
  });
  return { project, node, blog };
}

const draft = (project: string) => ({
  session: director,
  project,
  title: 'Show sale prices',
  goal: 'sale prices on product pages',
  parts: [
    { title: 'api: add salePrice', goal: 'expose salePrice' },
    { title: 'web: show salePrice', goal: 'render it', after: [0] },
  ],
});

function childrenOf(parent: string) {
  return streams.list().filter((s) => s.parent === parent);
}

describe('allowed() for the Director, per level', () => {
  const LEVELS: Autonomy[] = ['advise', 'organise', 'run'];
  const table: Record<string, Record<Autonomy, string>> = {
    create_tree: { advise: 'propose', organise: 'apply', run: 'apply' },
    create_project: { advise: 'propose', organise: 'apply', run: 'apply' },
    create_node: { advise: 'propose', organise: 'apply', run: 'apply' },
    start_node: { advise: 'propose', organise: 'apply', run: 'apply' },
    add_waits_on: { advise: 'propose', organise: 'apply', run: 'apply' },
    restart_node: { advise: 'propose', organise: 'propose', run: 'apply' },
  };
  for (const [action, row] of Object.entries(table)) {
    test(action, () => {
      for (const level of LEVELS) {
        expect(allowed('director', action as 'create_tree', level)).toBe(row[level] as 'apply');
      }
    });
  }

  test('never merges, accepts knowledge, or answers a question, at any level', () => {
    for (const level of LEVELS) {
      for (const action of HUMAN_ONLY_ACTIONS) {
        expect(allowed('director', action, level)).toBe('refuse');
      }
    }
  });
});

describe('the Director verbs', () => {
  test('Advise: draft_tree is a draft on the Director thread; Create builds the tree', async () => {
    const { project } = await shop('advise');
    const out = (await verbs.draftTree(draft(project.id))) as ActOutcome;
    expect(out.applied).toBe(false);
    if (out.applied) return;
    expect(out.proposal.node).toBe(DIRECTOR_NODE);
    expect(out.proposal.principal).toBe('director');
    expect(streams.list().some((s) => s.title === 'Show sale prices')).toBe(false);
    expect(store.readDirectorThread().at(-1)).toMatchObject({ by: 'director', kind: 'proposal' });

    await autonomy.apply(out.proposal.id);
    const node = streams.list().find((s) => s.title === 'Show sale prices');
    expect(node?.parent).toBe(project.root);
    const parts = childrenOf(node?.id ?? '');
    expect(parts.map((p) => p.title).sort()).toEqual(['api: add salePrice', 'web: show salePrice']);
    const api = parts.find((p) => p.title.startsWith('api'));
    const web = parts.find((p) => p.title.startsWith('web'));
    expect(web?.waits_on?.map((w) => w.node)).toEqual([api?.id ?? '']);
    expect(autonomy.get(out.proposal.id).status).toBe('applied');
  });

  test('Organise: draft_tree, create_node, start_node and add_waits_on apply; restart is proposed', async () => {
    const { project, node, blog } = await shop('organise');
    const tree = (await verbs.draftTree(draft(project.id))) as ActOutcome;
    expect(tree.applied).toBe(true);
    expect(streams.list().some((s) => s.title === 'Show sale prices')).toBe(true);

    const child = (await verbs.createNode({
      session: director,
      parent: node.id,
      title: 'docs',
      goal: 'changelog',
    })) as ActOutcome;
    expect(child.applied).toBe(true);
    expect(childrenOf(node.id).map((s) => s.title)).toEqual(['docs']);

    expect(
      ((await verbs.startNode({ session: director, node: node.id })) as ActOutcome).applied,
    ).toBe(true);
    expect(started).toEqual([node.id]);

    const link = (await verbs.addWaitsOn({
      session: director,
      child: node.id,
      on: blog.id,
    })) as ActOutcome;
    expect(link.applied).toBe(true);
    expect(streams.get(node.id).waits_on?.map((w) => w.node)).toEqual([blog.id]);

    const restart = (await verbs.restartNode({ session: director, node: node.id })) as ActOutcome;
    expect(restart.applied).toBe(false);
    expect(restarted).toEqual([]);
  });

  test('Run: restart_node applies', async () => {
    const { node } = await shop('run');
    const out = (await verbs.restartNode({ session: director, node: node.id })) as ActOutcome;
    expect(out.applied).toBe(true);
    expect(restarted).toEqual([node.id]);
  });

  test('a new project is always a draft; Create makes it', async () => {
    const out = (await verbs.createProject({ session: director, name: 'Blog' })) as ActOutcome;
    expect(out.applied).toBe(false);
    if (out.applied) return;
    await autonomy.apply(out.proposal.id);
    expect(projects.list().map((p) => p.name)).toEqual(['Blog']);

    const tree = (await verbs.draftTree({
      ...draft('P-unused'),
      project: undefined,
      new_project: 'Shop',
    })) as ActOutcome;
    expect(tree.applied).toBe(false);
  });

  test('only the Director session may call them', async () => {
    const { project, node } = await shop('run');
    const worker = ulid();
    await store.putAgent(worker as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: node.id,
      last_seen: new Date().toISOString(),
      role: 'coordinator',
    });
    await expect(verbs.draftTree({ ...draft(project.id), session: worker })).rejects.toThrow(
      'only the Director',
    );
    await expect(verbs.startNode({ session: worker, node: node.id })).rejects.toThrow(
      'only the Director',
    );
  });

  test('a malformed draft is refused before anything is held', async () => {
    const { project } = await shop('advise');
    await expect(verbs.draftTree({ ...draft(project.id), new_project: 'Also' })).rejects.toThrow(
      'exactly one of project or new_project',
    );
    await expect(
      verbs.draftTree({ ...draft(project.id), parts: [{ title: 'a', goal: 'g', after: [0] }] }),
    ).rejects.toThrow('after');
    expect(autonomy.listOpen()).toEqual([]);
  });

  test('hard refusals: it cannot ask (answer) a question, merge or accept knowledge through a verb', async () => {
    // Its session has no stream, so every node-scoped verb (ask, deliver,
    // decide_contract, …) refuses; there is no merge or accept verb at all.
    await expect(verbs.ask({ session: director, text: 'land it?' })).rejects.toThrow(
      'unknown session',
    );
    await expect(verbs.deliver({ session: director })).rejects.toThrow('unknown session');
    for (const action of ['merge', 'accept_knowledge', 'answer_question'] as const) {
      expect(allowed('director', action, 'run')).toBe('refuse');
    }
  });
});
