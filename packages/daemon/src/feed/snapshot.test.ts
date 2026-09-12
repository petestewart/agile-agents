/**
 * T023 addition: `buildSnapshot`'s new (optional) `quota` parameter and
 * `FeedSnapshot.quota` field (§17 "Sprint strip" vendor barometer).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { QuotaService } from '../quota/records';
import { StateStore } from '../store';
import { buildSnapshot } from './snapshot';

let repo: string;
let store: StateStore;
let gates: GateService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-feed-quota-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  gates = new GateService(store);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test('with no QuotaService given, quota is an empty array (backward compatible)', () => {
  const snapshot = buildSnapshot(store, gates);
  expect(snapshot.quota).toEqual([]);
});

describe('with a QuotaService', () => {
  test('lists every configured account, remaining_fraction from the Quota record', async () => {
    const quota = new QuotaService({ store });
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    expect(snapshot.quota).toHaveLength(1);
    expect(snapshot.quota[0]).toMatchObject({
      vendor: 'claude',
      account: 'default',
      remaining_fraction: 1,
    });
  });

  test('reflects cooldown_until after a 429', async () => {
    const quota = new QuotaService({ store });
    await quota.record429('claude', 'default', 30);
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    expect(snapshot.quota[0]?.cooldown_until).not.toBeNull();
    expect(snapshot.quota[0]?.remaining_fraction).toBe(0);
  });

  test('carries spend_usd for a Pi-on-Claude extra-usage account', async () => {
    const quota = new QuotaService({ store });
    await store.putVendors({
      claude: {
        accounts: [
          { id: 'default', auth: 'subscription' },
          { id: 'pi', auth: 'subscription' },
        ],
      },
    });
    await quota.recordReported(
      'claude',
      'pi',
      { remaining: 1, unit: 'usd' },
      { spendDeltaUsd: 2.5 },
    );
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    const pi = snapshot.quota.find((q) => q.account === 'pi');
    expect(pi?.spend_usd).toBe(2.5);
  });
});

describe('T040: open questions in the attention queue', () => {
  test('without a QuestionService the array is empty (backward compatible)', () => {
    expect(buildSnapshot(store, gates).questions).toEqual([]);
  });

  test('carries open questions only — an answered one is history, like a resolved hil_request', async () => {
    const questions = new QuestionService(store);
    const open = await questions.raise({ raised_by: 'eng-1', text: 'is the ticket right?' });
    const answered = await questions.raise({ raised_by: 'em', text: 'already handled' });
    await questions.answer(answered.id, { answer: 'yes', by: 'human', resolved_as: 'reply' });

    const snapshot = buildSnapshot(store, gates, undefined, undefined, questions);
    expect(snapshot.questions.map((q) => q.id)).toEqual([open.id]);
  });
});

/**
 * T043 (§17 v2 "Top bar is identical on every view ... the sprint status
 * ('Sprint 1 · running 4m 12s', '3 agents working') and the single action").
 * Everything the always-on top bar renders comes from these two blocks.
 */
describe('T043: project + status for the top bar', () => {
  test('no project root given: no `project` block (backward compatible)', () => {
    expect(buildSnapshot(store, gates).project).toBeUndefined();
  });

  test('project carries the repo directory name and its full path', () => {
    const snapshot = buildSnapshot(store, gates, undefined, undefined, undefined, repo);
    expect(snapshot.project?.path).toBe(repo);
    expect(snapshot.project?.name).toBe(repo.split('/').pop());
  });

  test('with no sprint at all: state `none`, and the button offers Sprint 1', () => {
    const status = buildSnapshot(store, gates).status;
    expect(status.sprint_state).toBe('none');
    expect(status.sprint_id).toBeUndefined();
    expect(status.next_sprint_number).toBe(1);
  });

  test('a sprint with no retro is running and carries started_at; the button offers the NEXT number', async () => {
    await store.putSprint({
      id: 'S-1',
      goal: 'first',
      tickets: [],
      budget_tokens: 1000,
      started: '2026-09-12T10:00:00.000Z',
      carried_over: [],
    });
    const status = buildSnapshot(store, gates).status;
    expect(status.sprint_state).toBe('running');
    expect(status.sprint_id).toBe('S-1');
    expect(status.sprint_started_at).toBe('2026-09-12T10:00:00.000Z');
    expect(status.next_sprint_number).toBe(2);
  });

  test('a sprint with a retro block reads as finished', async () => {
    await store.putSprint({
      id: 'S-1',
      goal: 'first',
      tickets: [],
      budget_tokens: 1000,
      started: '2026-09-12T10:00:00.000Z',
      carried_over: [],
      retro: { mispointed: [], global_halts: 0, escalations: 0 },
    });
    expect(buildSnapshot(store, gates).status.sprint_state).toBe('finished');
  });

  test('agents_working counts only registered agents holding a ticket', async () => {
    await store.putAgent('eng-1', {
      vendor: 'claude',
      model: 'sonnet',
      last_seen: new Date().toISOString(),
      ticket: 'TKT-0001',
    });
    await store.putAgent('eng-2', {
      vendor: 'claude',
      model: 'sonnet',
      last_seen: new Date().toISOString(),
    });
    expect(buildSnapshot(store, gates).status.agents_working).toBe(1);
  });

  /**
   * Review round 1 blocker 1: the top bar's action must be disabled while a
   * finished sprint's review is still open (mockup `#s4`).
   */
  test('sprint_review_pending follows an open sprint_review gate', async () => {
    await store.putSprint({
      id: 'S-1',
      goal: 'first',
      tickets: [],
      budget_tokens: 1000,
      started: '2026-09-12T10:00:00.000Z',
      carried_over: [],
      retro: { mispointed: [], global_halts: 0, escalations: 0 },
    });
    expect(buildSnapshot(store, gates).status.sprint_review_pending).toBe(false);

    const raised = await gates.request('sprint_review', {
      policy: { gates: { sprint_review: 'human' }, breaker_signals: [] },
      hilKind: 'demo',
    });
    const pending = buildSnapshot(store, gates).status;
    expect(pending.sprint_state).toBe('finished');
    expect(pending.sprint_review_pending).toBe(true);

    // Decided — the next sprint is startable again.
    await gates.respond(raised.id, 'approve', 'human');
    expect(buildSnapshot(store, gates).status.sprint_review_pending).toBe(false);
  });

  test('an open gate that is not sprint_review leaves sprint_review_pending false', async () => {
    await gates.request('unblock', {
      policy: { gates: { unblock: 'human' }, breaker_signals: [] },
      hilKind: 'unblock',
    });
    expect(buildSnapshot(store, gates).status.sprint_review_pending).toBe(false);
  });

  test('needs_you is open HIL requests plus open questions', async () => {
    await gates.request('unblock', {
      policy: { gates: { unblock: 'human' }, breaker_signals: [] },
      hilKind: 'unblock',
    });
    const questions = new QuestionService(store);
    await questions.raise({ raised_by: 'eng-1', text: 'which wins?' });
    const answered = await questions.raise({ raised_by: 'em', text: 'already handled' });
    await questions.answer(answered.id, { answer: 'yes', by: 'human', resolved_as: 'reply' });

    const status = buildSnapshot(store, gates, undefined, undefined, questions).status;
    expect(status.needs_you).toBe(2);
  });
});
