/**
 * T281 (projects-design §14.4, §9.1, worked example §11 step 2 and 4):
 * the coordinator writes the plan and its contract, the operator approves
 * it from the inbox, both children get the contract in their brief, and a
 * contract bump tells its parties only. Real attach over `fake-agent.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import { type AgentId, type RoutedEvent, type Stream, ulid } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { VerbService } from '../attach/verbs';
import { makeEmitter } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { buildCockpitFrame } from '../feed/snapshot';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { buildBrief } from '../runner/brief';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ContractService } from './contracts';
import { PlanNotDraftError, PlanService, WAITING_FOR_PLAN } from './plans';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let scratch: string;
let store: StateStore;
let streams: StreamService;
let contracts: ContractService;
let plans: PlanService;
let verbs: VerbService;
let emitted: RoutedEvent[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-plans-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-plans-scratch-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  const events = new RoutedEventService(store);
  emitted = [];
  events.onEmitted((e) => emitted.push(e));
  const emit = makeEmitter(events, streams);
  contracts = new ContractService({ store, streams, emit });
  plans = new PlanService({ store, streams, contracts, emit });
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  verbs = new VerbService({ store, streams, questions, plans, contracts });
});

afterEach(async () => {
  await store.flush();
  store.close();
  for (const dir of [home, scratch]) rmSync(dir, { recursive: true, force: true });
});

/** A registered session on `stream`, as `runner/session.ts` registers one. */
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

/** §11: "Show sale prices" with api and web, plus a bystander child. */
async function saleTree() {
  const project = await new ProjectService(store, streams).create({ name: 'Shop' });
  const node = await streams.create('human', {
    title: 'Show sale prices',
    goal: 'g',
    project: project.id,
  });
  const child = (title: string) =>
    streams.create('human', { title, goal: 'g', project: project.id, parent: node.id });
  const api = await child('api: add salePrice');
  const web = await child('web: show salePrice');
  const docs = await child('docs: changelog');
  return { node, api, web, docs, coordinator: await session(node, 'coordinator') };
}

const CONTRACT_BODY = 'GET /price/:id returns { cents, saleCents? }';

