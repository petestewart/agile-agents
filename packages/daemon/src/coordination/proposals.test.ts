/**
 * T285 (projects-design §9.1, §14.4): contract proposals. The worked
 * example with a scripted (fake) agent on each node: api proposes
 * `saleEndsAt`; at Run the coordinator approves it as routine and web gets
 * `contract_changed`; at Organise the same proposal becomes an inbox card.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Autonomy, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import type { RouteEmitInput } from '../events/router';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { type ActOutcome, AutonomyService } from './autonomy';
import { ContractService } from './contracts';
import { PlanService } from './plans';

let home: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;
let contracts: ContractService;
let autonomy: AutonomyService;
let verbs: VerbService;
let inbox: InboxService;
let emitted: RouteEmitInput[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-proposals-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
  emitted = [];
  contracts = new ContractService({
    store,
    streams,
    emit: async (input) => {
      emitted.push(input);
      return undefined;
    },
  });
  const plans = new PlanService({ store, streams, contracts });
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

async function shop(level: Autonomy) {
  const project = await projects.create({ name: 'Shop' });
  await projects.update(project.id, { autonomy: { coordinator: level } });
  const node = await streams.create('human', {
    title: 'Sale prices',
    goal: 'g',
    project: project.id,
  });
  const api = await streams.create('human', { title: 'api', goal: 'g', parent: node.id });
  const web = await streams.create('human', { title: 'web', goal: 'g', parent: node.id });
  const contract = await contracts.write(
    node.id,
    { title: 'GET /price/:id', body: 'returns { cents, saleCents? }', parties: [api.id, web.id] },
    'human',
  );
  return {
    node,
    api,
    web,
    contract,
    coordinator: await session(node, 'coordinator'),
    apiAgent: await session(api, 'worker'),
    webAgent: await session(web, 'worker'),
  };
}

const SALE_ENDS = 'returns { cents, saleCents?, saleEndsAt? }';

async function apiProposes(s: Awaited<ReturnType<typeof shop>>) {
  return (await verbs.proposeContract({
    session: s.apiAgent,
    contract: s.contract.id,
    body: SALE_ENDS,
    reason: 'the sale badge needs an end date',
    routine: true,
  })) as { id: string; status: string };
}

describe('propose_contract', () => {
  test('lands open on the contract and wakes the parent with contract_proposal', async () => {
    const s = await shop('run');
    const proposal = await apiProposes(s);
    expect(proposal.status).toBe('open');
    expect(contracts.get(s.contract.id).proposals?.map((p) => p.id)).toEqual([proposal.id]);
    const event = emitted.find((e) => e.type === 'contract_proposal');
    expect(event?.subject).toBe(s.node.id);
    expect(event?.payload).toMatchObject({ contract: s.contract.id, children: [s.api.id] });
    expect(streams.readThread(s.node.id).entries.some((e) => e.kind === 'proposal')).toBe(true);
  });

  test('a co-signer who never agreed is refused; a stranger or a non-party is refused', async () => {
    const s = await shop('run');
    await expect(
      verbs.proposeContract({
        session: s.apiAgent,
        contract: s.contract.id,
        body: SALE_ENDS,
        reason: 'agreed with web',
        with: [s.web.id],
      }),
    ).rejects.toThrow('has not agreed');
    const other = await streams.create('human', { title: 'other', goal: 'g' });
    await expect(
      verbs.proposeContract({
        session: await session(other, 'worker'),
        contract: s.contract.id,
        body: SALE_ENDS,
        reason: 'r',
      }),
    ).rejects.toThrow('not a child');
    const docs = await streams.create('human', { title: 'docs', goal: 'g', parent: s.node.id });
    await expect(
      verbs.proposeContract({
        session: await session(docs, 'worker'),
        contract: s.contract.id,
        body: SALE_ENDS,
        reason: 'r',
      }),
    ).rejects.toThrow('not a party');
  });

  test('only the owning coordinator decides', async () => {
    const s = await shop('run');
    const proposal = await apiProposes(s);
    await expect(
      verbs.decideContract({ session: s.webAgent, proposal: proposal.id, decision: 'approve' }),
    ).rejects.toThrow('only a coordinator');
  });
});

describe('decide_contract', () => {
  test('at Run a routine approval bumps the version and web gets contract_changed', async () => {
    const s = await shop('run');
    const proposal = await apiProposes(s);
    const outcome = (await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'approve',
      routine: true,
    })) as ActOutcome;
    expect(outcome.applied).toBe(true);
    const after = contracts.get(s.contract.id);
    expect(after.version).toBe(2);
    expect(after.body).toBe(SALE_ENDS);
    expect(after.proposals ?? []).toEqual([]);
    const changed = emitted.find((e) => e.type === 'contract_changed');
    expect(changed?.parties).toContain(s.web.id);
    expect(changed?.payload).toMatchObject({ contract: s.contract.id, version: 2 });
    expect(inbox.list().some((i) => i.kind === 'proposal')).toBe(false);
    const note = emitted.find((e) => e.type === 'coordinator_note' && e.subject === s.api.id);
    expect(String(note?.payload.body)).toContain('approved');
  });

  test('at Run a change the coordinator does not call routine goes to the inbox', async () => {
    const s = await shop('run');
    const proposal = await apiProposes(s);
    const outcome = (await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'approve',
    })) as ActOutcome;
    expect(outcome.applied).toBe(false);
  });

  test('at Organise the same proposal goes to the inbox; Apply bumps it', async () => {
    const s = await shop('organise');
    const proposal = await apiProposes(s);
    const outcome = (await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'approve',
      routine: true,
    })) as ActOutcome;
    expect(outcome.applied).toBe(false);
    expect(contracts.get(s.contract.id).version).toBe(1);
    expect(contracts.get(s.contract.id).proposals?.[0]?.status).toBe('asked_human');
    expect(emitted.some((e) => e.type === 'contract_changed')).toBe(false);
    const card = inbox.list().find((i) => i.kind === 'proposal');
    expect(card).toBeDefined();
    if (outcome.applied) throw new Error('unreachable');
    await autonomy.apply(outcome.proposal.id);
    const after = contracts.get(s.contract.id);
    expect(after.version).toBe(2);
    expect(after.proposals ?? []).toEqual([]);
    expect(emitted.find((e) => e.type === 'contract_changed')?.parties).toContain(s.web.id);
  });

  test('dismissing the card rejects the proposal', async () => {
    const s = await shop('organise');
    const proposal = await apiProposes(s);
    const outcome = (await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'approve',
    })) as ActOutcome;
    if (outcome.applied) throw new Error('expected a card');
    await autonomy.dismiss(outcome.proposal.id);
    expect(contracts.get(s.contract.id).proposals ?? []).toEqual([]);
    expect(contracts.get(s.contract.id).version).toBe(1);
  });

  test('reject drops it with a reason on the proposer’s thread', async () => {
    const s = await shop('run');
    const proposal = await apiProposes(s);
    await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'reject',
      reason: 'send a formatted string instead',
    });
    expect(contracts.get(s.contract.id).proposals ?? []).toEqual([]);
    expect(contracts.get(s.contract.id).version).toBe(1);
    expect(
      streams.readThread(s.api.id).entries.some((e) => e.body.includes('send a formatted string')),
    ).toBe(true);
    const note = emitted.find((e) => e.type === 'coordinator_note' && e.subject === s.api.id);
    expect(String(note?.payload.body)).toContain('rejected');
  });
});
