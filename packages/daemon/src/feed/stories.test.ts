/**
 * T044: per-ticket stories and the Team roster — the two derived views the
 * Sprint tab renders. Both read only state the daemon already writes, so
 * every fixture here goes in through the real verbs (`transitionTicket`,
 * `appendStanza`, `putEntity`, `Bus.send`, `deleteAgent`).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, validateMessage } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { StateStore } from '../store';
import { StreamService } from '../streams';
import { buildTeam } from './snapshot';
import { buildStories } from './stories';

let repo: string;
let store: StateStore;
let stateRoot: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-stories-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(init.stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function seedTicket(id = 'TKT-0001'): Promise<void> {
  await store.putTicket({
    id,
    title: 'Add Ledger.transfer between accounts',
    status: 'draft',
    contract: {
      inputs: [],
      outputs: [],
      acceptance: ['transfers two accounts'],
      done: [],
      env: 'clone',
    },
    depends: [],
    oracle_refs: [],
    kb_refs: [],
    history: [],
    security: false,
  });
}

test('a ticket that was built, reviewed and accepted reads as one timestamped story', async () => {
  await seedTicket();
  const bus = new Bus(store, stateRoot);
  await store.transitionTicket('TKT-0001', 'ready', { by: 'architect' });
  await store.transitionTicket('TKT-0001', 'assigned', { by: 'em' });
  await store.transitionTicket('TKT-0001', 'in_progress', { by: 'eng-0001' });
  await store.appendStanza({
    ts: new Date().toISOString(),
    ticket: 'TKT-0001',
    agent: 'eng-0001',
    kind: 'done',
    summary: '+61 −0 in 2 files · 6 new tests pass',
  });
  await store.transitionTicket('TKT-0001', 'in_review', { by: 'eng-0001' });
  await store.putEntity(reviewRecordRelPath('TKT-0001', 1, 'primary'), validateReviewRecord, {
    ticket: 'TKT-0001',
    round: 1,
    pass: 'primary',
    agent: 'reviewer-0001',
    ts: new Date().toISOString(),
    findings: [],
    verdict: 'approve',
    hunks: [],
  });
  // The reviewer's own words, on the ticket's bus thread, keyed to the
  // record by `refs` — this is what the story quotes.
  await bus.send({
    id: ulid(),
    ts: new Date().toISOString(),
    from: 'reviewer-0001',
    to: ['eng-0001'],
    kind: 'review_verdict',
    priority: 'normal',
    ticket: 'TKT-0001',
    body: 'round 1: approve — validation happens before either write',
    refs: [reviewRecordRelPath('TKT-0001', 1, 'primary')],
    requires_ack: false,
  });
  await store.transitionTicket('TKT-0001', 'in_qa', { by: 'reviewer-0001' });

  const [story] = buildStories(store);
  expect(story?.ticket).toBe('TKT-0001');
  expect(story?.status).toBe('in_qa');
  expect(story?.stage.label).toBe('In QA');

  const rendered = story?.steps.map((s) => `${s.headline ?? ''} ${s.text}`) ?? [];
  expect(rendered.some((line) => line.startsWith('Built'))).toBe(true);
  expect(rendered.some((line) => line.includes('Review approved'))).toBe(true);
  // The verdict is quoted from the reviewer's message, not paraphrased.
  expect(rendered.some((line) => line.includes('validation happens before either write'))).toBe(
    true,
  );
  // The trailing "what is happening now" line.
  expect(story?.steps[story.steps.length - 1]?.tone).toBe('now');
  expect(story?.steps[story.steps.length - 1]?.text).toContain('QA running');

  // Steps are in timestamp order.
  const timestamps = story?.steps.map((s) => s.ts) ?? [];
  expect([...timestamps].sort()).toEqual(timestamps);
});

// T121: gates and questions are keyed to streams, not tickets, so a ticket
// story can no longer claim either of them. T122 deletes this module.
test('a pending gate and an open question no longer attach to a ticket story', async () => {
  await seedTicket();
  const gates = new GateService(store);
  const streams = new StreamService(store);
  const questions = new QuestionService(store, streams);
  const stream = await streams.create('human', { title: 's', goal: 'g' });
  await gates.request('classifier_review', {
    policy: { gates: { classifier_review: 'human' }, breaker_signals: [] },
    stream: stream.id,
    summary: 'QA wants to create a test file',
  });
  await questions.raise({ stream: stream.id, raised_by: 'eng-0001', text: 'which spec wins?' });

  const [story] = buildStories(store, { gates, questions });
  expect(story?.needs_you).toBe(0);
  expect(story?.steps.some((s) => s.headline === 'Waiting on you:')).toBe(false);
});

test('buildTeam keeps a finished agent, with the vendor/model it ran on and its ledger tokens', async () => {
  await seedTicket();
  await store.putSprint({
    id: 'S-1',
    goal: 'fixture',
    tickets: ['TKT-0001'],
    budget_tokens: 1000,
    started: new Date().toISOString(),
    carried_over: [],
  });
  await store.putAgent('eng-0001', {
    vendor: 'claude',
    model: 'fake/model-1',
    role: 'engineer',
    ticket: 'TKT-0001',
    last_seen: new Date().toISOString(),
  });
  await store.appendLedgerLine('S-1', {
    ts: new Date().toISOString(),
    sprint: 'S-1',
    ticket: 'TKT-0001',
    agent: 'eng-0001',
    model: 'fake/model-1',
    in_tokens: 800,
    out_tokens: 200,
    cost_usd: 0.01,
    kind: 'engineer',
  });

  const live = buildTeam(store);
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({
    id: 'eng-0001',
    vendor: 'claude',
    model: 'fake/model-1',
    state: 'working',
    tokens: 1000,
  });

  // The session ends: `runner/session.ts` deletes the registry file. The row
  // must survive, with its model id (the ticket's "Team table keeps finished
  // agents and names vendor/model").
  await store.deleteAgent('eng-0001');
  const afterExit = buildTeam(store);
  expect(afterExit).toHaveLength(1);
  expect(afterExit[0]).toMatchObject({
    id: 'eng-0001',
    vendor: 'claude',
    model: 'fake/model-1',
    role: 'engineer',
    ticket: 'TKT-0001',
    state: 'left',
    tokens: 1000,
  });
  expect(afterExit[0]?.left_at).toBeDefined();
});

test('a re-registered agent id shows as live, not as a leftover departed row', async () => {
  await store.putAgent('qa-0001', {
    vendor: 'claude',
    model: 'fake/model-1',
    last_seen: new Date().toISOString(),
  });
  await store.deleteAgent('qa-0001');
  await store.putAgent('qa-0001', {
    vendor: 'claude',
    model: 'fake/model-2',
    last_seen: new Date().toISOString(),
  });
  const team = buildTeam(store);
  expect(team).toHaveLength(1);
  expect(team[0]?.state).toBe('idle');
  expect(team[0]?.model).toBe('fake/model-2');
});

test('the bus thread read returns the ticket messages in send order', async () => {
  await seedTicket();
  const bus = new Bus(store, stateRoot);
  for (const body of ['first', 'second']) {
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-0001'],
      kind: 'fyi',
      priority: 'normal',
      ticket: 'TKT-0001',
      body,
      refs: [],
      requires_ack: false,
    });
  }
  const thread = store
    .listEntities('bus/threads/TKT-0001', validateMessage)
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(thread.map((m) => m.body)).toEqual(['first', 'second']);
});
