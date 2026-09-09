import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HaltId, HilId, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { createHalt } from '../halts';
import { runInit } from '../init';
import { ensureIntegrationBranch, ensureTicketWorktree } from '../runner/worktrees';
import { StateStore } from '../store';
import { type MergeOutcome, MergeOwner, type RunTestsFn, sprintReviewApproved } from './owner';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id.replace('TKT-', '')}`,
    status: 'done',
    assignee: 'eng-1',
    contract: {},
    history: [],
    ...overrides,
  });
}

const okTests: RunTestsFn = () => ({ ok: true, summary: 'ok' });
const failTests: RunTestsFn = () => ({ ok: false, summary: 'boom: 1 test failed' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-merge-owner-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  ensureIntegrationBranch(repo);

  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Creates a ticket worktree, writes `content` to `file`, and commits it as the engineer. */
function engineerCommit(ticket: Ticket, file: string, content: string, message = 'work'): string {
  const wt = ensureTicketWorktree(repo, ticket);
  writeFileSync(join(wt.path, file), content);
  git(['add', '-A'], wt.path);
  git(['commit', '-q', '-m', message], wt.path);
  return wt.path;
}

describe('onTicketDone — clean merge', () => {
  test('rebases, runs tests, merges into integration, and removes the worktree', async () => {
    const ticket = makeTicket('TKT-0100');
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'feature.txt', 'hello from TKT-0100\n');

    const owner = new MergeOwner(store, bus, repo, { runTests: okTests });
    const outcome = await owner.onTicketDone(ticket.id);

    expect(outcome.status).toBe('merged');
    expect(outcome.worktreeKept).toBe(false);
    expect(outcome.mergeCommit).toBeTruthy();
    expect(existsSync(wt)).toBe(false);

    const onIntegration = git(['show', 'integration:feature.txt']);
    expect(onIntegration).toBe('hello from TKT-0100');

    const log = git(['log', 'integration', '-1', '--format=%s']);
    expect(log).toBe('Merge TKT-0100 Ticket 0100');

    const record = owner.status(ticket.id);
    expect(record?.status).toBe('merged');
    expect(record?.worktreeKept).toBe(false);

    const events = store.listEvents().filter((e) => e.ticket === ticket.id);
    expect(events.some((e) => e.data.merge === 'ticket_to_integration')).toBe(true);
  });

  test('keeps the worktree for a stale ticket', async () => {
    const ticket = makeTicket('TKT-0101', { status: 'stale' });
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'stale.txt', 'stale work\n');

    const owner = new MergeOwner(store, bus, repo, { runTests: okTests });
    const outcome = await owner.onTicketDone(ticket.id);

    expect(outcome.status).toBe('merged');
    expect(outcome.worktreeKept).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(owner.status(ticket.id)?.keepReason).toBe('stale');
  });

  test('keeps the worktree for an abandoned ticket (halted, no assignee)', async () => {
    const ticket = makeTicket('TKT-0102', { assignee: undefined });
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'abandoned.txt', 'orphan work\n');
    await createHalt(store, {
      scope: [ticket.id],
      reason: 'unrelated halt for this test',
      raised_by: 'architect',
    });

    const owner = new MergeOwner(store, bus, repo, { runTests: okTests });
    const outcome = await owner.onTicketDone(ticket.id);

    expect(outcome.status).toBe('merged');
    expect(outcome.worktreeKept).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(owner.status(ticket.id)?.keepReason).toBe('abandoned');
  });
});

describe('onTicketDone — conflict path', () => {
  test('two tickets touching the same file: the second gets a scoped halt naming the file and the first ticket', async () => {
    const a = makeTicket('TKT-0110', { title: 'First writer' });
    const b = makeTicket('TKT-0111', { title: 'Second writer', assignee: 'eng-2' });
    await store.putTicket(a);
    await store.putTicket(b);

    // Both worktrees branch off the same `integration` commit before either merges.
    const wtA = engineerCommit(a, 'shared.txt', 'from A\n');
    const wtB = ensureTicketWorktree(repo, b).path;
    writeFileSync(join(wtB, 'shared.txt'), 'from B\n');
    git(['add', '-A'], wtB);
    git(['commit', '-q', '-m', 'b work'], wtB);

    const owner = new MergeOwner(store, bus, repo, { runTests: okTests });

    const outcomeA = await owner.onTicketDone(a.id);
    expect(outcomeA.status).toBe('merged');
    expect(existsSync(wtA)).toBe(false);

    const outcomeB = await owner.onTicketDone(b.id);
    expect(outcomeB.status).toBe('conflict');
    expect(outcomeB.summary).toContain('shared.txt');
    expect(outcomeB.summary).toContain(a.id);
    expect(outcomeB.haltId).toBeTruthy();
    // The worktree is preserved for the fix cycle, and left clean (no
    // in-progress rebase) since the conflict was aborted.
    expect(existsSync(wtB)).toBe(true);
    expect(git(['status', '--porcelain=v1'], wtB)).toBe('');

    const halt = store.getHalt(outcomeB.haltId as HaltId);
    expect(halt.scope).toEqual([b.id]);
    expect(halt.reason).toContain('shared.txt');

    // "commits are refused during a halt" — em was notified.
    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.kind === 'halt' && m.ticket === b.id)).toBe(true);

    const record = owner.status(b.id);
    expect(record?.status).toBe('conflict');
  });
});

describe('onTicketDone — test failure path', () => {
  test('halts the ticket with a test-failure summary and keeps the worktree', async () => {
    const ticket = makeTicket('TKT-0120');
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'flaky.txt', 'flaky change\n');

    const owner = new MergeOwner(store, bus, repo, { runTests: failTests });
    const outcome = await owner.onTicketDone(ticket.id);

    expect(outcome.status).toBe('test_failed');
    expect(outcome.summary).toContain('boom');
    expect(outcome.haltId).toBeTruthy();
    expect(existsSync(wt)).toBe(true);

    const halt = store.getHalt(outcome.haltId as HaltId);
    expect(halt.scope).toEqual([ticket.id]);
  });
});

describe('mergeIntegrationToMain', () => {
  test('refuses when the sprint_review gate is not approved', async () => {
    const owner = new MergeOwner(store, bus, repo, {
      gateApproved: () => ({ approved: false }),
    });
    const outcome: MergeOutcome = await owner.mergeIntegrationToMain();
    expect(outcome.status).toBe('gated');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  test('defaults to not-approved when no gateApproved is injected', async () => {
    const owner = new MergeOwner(store, bus, repo);
    const outcome = await owner.mergeIntegrationToMain();
    expect(outcome.status).toBe('gated');
  });

  test('merges integration into main once approved', async () => {
    const ticket = makeTicket('TKT-0130');
    await store.putTicket(ticket);
    engineerCommit(ticket, 'shipped.txt', 'shipped\n');
    const owner = new MergeOwner(store, bus, repo, {
      runTests: okTests,
      gateApproved: () => ({ approved: true, hilId: 'HIL-01J9ZZZZZZZZZZZZZZZZZZZZZZ' as HilId }),
    });
    await owner.onTicketDone(ticket.id);

    const outcome = await owner.mergeIntegrationToMain();
    expect(outcome.status).toBe('merged');
    expect(outcome.mergeCommit).toBeTruthy();
    expect(git(['show', 'main:shipped.txt'])).toBe('shipped');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});

describe('sprintReviewApproved', () => {
  test('not approved when no sprint_review request exists', () => {
    const result = sprintReviewApproved({ list: () => [] });
    expect(result.approved).toBe(false);
  });

  test('approved only for a resolved approve decision, picking the most recent', () => {
    const requests = [
      {
        id: 'HIL-01J9AAAAAAAAAAAAAAAAAAAAAA',
        gate: 'sprint_review',
        hil_kind: 'demo',
        owner: 'human',
        status: 'resolved',
        requested_at: '2026-09-01T00:00:00.000Z',
        decision: 'deny',
      },
      {
        id: 'HIL-01J9BBBBBBBBBBBBBBBBBBBBBB',
        gate: 'sprint_review',
        hil_kind: 'demo',
        owner: 'human',
        status: 'resolved',
        requested_at: '2026-09-02T00:00:00.000Z',
        decision: 'approve',
      },
    ];
    const result = sprintReviewApproved({ list: () => requests as never });
    expect(result.approved).toBe(true);
    expect(result.hilId).toBe('HIL-01J9BBBBBBBBBBBBBBBBBBBBBB');
  });
});
