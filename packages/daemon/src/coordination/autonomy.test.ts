/**
 * T282 (projects-design §9 Autonomy, P12): the gate table over principal ×
 * action × level, and the coordinator's verbs through it: a proposal card
 * with Apply at Advise, applied with a thread line at Organise, routine
 * contract approvals at Run, and the node override over the project.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  type Autonomy,
  COORDINATOR_ACTIONS,
  DIRECTOR_NODE,
  HUMAN_ONLY_ACTIONS,
  type Stream,
  ulid,
} from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { makeEmitter } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  type ActOutcome,
  AutonomyService,
  ProposalClosedError,
  StaleProposalError,
  allowed,
  describeChange,
} from './autonomy';
import { ContractService } from './contracts';
import { PlanService } from './plans';

let home: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;
let contracts: ContractService;
let plans: PlanService;
let autonomy: AutonomyService;
let verbs: VerbService;
let inbox: InboxService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-autonomy-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
  contracts = new ContractService({ store, streams });
  plans = new PlanService({ store, streams, contracts });
  autonomy = new AutonomyService({ store, streams, plans, contracts });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  verbs = new VerbService({ store, streams, questions, plans, contracts, autonomy });
  inbox = new InboxService({
    streams,
    questions,
    gates: new GateService(store),
    proposals: autonomy,
  });
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

async function session(stream: Stream, role: 'worker' | 'coordinator'): Promise<string> {
  const id = ulid();
  await store.putAgent(id as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    stream: stream.id,
    last_seen: new Date().toISOString(),
    role,
  });
  return id;
}

async function shop(level?: Autonomy) {
  const project = await projects.create({ name: 'Shop' });
  if (level !== undefined) await projects.update(project.id, { autonomy: { coordinator: level } });
  const node = await streams.create('human', {
    title: 'Sale prices',
    goal: 'g',
    project: project.id,
  });
  const api = await streams.create('human', { title: 'api', goal: 'g', parent: node.id });
  const web = await streams.create('human', { title: 'web', goal: 'g', parent: node.id });
  return { project, node, api, web, coordinator: await session(node, 'coordinator') };
}

const LEVELS: Autonomy[] = ['advise', 'organise', 'run'];
const STRUCTURAL = COORDINATOR_ACTIONS.filter(
  (a) => a !== 'approve_contract' && a !== 'restart_node',
);

describe('allowed(principal, action, level)', () => {
  test('the table', () => {
    for (const level of LEVELS) {
      for (const action of [...COORDINATOR_ACTIONS, ...HUMAN_ONLY_ACTIONS]) {
        expect(allowed('human', action, level)).toBe('apply');
        expect(allowed('agent', action, level)).toBe('refuse');
      }
      for (const principal of ['coordinator', 'director'] as const) {
        for (const action of STRUCTURAL) {
          expect(allowed(principal, action, level)).toBe(level === 'advise' ? 'propose' : 'apply');
        }
        // P12: only a routine contract change, only at Run.
        expect(allowed(principal, 'approve_contract', level, { routine: true })).toBe(
          level === 'run' ? 'apply' : 'propose',
        );
        expect(allowed(principal, 'approve_contract', level)).toBe('propose');
        // T301 (§12): restarting stuck work is Run's.
        expect(allowed(principal, 'restart_node', level)).toBe(
          level === 'run' ? 'apply' : 'propose',
        );
        for (const action of HUMAN_ONLY_ACTIONS) {
          expect(allowed(principal, action, level)).toBe('refuse');
        }
      }
    }
  });
});

describe('coordinator verbs through the gate', () => {
  test('Advise: add_child becomes an inbox card; Apply creates the child', async () => {
    const { node, coordinator } = await shop();
    const out = (await verbs.addChild({
      session: coordinator,
      title: 'docs: changelog',
      goal: 'note the sale',
    })) as ActOutcome;
    expect(out.applied).toBe(false);
    expect(streams.list().some((s) => s.title === 'docs: changelog')).toBe(false);
    const card = inbox.list().find((i) => i.kind === 'proposal');
    expect(card?.stream).toBe(node.id);
    expect(card?.context).toContain('docs: changelog');

    const applied = await autonomy.apply(card?.id ?? '');
    expect(applied.status).toBe('applied');
    const child = streams.list().find((s) => s.title === 'docs: changelog');
    expect(child?.parent).toBe(node.id);
    expect(inbox.list().some((i) => i.kind === 'proposal')).toBe(false);
    await expect(autonomy.apply(card?.id ?? '')).rejects.toThrow(ProposalClosedError);
  });

  test('Organise: add_waits_on and set_owner apply with a thread line', async () => {
    const { node, api, web, coordinator } = await shop('organise');
    const out = (await verbs.addWaitsOn({
      session: coordinator,
      child: web.id,
      on: api.id,
    })) as ActOutcome;
    expect(out.applied).toBe(true);
    expect(streams.get(web.id).waits_on?.[0]).toMatchObject({
      node: api.id,
      added_by: 'coordinator',
    });
    await verbs.setOwner({ session: coordinator, child: api.id, owns: ['prices.ts'] });
    expect(plans.get(node.id)?.owners).toEqual([{ child: api.id, owns: ['prices.ts'] }]);
    const lines = streams.readThread(node.id).entries.map((e) => e.body);
    // T446 (audit r7 #6): the coordinator's own rows, in words.
    expect(lines).toContain('Linked web to wait on api');
    expect(lines).toContain('Set api to own prices.ts');
    expect(inbox.list().some((i) => i.kind === 'proposal')).toBe(false);
  });

  test('a node override beats the project level', async () => {
    const { node, api, web, coordinator } = await shop('organise');
    await streams.setAutonomy(node.id, 'advise');
    expect(autonomy.levelFor(node.id)).toBe('advise');
    const out = (await verbs.addWaitsOn({
      session: coordinator,
      child: web.id,
      on: api.id,
    })) as ActOutcome;
    expect(out.applied).toBe(false);
    await streams.setAutonomy(node.id, null);
    expect(autonomy.levelFor(node.id)).toBe('organise');
  });

  test('contract changes: routine applies only at Run; others come to you', async () => {
    const { node, api, web, coordinator } = await shop('organise');
    const created = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /price/:id',
      body: '{ cents }',
      parties: [api.id, web.id],
    })) as { id: string };
    const bump = {
      session: coordinator,
      id: created.id,
      title: 'GET /price/:id',
      parties: [api.id, web.id],
    };
    const routine = (await verbs.contractWrite({
      ...bump,
      body: '{ cents, saleCents? }',
      routine: true,
    })) as ActOutcome;
    expect(routine.applied).toBe(false);
    expect(contracts.get(created.id).version).toBe(1);

    const project = streams.get(node.id).project ?? '';
    await projects.update(project, { autonomy: { coordinator: 'run' } });
    const atRun = (await verbs.contractWrite({
      ...bump,
      body: '{ cents, saleCents? }',
      routine: true,
    })) as ActOutcome;
    expect(atRun.applied).toBe(true);
    expect(contracts.get(created.id).version).toBe(2);

    const rename = (await verbs.contractWrite({ ...bump, body: '{ price }' })) as ActOutcome;
    expect(rename.applied).toBe(false);
    expect(contracts.get(created.id).body).toBe('{ cents, saleCents? }');
  });

  test('a worker cannot use the coordinator verbs', async () => {
    const { api, web } = await shop('run');
    const worker = await session(api, 'worker');
    await expect(verbs.addWaitsOn({ session: worker, child: web.id, on: api.id })).rejects.toThrow(
      /only a coordinator/,
    );
  });

  test('Advise: a parties-only contract edit is a proposal, not applied', async () => {
    const { api, web, coordinator } = await shop();
    const created = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /price/:id',
      body: '{ cents }',
      parties: [api.id],
    })) as { id: string };
    const out = (await verbs.contractWrite({
      session: coordinator,
      id: created.id,
      title: 'GET /price/:id',
      body: '{ cents }',
      parties: [api.id, web.id],
    })) as ActOutcome;
    expect(out.applied).toBe(false);
    expect(contracts.get(created.id).parties).toEqual([api.id]);
    expect(inbox.list().some((i) => i.kind === 'proposal')).toBe(true);
  });

  test('Apply refuses a stale proposal: the child was reparented', async () => {
    const { node, api, web, coordinator } = await shop();
    const out = (await verbs.addWaitsOn({
      session: coordinator,
      child: web.id,
      on: api.id,
    })) as ActOutcome;
    const id = out.applied ? '' : out.proposal.id;
    const elsewhere = await streams.create('human', { title: 'other', goal: 'g', parent: api.id });
    await streams.update('human', web.id, { parent: elsewhere.id });
    await expect(autonomy.apply(id)).rejects.toThrow(StaleProposalError);
    await expect(autonomy.apply(id)).rejects.toThrow(/not a child/);
    expect(streams.get(web.id).waits_on).toBeUndefined();
    expect(autonomy.get(id).status).toBe('open');
    expect(node.id).toBeDefined();
  });
});

describe('T446: what an agent did on its own, in words and on the record', () => {
  let events: RoutedEventService;
  let recorded: AutonomyService;

  beforeEach(() => {
    events = new RoutedEventService(store);
    recorded = new AutonomyService({
      store,
      streams,
      plans,
      contracts,
      projects,
      emit: makeEmitter(events, streams),
    });
  });

  const applied = () => events.recent().filter((e) => e.type === 'autonomy_applied');

  test('describeChange reads as a proposal in words', () => {
    const title = (id: string) => (id === 'W' ? 'web' : id === 'A' ? 'api' : id);
    expect(
      describeChange(
        { action: 'add_child', title: 'Document sale prices', goal: 'Add a page', repo: 'docs' },
        title,
      ),
    ).toBe('Add a part "Document sale prices" on docs: Add a page');
    expect(describeChange({ action: 'add_waits_on', child: 'W', on: 'A' }, title)).toBe(
      'Make web wait on api',
    );
    expect(
      describeChange(
        {
          action: 'approve_contract',
          contract: 'C',
          title: 'Key file',
          body: 'Keys live in /etc/keys.',
          parties: [],
          routine: true,
          reason: 'additive',
        },
        title,
      ),
    ).toBe('Approve a routine change to Key file: Keys live in /etc/keys. Why: additive');
  });

  test('Organise: add_child is a coordinator row linked to the part, and a record that wakes nobody', async () => {
    const { project, node, coordinator } = await shop('organise');
    const root = project.root;
    const verbsHere = new VerbService({
      store,
      streams,
      questions: new QuestionService(store, streams, { deliver: async () => {} }),
      plans,
      contracts,
      autonomy: recorded,
    });
    const out = (await verbsHere.addChild({
      session: coordinator,
      title: 'Add an RSS field',
      goal: 'scheduled posts in the feed',
    })) as ActOutcome;
    expect(out.applied).toBe(true);
    const made = streams.list().find((s) => s.title === 'Add an RSS field') as Stream;
    const line = streams.readThread(node.id).entries.find((e) => e.body.startsWith('Added a node'));
    expect(line).toMatchObject({
      by: 'coordinator',
      kind: 'event',
      body: 'Added a node: "Add an RSS field"',
      ref: made.id,
    });
    const [event] = applied();
    expect(event?.subject).toBe(node.id);
    expect(event?.by).toBe(`agent:${coordinator}`);
    expect(event?.payload).toEqual({
      principal: 'coordinator',
      level: 'organise',
      action: 'add_child',
      summary: 'Add an RSS field',
      nodes: [made.id],
    });
    // The node, its ancestors (the project root); not the Director.
    expect(event?.routing).toEqual([
      { node: node.id, because: 'self' },
      { node: root, because: 'ancestor' },
    ]);
    // A record: on the Activity, never pending, so no digest or wake carries it.
    expect(events.pendingFor(node.id)).toEqual([]);
    expect(events.activityFor(node.id)[0]).toMatchObject({ status: 'recorded' });
  });

  test('Apply as the human: "You added a part", a record with the proposal', async () => {
    const { node } = await shop();
    const out = await recorded.act(node.id, 'coordinator', 'director', {
      action: 'add_child',
      title: 'Document sale prices',
      goal: 'Add a page',
    });
    expect(out.applied).toBe(false);
    const proposal = out.applied ? undefined : out.proposal;
    expect(proposal?.summary).toBe('Add a node "Document sale prices": Add a page');
    await recorded.apply(proposal?.id ?? '');
    const made = streams.list().find((s) => s.title === 'Document sale prices') as Stream;
    const last = streams.readThread(node.id).entries.at(-1);
    expect(last).toMatchObject({
      by: 'human',
      body: 'You added a node: "Document sale prices"',
      ref: made.id,
    });
    const [event] = applied();
    expect(event?.by).toBe('human');
    expect(event?.payload).toMatchObject({
      principal: 'human',
      level: 'advise',
      nodes: [made.id],
      proposal: proposal?.id,
    });
    expect(event?.routing.some((r) => r.node === DIRECTOR_NODE)).toBe(false);
  });

  test('Dismiss reads "You dismissed", and records nothing', async () => {
    const { node, api, web } = await shop();
    const out = await recorded.act(node.id, 'coordinator', 'director', {
      action: 'add_waits_on',
      child: web.id,
      on: api.id,
    });
    const id = out.applied ? '' : out.proposal.id;
    await recorded.dismiss(id);
    expect(streams.readThread(node.id).entries.at(-1)?.body).toBe(
      'You dismissed: Make web wait on api',
    );
    expect(applied()).toEqual([]);
  });

  test("the Director's create_tree: its own row, on the Director's feed and the tree's", async () => {
    const project = await projects.create({ name: 'Blog' });
    await projects.update(project.id, { autonomy: { director: 'organise' } });
    const out = await recorded.act(DIRECTOR_NODE, 'director', 'director', {
      action: 'create_tree',
      tree: {
        project: project.id,
        title: 'Newsletter signup',
        goal: 'a signup form',
        parts: [
          { title: 'Form', goal: 'the form' },
          { title: 'List', goal: 'the list', after: [0] },
        ],
      },
    });
    expect(out.applied).toBe(true);
    const node = streams.list().find((s) => s.title === 'Newsletter signup') as Stream;
    const line = store.readDirectorThread().at(-1);
    expect(line).toMatchObject({
      by: 'director',
      kind: 'event',
      body: 'Created "Newsletter signup" in Blog with 2 parts',
      ref: node.id,
    });
    const [event] = applied();
    expect(event?.subject).toBe(node.id);
    expect(event?.by).toBe('director');
    expect(event?.payload.summary).toBe('Newsletter signup in Blog with 2 parts');
    expect((event?.payload.nodes as string[])[0]).toBe(node.id);
    expect(event?.payload.nodes).toHaveLength(3);
    expect(event?.routing).toContainEqual({ node: DIRECTOR_NODE, because: 'self' });
    expect(events.pendingFor(DIRECTOR_NODE)).toEqual([]);
    expect(events.activityFor(DIRECTOR_NODE)[0]?.status).toBe('recorded');
  });
});

describe('T443: what an applied change creates runs', () => {
  let started: string[];
  beforeEach(() => {
    started = [];
    autonomy.setAgents({
      start: async (node) => {
        started.push(node);
      },
      restart: async () => {},
    });
  });
  const waitsForPlan = (id: string) =>
    streams.readThread(id).entries.some((e) => e.body.startsWith('waiting for the plan: '));

  test('Organise: add_child starts the child at once', async () => {
    const { node, coordinator } = await shop('organise');
    const out = (await verbs.addChild({
      session: coordinator,
      title: 'Research time zones',
      goal: 'g',
    })) as ActOutcome;
    expect(out.applied).toBe(true);
    await autonomy.settled();
    const child = streams.list().find((s) => s.title === 'Research time zones');
    expect(child?.parent).toBe(node.id);
    expect(started).toEqual([child?.id ?? '']);
  });

  test('Advise: nothing starts until you apply; Apply creates and starts it', async () => {
    const { coordinator } = await shop('advise');
    const out = (await verbs.addChild({
      session: coordinator,
      title: 'Docs',
      goal: 'g',
    })) as ActOutcome;
    expect(out.applied).toBe(false);
    expect(started).toEqual([]);
    if (out.applied) return;
    await autonomy.apply(out.proposal.id);
    await autonomy.settled();
    const child = streams.list().find((s) => s.title === 'Docs');
    expect(started).toEqual([child?.id ?? '']);
  });

  test('while the plan waits for you, a part waits for it; a conversation still starts', async () => {
    const { node, api, coordinator } = await shop('organise');
    await store.putRepos({ demo: { path: home, protected_branches: ['main'] } });
    await plans.write(node.id, [{ child: api.id, owns: ['src/**'] }]);
    expect(plans.get(node.id)?.status).toBe('draft');
    await verbs.addChild({ session: coordinator, title: 'Web part', goal: 'g', repo: 'demo' });
    await verbs.addChild({ session: coordinator, title: 'Ask about zones', goal: 'g' });
    await autonomy.settled();
    const part = streams.list().find((s) => s.title === 'Web part');
    const talk = streams.list().find((s) => s.title === 'Ask about zones');
    expect(waitsForPlan(part?.id ?? '')).toBe(true);
    expect(started).toEqual([talk?.id ?? '']);
  });

  test('start_node leaves a node that is already running as it is', async () => {
    const { node, api } = await shop('organise');
    await streams.update('daemon', api.id, {});
    const running = await streams.get(api.id);
    await store.updateStream('daemon', api.id, (s) => ({
      ...s,
      sessions: [
        ...running.sessions,
        {
          id: ulid(),
          role: 'worker',
          vendor: 'claude',
          model: 'sonnet',
          effort: 'low',
          status: 'running',
        },
      ],
    }));
    const out = (await autonomy.act(node.id, 'coordinator', 'agent:x', {
      action: 'start_node',
      node: api.id,
    })) as ActOutcome;
    expect(out.applied).toBe(true);
    if (out.applied) expect(out.result).toEqual({ node: api.id, already: true });
    expect(started).toEqual([]);
  });
});
