/**
 * T286 (projects-design §9.5): the currency example with a scripted (fake)
 * agent on each node. api asks web about currency, web answers, they
 * propose "add currency" together, the parent approves it at Run and both
 * are told. Real router and event log; no vendor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { makeEmitter } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { type ActOutcome, AutonomyService } from './autonomy';
import { ContractService } from './contracts';
import { PlanService } from './plans';
import { SiblingService } from './siblings';

let home: string;
let store: StateStore;
let streams: StreamService;
let events: RoutedEventService;
let contracts: ContractService;
let verbs: VerbService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-siblings-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  events = new RoutedEventService(store);
  const emit = makeEmitter(events, streams);
  contracts = new ContractService({ store, streams, emit });
  const plans = new PlanService({ store, streams, contracts });
  const autonomy = new AutonomyService({ store, streams, plans, contracts });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  const siblings = new SiblingService({ streams, emit, events });
  verbs = new VerbService({ store, streams, questions, plans, contracts, autonomy, siblings });
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

async function shop() {
  const project = await new ProjectService(store, streams).create({ name: 'Shop' });
  await new ProjectService(store, streams).update(project.id, {
    autonomy: { coordinator: 'run' },
  });
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

const types = (node: string) => events.activityFor(node).map((a) => a.event.type);
const said = (node: string, text: string) =>
  streams.readThread(node).entries.some((e) => e.body.includes(text));

describe('ask sibling (§9.5 currency example)', () => {
  test('ask, reply, joint proposal, parent approves, both told', async () => {
    const s = await shop();
    const { ask } = (await verbs.askSibling({
      session: s.apiAgent,
      node: s.web.id,
      question: 'do you want currency in the response, or a formatted string?',
    })) as { ask: string };
    // The exchange is on both threads; web and the parent get the event.
    expect(said(s.api.id, 'do you want currency')).toBe(true);
    expect(said(s.web.id, 'do you want currency')).toBe(true);
    expect(types(s.web.id)).toContain('sibling_ask');
    expect(types(s.node.id)).toContain('sibling_ask');

    // Not agreed yet: a joint proposal is refused.
    await expect(
      verbs.proposeContract({
        session: s.apiAgent,
        contract: s.contract.id,
        body: 'returns { cents, saleCents?, currency }',
        reason: 'add currency',
        with: [s.web.id],
      }),
    ).rejects.toThrow('has not agreed');

    // Only the asked sibling can answer.
    await expect(
      verbs.replySibling({ session: s.apiAgent, ask, body: 'send currency' }),
    ).rejects.toThrow('not a question to you');
    await verbs.replySibling({ session: s.webAgent, ask, body: "send currency, I'll format it" });
    expect(said(s.api.id, "I'll format it")).toBe(true);
    expect(said(s.web.id, "I'll format it")).toBe(true);
    expect(types(s.api.id)).toContain('sibling_reply');
    expect(types(s.node.id)).toContain('sibling_reply');

    const proposal = (await verbs.proposeContract({
      session: s.apiAgent,
      contract: s.contract.id,
      body: 'returns { cents, saleCents?, currency }',
      reason: 'add currency; web formats it',
      routine: true,
      with: [s.web.id],
    })) as { id: string; from: string[] };
    expect(proposal.from).toEqual([s.api.id, s.web.id]);
    expect(types(s.node.id)).toContain('contract_proposal');

    const outcome = (await verbs.decideContract({
      session: s.coordinator,
      proposal: proposal.id,
      decision: 'approve',
      routine: true,
    })) as ActOutcome;
    expect(outcome.applied).toBe(true);
    expect(contracts.get(s.contract.id).body).toContain('currency');
    for (const child of [s.api.id, s.web.id]) {
      expect(types(child)).toContain('contract_changed');
      const note = events
        .activityFor(child)
        .find((a) => a.event.type === 'coordinator_note')?.event;
      expect(String(note?.payload.body)).toContain('approved');
    }
  });

  test('a non-sibling cannot be asked', async () => {
    const s = await shop();
    const other = await streams.create('human', { title: 'other', goal: 'g' });
    await expect(
      verbs.askSibling({ session: s.apiAgent, node: other.id, question: 'q' }),
    ).rejects.toThrow('not a sibling');
    await expect(
      verbs.askSibling({ session: s.apiAgent, node: s.api.id, question: 'q' }),
    ).rejects.toThrow('not a sibling');
  });
});
