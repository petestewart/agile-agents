/**
 * T484 (design/model-routing.md §6): the escalation watcher on its own, over
 * a real store with sessions written as a start would leave them. The starts
 * themselves (a step taken, its line and event, a resting session ended) are
 * attach's tests with the fake agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Effort,
  type ModelPolicyPartial,
  type RoutedEvent,
  type Stream,
  ulid,
} from '@agile-agents/shared';
import { routeAndEmit } from '../events/router';
import { RoutedEventService } from '../events/service';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { StepUpRefusedError } from './escalation';
import { ModelPolicyService } from './policy';
import { buildModelPolicyRpcMethods } from './rpc';

const PRESETS = [
  { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
  { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
  { vendor: 'claude' as const, model: 'claude-opus-5-5' },
];

let home: string;
let store: StateStore;
let streams: StreamService;
let events: RoutedEventService;
let routing: ModelPolicyService;
let ended: Array<{ node: string; why: string }>;

function build(): ModelPolicyService {
  return new ModelPolicyService({
    store,
    streams,
    emitRouted: (input) => routeAndEmit(events, input, streams.list({ include_archived: true })),
    endResting: async (node, why) => {
      ended.push({ node, why });
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-escalation-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  events = new RoutedEventService(store);
  ended = [];
  routing = build();
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

let projects = 0;
async function nodeUnder(policy: ModelPolicyPartial, title = 'Parser'): Promise<Stream> {
  projects += 1;
  const project = await new ProjectService(store, streams).create({ name: `Esc ${projects}` });
  await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
  return streams.create('human', { title, goal: 'parse the CSV', project: project.id });
}

/** What a start leaves: a worker session on this model (ended, as after its turn). */
async function ran(id: string, model: string, effort?: Effort): Promise<string> {
  const session = ulid();
  await store.updateStream('daemon', id, (s) => ({
    ...s,
    sessions: [
      ...s.sessions,
      {
        id: session,
        vendor: 'claude',
        model,
        role: 'worker',
        status: 'stopped',
        ...(effort !== undefined ? { effort } : {}),
      },
    ],
  }));
  return session;
}

function lines(id: string): string[] {
  return streams.readThread(id, { limit: 200 }).entries.map((e) => e.body);
}

function escalations(id: string): RoutedEvent[] {
  return events
    .activityFor(id)
    .map((a) => a.event)
    .filter((e) => e.type === 'model_escalated');
}

