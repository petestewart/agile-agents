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
  HUMAN_ONLY_ACTIONS,
  type Stream,
  ulid,
} from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
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
const STRUCTURAL = COORDINATOR_ACTIONS.filter((a) => a !== 'approve_contract');

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
    expect(lines).toContain('coordinator (organise) applied: web waits on api');
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