describe('plans and contracts (T281)', () => {
  test('approving the plan gives both children the contract in their brief', async () => {
    const { node, api, web, docs, coordinator } = await saleTree();
    const contract = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /price/:id',
      body: CONTRACT_BODY,
      parties: [api.id, web.id],
    })) as { id: string; version: number };
    expect(contract.version).toBe(1);
    await verbs.planWrite({
      session: coordinator,
      owners: [
        { child: api.id, owns: ['prices.ts'] },
        { child: web.id, owns: ['shop.html'] },
        { child: docs.id, owns: ['CHANGELOG.md'] },
      ],
      contracts: [contract.id],
    });
    expect(plans.get(node.id)?.status).toBe('draft');
    expect(plans.childView(streams.get(api.id))).toBeUndefined();

    // The approval is an inbox card.
    const gates = new GateService(store);
    const questions = new QuestionService(store, streams, { deliver: async () => {} });
    const inbox = new InboxService({ streams, questions, gates, plans, contracts });
    const card = inbox.list().find((i) => i.kind === 'plan_approve');
    expect(card?.id).toBe(node.id);
    expect(card?.detail ?? card?.context).toContain(CONTRACT_BODY);

    const approved = await plans.approve(node.id, 'human');
    expect(approved).toMatchObject({ status: 'approved', version: 1, approved_by: 'human' });
    expect(inbox.list().some((i) => i.kind === 'plan_approve')).toBe(false);
    await expect(plans.approve(node.id)).rejects.toThrow(PlanNotDraftError);

    const planned = emitted.filter((e) => e.type === 'plan_changed');
    expect(planned.map((e) => e.routing.map((r) => r.node))).toEqual([
      [api.id],
      [web.id],
      [docs.id],
    ]);
    expect(planned[0]?.payload.paths).toEqual(['prices.ts']);

    // Real attach over the fake agent: each child's brief carries the contract.
    const attach = new AttachService({
      store,
      streams,
      home,
      plans,
      contracts,
      provider: () => {
        const script = join(scratch, 'script.json');
        writeFileSync(script, JSON.stringify({ steps: [{ type: 'end_turn' }] }));
        return {
          ...ACP_PROVIDERS.claude,
          command: 'bun',
          args: [FAKE_AGENT_PATH],
          envOverrides: { AGILE_FAKE_AGENT_SCRIPT: script },
        };
      },
    });
    try {
      for (const [child, owns] of [
        [api, 'prices.ts'],
        [web, 'shop.html'],
      ] as const) {
        const { session: s } = await attach.attach(child.id);
        const brief = readFileSync(join(home, 'sessions', s.id, 'brief.md'), 'utf8');
        expect(brief).toContain('## Your part of the plan');
        expect(brief).toContain(`\`${owns}\``);
        expect(brief).toContain(CONTRACT_BODY);
      }
      const { session: d } = await attach.attach(docs.id);
      const docsBrief = readFileSync(join(home, 'sessions', d.id, 'brief.md'), 'utf8');
      expect(docsBrief).toContain('`CHANGELOG.md`');
      expect(docsBrief).not.toContain(CONTRACT_BODY);
    } finally {
      await attach.stopAll();
    }
  }, 30_000);

  test('bumping a contract notifies its parties only', async () => {
    const { node, api, web, docs, coordinator } = await saleTree();
    const created = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /price/:id',
      body: CONTRACT_BODY,
      parties: [api.id, web.id],
    })) as { id: string };
    expect(emitted.filter((e) => e.type === 'contract_changed')).toEqual([]);

    const bumped = await contracts.write(
      node.id,
      {
        id: created.id,
        title: 'GET /price/:id',
        body: 'GET /price/:id returns { cents, saleCents?, saleEndsAt? }',
        parties: [api.id, web.id],
        reason: 'api needs the sale end',
      },
      `agent:${coordinator}`,
    );
    expect(bumped.version).toBe(2);
    expect(bumped.history).toMatchObject([{ version: 1, body: CONTRACT_BODY }]);

    const [changed] = emitted.filter((e) => e.type === 'contract_changed');
    const recipients = changed?.routing.map((r) => r.node).sort();
    expect(recipients).toEqual([node.id, api.id, web.id].sort());
    expect(recipients).not.toContain(docs.id);
    expect(changed?.payload).toMatchObject({ contract: created.id, version: 2 });

    // An unchanged body is not a bump.
    await contracts.write(
      node.id,
      { id: created.id, title: 'GET /price/:id', body: bumped.body, parties: [api.id, web.id] },
      'human',
    );
    expect(contracts.get(created.id).version).toBe(2);
    expect(emitted.filter((e) => e.type === 'contract_changed')).toHaveLength(1);
  });

  test('only a coordinator writes, and only about its own children', async () => {
    const { node, api, coordinator } = await saleTree();
    const worker = await session(api, 'worker');
    await expect(
      verbs.planWrite({ session: worker, owners: [{ child: api.id, owns: ['x'] }] }),
    ).rejects.toThrow('only a coordinator');
    await expect(
      verbs.contractWrite({ session: worker, title: 't', body: 'b', parties: [] }),
    ).rejects.toThrow('only a coordinator');
    const stranger = await streams.create('human', { title: 'elsewhere', goal: 'g' });
    await expect(
      verbs.planWrite({ session: coordinator, owners: [{ child: stranger.id, owns: ['x'] }] }),
    ).rejects.toThrow('is not a child');
    expect(plans.get(node.id)).toBeUndefined();

    // Re-writing an approved plan sends it back to draft for approval.
    await verbs.planWrite({ session: coordinator, owners: [{ child: api.id, owns: ['a.ts'] }] });
    await plans.approve(node.id);
    await verbs.planWrite({ session: coordinator, owners: [{ child: api.id, owns: ['b.ts'] }] });
    expect(plans.get(node.id)).toMatchObject({ status: 'draft', version: 1 });
  });

  test('a revision in draft leaves the children on the last approved plan until it is approved', async () => {
    const { node, api, web, coordinator } = await saleTree();
    const c1 = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /price/:id',
      body: CONTRACT_BODY,
      parties: [api.id, web.id],
    })) as { id: string };
    await verbs.planWrite({
      session: coordinator,
      owners: [
        { child: api.id, owns: ['prices.ts'] },
        { child: web.id, owns: ['shop.html'] },
      ],
      contracts: [c1.id],
    });
    await plans.approve(node.id);

    const c2 = (await verbs.contractWrite({
      session: coordinator,
      title: 'GET /sale/:id',
      body: 'GET /sale/:id returns { endsAt }',
      parties: [api.id],
    })) as { id: string };
    await verbs.planWrite({
      session: coordinator,
      owners: [
        { child: api.id, owns: ['prices.ts', 'sale.ts'] },
        { child: web.id, owns: ['shop.html'] },
      ],
      contracts: [c1.id, c2.id],
    });
    emitted.length = 0;
    const draftView = plans.childView(streams.get(api.id));
    expect(draftView?.version).toBe(1);
    expect(draftView?.owns).toEqual(['prices.ts']);
    expect(draftView?.contracts.map((c) => c.id)).toEqual([c1.id]);
    const draftBrief = buildBrief({
      role: 'worker',
      stream: streams.get(api.id),
      ancestors: [streams.get(node.id)],
      thread: [],
      docs: [],
      rules: [],
      ...(draftView ? { plan: draftView } : {}),
    });
    expect(draftBrief).toContain('`prices.ts`');
    expect(draftBrief).not.toContain('sale.ts');
    expect(draftBrief).not.toContain('endsAt');

    // The card reads as the change against v1.
    const questions = new QuestionService(store, streams, { deliver: async () => {} });
    const inbox = new InboxService({
      streams,
      questions,
      gates: new GateService(store),
      plans,
      contracts,
    });
    const card = inbox.list().find((i) => i.kind === 'plan_approve');
    expect(card?.detail ?? card?.context).toContain('owns prices.ts, sale.ts (was prices.ts)');

    await plans.approve(node.id);
    const view = plans.childView(streams.get(api.id));
    expect(view?.version).toBe(2);
    expect(view?.owns).toEqual(['prices.ts', 'sale.ts']);
    expect(view?.contracts.map((c) => c.id)).toEqual([c1.id, c2.id]);
    const changed = emitted.filter((e) => e.type === 'plan_changed');
    expect(changed.map((e) => e.routing.map((r) => r.node))).toEqual([[api.id], [web.id]]);
    expect(changed[0]?.payload.paths).toEqual(['prices.ts', 'sale.ts']);
  });
});