describe('T484: triggers record a pending step for the next start', () => {
  test('start cheap: a trigger waits for the next start, ends a resting session, and survives a restart', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'high' });
    await ran(node.id, 'claude-sonnet-5-5', 'medium');
    const outcome = await routing.escalation.turnFailed(node.id, 'the vendor said no');
    expect(outcome).toEqual({
      status: 'pending',
      to: { vendor: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    });
    expect(streams.get(node.id).escalation?.pending).toMatchObject({
      trigger: 'turn_failed',
      reason: 'a turn failed (the vendor said no)',
      by: 'daemon',
    });
    expect(ended).toEqual([
      {
        node: node.id,
        why: 'its model steps up at the next start (a turn failed (the vendor said no))',
      },
    ]);
    // One step per start: a second trigger waits behind it.
    expect(
      (await routing.escalation.asked(node.id, ulid(), 'still failing')).startsWith(
        'A step up already waits',
      ),
    ).toBe(true);
    // A new daemon (a new service over the same home) sees the same step.
    const again = build();
    expect(again.nodeView(node.id).step_up.pending).toMatchObject({
      trigger: 'turn_failed',
      to: 'Claude Sonnet 5.5 · high',
    });
    // The composer names what the next start runs: the step, not the kept pick.
    expect(routing.nextPick(streams.get(node.id))).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      how: 'escalation',
    });
    // Nothing was stepped yet: no event, no line (that happens at the start).
    expect(escalations(node.id)).toHaveLength(0);
  });

  test('a merge refused twice for the same reason, with a turn between, is a trigger; a new reason starts again', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const session = await ran(node.id, 'claude-sonnet-5-5', 'medium');
    const turn = () => routing.escalation.turnEnded(node.id, { session, worker: true });
    // Refused, then refused again with no turn between: not yet.
    expect(
      await routing.escalation.mergeRefused(node.id, 'ship:K-1', 'ship check: tests fail'),
    ).toBeUndefined();
    expect(
      await routing.escalation.mergeRefused(node.id, 'ship:K-1', 'ship check: tests fail'),
    ).toBeUndefined();
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    // A different reason starts the count again.
    await turn();
    expect(
      await routing.escalation.mergeRefused(
        node.id,
        'conflict:main',
        'the merge conflicted in a.ts',
      ),
    ).toBeUndefined();
    expect(streams.get(node.id).escalation?.refusal).toMatchObject({
      key: 'conflict:main',
      turns: 0,
    });
    // A turn that tried to fix it, then the same conflict: stepped.
    await turn();
    const outcome = await routing.escalation.mergeRefused(
      node.id,
      'conflict:main',
      'the merge conflicted in a.ts',
    );
    expect(outcome?.status).toBe('pending');
    const after = streams.get(node.id).escalation;
    expect(after?.pending?.reason).toBe(
      'the merge was refused twice (the merge conflicted in a.ts)',
    );
    expect(after?.refusal).toBeUndefined();
  });

  test('the context past 90% without goal_met, once per session', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const session = await ran(node.id, 'claude-sonnet-5-5', 'medium');
    // 90% exactly is not past it.
    await routing.escalation.turnEnded(node.id, {
      session,
      worker: false,
      context: { used: 900, size: 1000 },
    });
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    const full = await routing.escalation.turnEnded(node.id, {
      session,
      worker: false,
      context: { used: 950, size: 1000 },
    });
    expect(full?.status).toBe('pending');
    expect(streams.get(node.id).escalation).toMatchObject({
      pending: {
        trigger: 'context_full',
        reason: 'its context passed 90% before the goal was met',
      },
      context: session,
    });
  });

  test('a goal met in that session is no stall', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const session = await ran(node.id, 'claude-sonnet-5-5', 'medium');
    await streams.update('agent', node.id, {
      agent: { goal_met: { session, at: new Date().toISOString(), summary: 'done' } },
    });
    expect(
      await routing.escalation.turnEnded(node.id, {
        session,
        worker: true,
        head: 'abc',
        context: { used: 990, size: 1000 },
      }),
    ).toBeUndefined();
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
  });

  test('three quiet worker turns (no new commit, no progress) are a stall; a commit or progress resets', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const session = await ran(node.id, 'claude-sonnet-5-5', 'medium');
    const turn = (head: string) =>
      routing.escalation.turnEnded(node.id, { session, worker: true, head });
    await routing.escalation.baseline(node.id, 'h0');
    await turn('h0');
    await turn('h0');
    expect(streams.get(node.id).escalation?.quiet).toEqual({ turns: 2, head: 'h0' });
    // A commit resets it.
    await turn('h1');
    expect(streams.get(node.id).escalation?.quiet?.turns).toBe(0);
    await turn('h1');
    // A progress call resets it.
    await routing.escalation.progressed(node.id);
    await turn('h1');
    expect(streams.get(node.id).escalation?.quiet?.turns).toBe(0);
    await turn('h1');
    await turn('h1');
    // No worktree (a conversation, a coordinator): never counted.
    await routing.escalation.turnEnded(node.id, { session, worker: false });
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    const third = await turn('h1');
    expect(third?.status).toBe('pending');
    expect(streams.get(node.id).escalation?.pending?.reason).toBe(
      '3 turns passed with no commit and no progress',
    );
  });

  test('the Default model choice never steps on its own; the operator still can', async () => {
    const node = await nodeUnder({ mode: 'default', presets: [] });
    await ran(node.id, 'claude-sonnet-5-5', 'medium');
    expect(await routing.escalation.turnFailed(node.id, 'x')).toMatchObject({ status: 'off' });
    expect(streams.get(node.id).escalation).toBeUndefined();
    await routing.stepUp(node.id);
    expect(streams.get(node.id).escalation?.pending).toMatchObject({
      trigger: 'operator',
      by: 'human',
      reason: 'you asked for a stronger model',
    });
  });
});

