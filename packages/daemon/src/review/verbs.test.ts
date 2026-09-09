import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Finding, TicketId } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store/store';
import type { ReviewProtocol } from './protocol';
import { reviewRecordRelPath, validateReviewRecord } from './types';
import { ReviewVerbError, reviewDispute, reviewGet, reviewSubmit, rulesList } from './verbs';

let repo: string;
let stateRoot: string;
let store: StateStore;

const REVIEWER_ID = 'reviewer-1' as AgentId;
const ENGINEER_ID = 'eng-0001' as AgentId;
const TICKET = 'TKT-0001' as TicketId;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-review-verbs-'));
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

function fakeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'major',
    rule: 'RULE-001',
    location: { path: 'src/a.ts', line: 5 },
    message: 'x',
    ...overrides,
  };
}

/** A `ReviewProtocol`-shaped fake — verbs.ts only ever calls `submitVerdict`/`dispute` on it. */
function fakeProtocol(): ReviewProtocol & {
  submitCalls: Array<{ agent: AgentId; input: unknown }>;
  disputeCalls: Array<{ agent: AgentId; input: unknown }>;
} {
  const submitCalls: Array<{ agent: AgentId; input: unknown }> = [];
  const disputeCalls: Array<{ agent: AgentId; input: unknown }> = [];
  return {
    submitCalls,
    disputeCalls,
    async submitVerdict(agent: AgentId, input: unknown) {
      submitCalls.push({ agent, input });
      return { status: 'in_qa' };
    },
    async dispute(agent: AgentId, input: unknown) {
      disputeCalls.push({ agent, input });
      return { count: 1, routedToArchitect: false };
    },
  } as unknown as ReviewProtocol & {
    submitCalls: Array<{ agent: AgentId; input: unknown }>;
    disputeCalls: Array<{ agent: AgentId; input: unknown }>;
  };
}

describe('reviewSubmit', () => {
  test('rejects a non-reviewer caller', async () => {
    const proto = fakeProtocol();
    await expect(
      reviewSubmit(
        { protocol: proto, store, stateRoot },
        { agent: ENGINEER_ID, ticket: TICKET },
        { round: 1, verdict: 'approve', findings: [] },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('rejects a session with no ticket context', async () => {
    const proto = fakeProtocol();
    await expect(
      reviewSubmit(
        { protocol: proto, store, stateRoot },
        { agent: REVIEWER_ID },
        { round: 1, verdict: 'approve', findings: [] },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('rejects a ticket in the payload that does not match the session ticket', async () => {
    const proto = fakeProtocol();
    await expect(
      reviewSubmit(
        { protocol: proto, store, stateRoot },
        { agent: REVIEWER_ID, ticket: TICKET },
        { ticket: 'TKT-9999', round: 1, verdict: 'approve', findings: [] },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('delegates to protocol.submitVerdict, ignoring any client-supplied hunks', async () => {
    const proto = fakeProtocol();
    await reviewSubmit(
      { protocol: proto, store, stateRoot },
      { agent: REVIEWER_ID, ticket: TICKET },
      {
        round: 1,
        verdict: 'request_changes',
        findings: [fakeFinding()],
        hunks: [{ path: 'src/a.ts', newStart: 1, newEnd: 1, hash: 'fake' }],
      },
    );
    expect(proto.submitCalls).toHaveLength(1);
    expect(proto.submitCalls[0]?.agent).toBe(REVIEWER_ID);
    const input = proto.submitCalls[0]?.input as Record<string, unknown>;
    expect(input.ticket).toBe(TICKET);
    expect(input.round).toBe(1);
    expect(input).not.toHaveProperty('hunks');
  });
});

describe('reviewGet', () => {
  test('rejects a session with no ticket context', async () => {
    await expect(
      reviewGet(
        { protocol: fakeProtocol(), store, stateRoot },
        { agent: REVIEWER_ID },
        { round: 1 },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('rejects a non-positive-integer round', async () => {
    await expect(
      reviewGet(
        { protocol: fakeProtocol(), store, stateRoot },
        { agent: REVIEWER_ID, ticket: TICKET },
        { round: 0 },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('raises a ReviewVerbError (not a bare NotFoundError) for a missing record', async () => {
    await expect(
      reviewGet(
        { protocol: fakeProtocol(), store, stateRoot },
        { agent: REVIEWER_ID, ticket: TICKET },
        { round: 1 },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('reads back a stored review record', async () => {
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
    const record = await reviewGet(
      { protocol: fakeProtocol(), store, stateRoot },
      { agent: ENGINEER_ID, ticket: TICKET },
      { round: 1 },
    );
    expect(record.verdict).toBe('approve');
  });

  test('reads the security-pass record when pass: security is given', async () => {
    await store.putEntity(reviewRecordRelPath(TICKET, 1, 'security'), validateReviewRecord, {
      ticket: TICKET,
      round: 1,
      pass: 'security',
      agent: 'reviewer-2',
      ts: '2026-09-09T00:00:00Z',
      findings: [],
      verdict: 'approve',
      hunks: [],
    });
    const record = await reviewGet(
      { protocol: fakeProtocol(), store, stateRoot },
      { agent: ENGINEER_ID, ticket: TICKET },
      { round: 1, pass: 'security' },
    );
    expect(record.pass).toBe('security');
  });
});

describe('rulesList', () => {
  test('rejects a non-reviewer caller', async () => {
    await expect(
      rulesList(
        { protocol: fakeProtocol(), store, stateRoot },
        { agent: ENGINEER_ID, ticket: TICKET },
        {},
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('returns the loaded rules for a reviewer caller', async () => {
    mkdirSync(join(stateRoot, 'rules'), { recursive: true });
    writeFileSync(join(stateRoot, 'rules', 'RULE-001.md'), '# RULE-001: A\ntext a\n');
    const rules = await rulesList(
      { protocol: fakeProtocol(), store, stateRoot },
      { agent: REVIEWER_ID, ticket: TICKET },
      {},
    );
    expect(rules.map((r) => r.id)).toEqual(['RULE-001']);
  });
});

describe('reviewDispute', () => {
  test('rejects a non-engineer caller', async () => {
    const proto = fakeProtocol();
    await expect(
      reviewDispute(
        { protocol: proto, store, stateRoot },
        { agent: REVIEWER_ID, ticket: TICKET },
        { finding: fakeFinding() },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('rejects a session with no ticket context', async () => {
    const proto = fakeProtocol();
    await expect(
      reviewDispute(
        { protocol: proto, store, stateRoot },
        { agent: ENGINEER_ID },
        { finding: fakeFinding() },
      ),
    ).rejects.toThrow(ReviewVerbError);
  });

  test('delegates to protocol.dispute with the parsed finding', async () => {
    const proto = fakeProtocol();
    await reviewDispute(
      { protocol: proto, store, stateRoot },
      { agent: ENGINEER_ID, ticket: TICKET },
      { finding: fakeFinding() },
    );
    expect(proto.disputeCalls).toHaveLength(1);
    expect(proto.disputeCalls[0]?.agent).toBe(ENGINEER_ID);
    const input = proto.disputeCalls[0]?.input as { ticket: TicketId; finding: Finding };
    expect(input.ticket).toBe(TICKET);
    expect(input.finding.rule).toBe('RULE-001');
  });
});