describe('T336: parts wait for the plan', () => {
  /** A node that has had its coordinator, and the plan service as the daemon wires it. */
  async function planned() {
    const started: string[] = [];
    plans = new PlanService({
      store,
      streams,
      contracts,
      start: async (id) => {
        started.push(id);
      },
    });
    const tree = await saleTree();
    await store.updateStream('daemon', tree.node.id, (before) => ({
      ...before,
      sessions: [
        { id: ulid(), vendor: 'claude', model: 'm', role: 'coordinator', status: 'stopped' },
      ],
    }));
    return { ...tree, started };
  }
  /** What the split writes on a part it makes to wait (repo-in-place.ts). */
  const splitWaits = (id: string) =>
    streams.appendThread('daemon', id, {
      kind: 'event',
      body: `${WAITING_FOR_PLAN}this part starts when "Show sale prices"'s plan is approved`,
    });

  test('approval starts each part it first gives paths to, and only those', async () => {
    const { node, api, web, docs, started } = await planned();
    for (const part of [api, web, docs]) await splitWaits(part.id);
    // web already ran and finished.
    await streams.update('daemon', web.id, { agent: { status: 'done' } });
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(true);
    expect(plans.waitingForPlan(streams.get(web.id))).toBe(false);
    // The cockpit row says so.
    const rows = buildCockpitFrame(streams, undefined, undefined, {}, undefined, (s) =>
      plans.waitingForPlan(s),
    ).streams;
    expect(rows.find((r) => r.id === api.id)?.waiting_for_plan).toBe(true);
    expect(rows.find((r) => r.id === web.id)?.waiting_for_plan).toBeUndefined();

    await plans.write(node.id, [
      { child: api.id, owns: ['prices.ts'] },
      { child: web.id, owns: ['shop.html'] },
    ]);
    expect(started).toEqual([]);
    await plans.approve(node.id);
    expect(started).toEqual([api.id]);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(false);

    // docs is in no approved plan yet: it still waits, and the change that gives it paths starts it.
    expect(plans.waitingForPlan(streams.get(docs.id))).toBe(true);
    await plans.setOwner(node.id, docs.id, ['CHANGELOG.md'], 'coordinator');
    expect(started).toEqual([api.id, docs.id]);
  });

  /** A session that ran on `id` and ended as `how` left it: the agent back to idle (attach's exit path). */
  const ranAndEnded = (id: string, how: 'detach' | 'stop', at = Date.now()) =>
    store.updateStream('daemon', id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'idle' },
      sessions: [
        ...before.sessions,
        {
          id: ulid(at),
          vendor: 'claude',
          model: 'm',
          role: 'worker',
          status: 'stopped',
          ...(how === 'stop' ? { ended_reason: 'stopped: moved' } : {}),
        },
      ],
    }));

  test('a part started after the split, then detached, no longer waits', async () => {
    const { api } = await planned();
    await splitWaits(api.id);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(true);
    await ranAndEnded(api.id, 'detach', Date.now() + 5);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(false);
  });

  test('a part started after the split, then stopped by the daemon, no longer waits', async () => {
    const { api } = await planned();
    await splitWaits(api.id);
    await ranAndEnded(api.id, 'stop', Date.now() + 5);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(false);
  });

  test("a first part carrying the node's older sessions still waits until it starts", async () => {
    const { api } = await planned();
    // The split moved the node's earlier sessions onto its first part, then wrote the line.
    await ranAndEnded(api.id, 'detach', Date.now() - 60_000);
    await ranAndEnded(api.id, 'stop', Date.now() - 30_000);
    await splitWaits(api.id);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(true);
    await ranAndEnded(api.id, 'detach', Date.now() + 5);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(false);
  });

  test('approval after a started part was detached does not start it again', async () => {
    const { node, api, web, started } = await planned();
    for (const part of [api, web]) await splitWaits(part.id);
    await ranAndEnded(api.id, 'detach', Date.now() + 5);
    await plans.write(node.id, [
      { child: api.id, owns: ['prices.ts'] },
      { child: web.id, owns: ['shop.html'] },
    ]);
    await plans.approve(node.id);
    expect(started).toEqual([web.id]);
  });

  test('a "Start later" child the plan names is not started (only split parts wait)', async () => {
    const { node, api, docs, started } = await planned();
    await splitWaits(api.id);
    // docs was made by the human with "Start later": no split line on its thread.
    expect(plans.waitingForPlan(streams.get(docs.id))).toBe(false);
    await plans.write(node.id, [
      { child: api.id, owns: ['prices.ts'] },
      { child: docs.id, owns: ['CHANGELOG.md'] },
    ]);
    await plans.approve(node.id);
    expect(started).toEqual([api.id]);
  });

  test('a child of a node that never had a coordinator is not waiting', async () => {
    const { api } = await saleTree();
    await splitWaits(api.id);
    expect(plans.waitingForPlan(streams.get(api.id))).toBe(false);
  });
});
