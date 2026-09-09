import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, TicketId } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store/store';
import type { ReviewProtocol } from './protocol';
import { buildReviewRpcMethods } from './rpc';
import { reviewRecordRelPath, validateReviewRecord } from './types';

let repo: string;
let stateRoot: string;
let store: StateStore;

const REVIEWER_ID = 'reviewer-1' as AgentId;
const ENGINEER_ID = 'eng-0001' as AgentId;
const TICKET = 'TKT-0001' as TicketId;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-review-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function fakeProtocol(): ReviewProtocol {
  return {
    async submitVerdict() {
      return { status: 'in_qa' };
    },
    async dispute() {
      return { count: 1, routedToArchitect: false };
    },
  } as unknown as ReviewProtocol;
}

function methods() {
  return buildReviewRpcMethods({ protocol: fakeProtocol(), store, stateRoot });
}

describe('buildReviewRpcMethods', () => {
  test('exposes review.submit, review.get, rules.list, review.dispute', () => {
    const m = methods();
    expect(Object.keys(m).sort()).toEqual([
      'review.dispute',
      'review.get',
      'review.submit',
      'rules.list',
    ]);
  });

  test('review.submit rejects params that are not an object', () => {
    expect(() => methods()['review.submit']?.(null)).toThrow(/must be an object/);
  });

  test('review.submit requires a non-empty agent', () => {
    expect(() =>
      methods()['review.submit']?.({ ticket: TICKET, input: { round: 1, verdict: 'approve' } }),
    ).toThrow(/agent/);
  });

  test('review.submit dispatches through to the verb (reviewer role, own ticket)', async () => {
    const result = await methods()['review.submit']?.({
      agent: REVIEWER_ID,
      ticket: TICKET,
      input: { round: 1, verdict: 'approve', findings: [] },
    });
    expect(result).toEqual({ status: 'in_qa' });
  });

  test('review.get reads back a stored round', async () => {
    await store.putEntity(reviewRecordRelPath(TICKET, 1, 'primary'), validateReviewRecord, {
      ticket: TICKET,
      round: 1,
      pass: 'primary',
      agent: REVIEWER_ID,
      ts: '2026-09-09T00:00:00Z',
      findings: [],
      verdict: 'approve',
      hunks: [],
    });
    const result = await methods()['review.get']?.({
      agent: ENGINEER_ID,
      ticket: TICKET,
      input: { round: 1 },
    });
    expect((result as { verdict: string }).verdict).toBe('approve');
  });

  test('rules.list rejects a non-reviewer agent', async () => {
    await expect(
      methods()['rules.list']?.({ agent: ENGINEER_ID, ticket: TICKET, input: {} }),
    ).rejects.toThrow(/reviewer role only/);
  });

  test('rules.list returns [] with no .agile/rules dir', async () => {
    const result = await methods()['rules.list']?.({
      agent: REVIEWER_ID,
      ticket: TICKET,
      input: {},
    });
    expect(result).toEqual([]);
  });

  test('review.dispute dispatches through to the verb (engineer role)', async () => {
    const result = await methods()['review.dispute']?.({
      agent: ENGINEER_ID,
      ticket: TICKET,
      input: {
        finding: {
          severity: 'minor',
          rule: 'RULE-001',
          location: { path: 'a.ts', line: 1 },
          message: 'x',
        },
      },
    });
    expect(result).toEqual({ count: 1, routedToArchitect: false });
  });
});