describe('T484: the top of the ladder, and Strongest first', () => {
  test('start cheap at the top: Needs me with the reason, once, and a record-only event; Step up refused', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'medium' });
    await ran(node.id, 'claude-opus-5-5', 'medium');
    const inbox = new InboxService({
      streams,
      questions: new QuestionService(store, streams, { deliver: async () => {} }),
      gates: new GateService(store),
    });
    expect(inbox.list()).toHaveLength(0);
    expect(await routing.escalation.asked(node.id, ulid(), 'the tests still fail')).toContain(
      'strongest preset model',
    );
    const card = inbox.list().find((i) => i.kind === 'model_stuck');
    expect(card).toMatchObject({
      id: node.id,
      stream: node.id,
      context:
        'Parser is stuck on the strongest preset model: the agent asked: the tests still fail',
    });
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    expect(lines(node.id)).toContain(
      'Parser is stuck on the strongest preset model: the agent asked: the tests still fail',
    );
    const [event] = escalations(node.id);
    expect(event?.payload).toMatchObject({
      step: 'stuck',
      trigger: 'asked',
      from: 'Claude Opus 5.5 · medium',
    });
    // Once: a second trigger doesn't add a card, line or event.
    await routing.escalation.turnFailed(node.id, 'again');
    expect(escalations(node.id)).toHaveLength(1);
    expect(inbox.list().filter((i) => i.kind === 'model_stuck')).toHaveLength(1);
    // Step up says why not.
    expect(routing.nodeView(node.id).step_up.blocked).toBe(
      'Claude Opus 5.5 · medium is the top of the ladder: no preset model is stronger.',
    );
    await expect(routing.stepUp(node.id)).rejects.toBeInstanceOf(StepUpRefusedError);
    // Dismissed: gone from Needs me.
    await routing.dismissStuck(node.id);
    expect(inbox.list().filter((i) => i.kind === 'model_stuck')).toHaveLength(0);
  });

  test('strongest first never steps: the same triggers go to Needs me; Step up is refused', async () => {
    const node = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      escalation: 'strongest_first',
    });
    await ran(node.id, 'claude-opus-5-5', 'high');
    expect((await routing.escalation.turnFailed(node.id, 'boom')).status).toBe('stuck');
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    expect(streams.get(node.id).escalation?.stuck).toMatchObject({
      trigger: 'turn_failed',
      model: 'Claude Opus 5.5 · high',
    });
    // Even on a model that isn't the strongest: Strongest first stays put.
    const low = await nodeUnder(
      { mode: 'choose', presets: PRESETS, escalation: 'strongest_first' },
      'Other',
    );
    await ran(low.id, 'claude-haiku-4-5', 'low');
    expect((await routing.escalation.turnFailed(low.id, 'boom')).status).toBe('stuck');
    await expect(routing.stepUp(low.id)).rejects.toThrow(/Strongest first never steps up/);
  });

  test('Step up needs a started agent and an open node; policy.step_up maps a refusal to a param error', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    await expect(routing.stepUp(node.id)).rejects.toThrow(/hasn’t started yet/);
    const rpc = buildModelPolicyRpcMethods(routing);
    await expect(rpc['policy.step_up']?.({ node: node.id })).rejects.toThrow(/hasn’t started/);
    await ran(node.id, 'claude-haiku-4-5', 'max');
    const view = (await rpc['policy.step_up']?.({ node: node.id })) as {
      step_up: { pending?: { to?: string; by: string } };
    };
    // Haiku at max (over the ceiling of what ships, max) is its top: the next model.
    expect(view.step_up.pending).toMatchObject({ by: 'human', to: 'Claude Sonnet 5.5 · max' });
    expect(lines(node.id)).toContain(
      'the operator asked for a stronger model: the next start of this node’s agent runs Claude Sonnet 5.5 · max',
    );
    // Pressing it again is a no-op.
    await rpc['policy.step_up']?.({ node: node.id });
    expect(
      lines(node.id).filter((l) => l.startsWith('the operator asked for a stronger')),
    ).toHaveLength(1);
    await streams.close('human', node.id);
    expect(routing.nodeView(node.id).step_up.blocked).toBe('This node is closed.');
  });
});
