import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HaltId, HilId, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { createHalt } from '../halts';
import { runInit } from '../init';
import { ensureIntegrationBranch, ensureTicketWorktree } from '../runner/worktrees';
import { StateStore } from '../store';
import {
  BranchCheckedOutElsewhereError,
  type MergeOutcome,
  MergeOwner,
  type RunTestsFn,
  TicketNotReadyForMergeError,
  sprintReviewApproved,
} from './owner';

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

const WIP_FILE = 'wip.txt';
const WIP_CONTENT = 'human wip, uncommitted — never touched by MergeOwner\n';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-merge-owner-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  ensureIntegrationBranch(repo);

  // Review round 1 blocker 1's exact reproduction: a human has their own
  // feature branch with uncommitted WIP checked out in `repoRoot` — this
  // must stay byte-for-byte untouched (branch *and* dirty file) across
  // every MergeOwner operation for the rest of this suite. `main` and
  // `integration` are deliberately left un-checked-out anywhere so
  // MergeOwner's own `_integration`/`_main` worktrees can claim them.
  git(['checkout', '-b', 'dev-feature']);
  writeFileSync(join(repo, WIP_FILE), WIP_CONTENT);

  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Asserts the human's checkout (branch + uncommitted WIP) is exactly as `beforeEach` left it. */
function expectHumanCheckoutUntouched(): void {
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev-feature');
  expect(readFileSync(join(repo, WIP_FILE), 'utf8')).toBe(WIP_CONTENT);
  const status = git(['status', '--porcelain=v1']);
  expect(status).toContain(WIP_FILE);
}

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
    expect(events.some((e) => e.kind === 'merge_completed')).toBe(true);

    // The merge is real (via the daemon's own `.worktrees/_integration`),
    // but the human's own checkout never moved (review round 1 blocker 1).
    expectHumanCheckoutUntouched();
    expect(existsSync(join(repo, '.worktrees', '_integration'))).toBe(true);
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

describe('onTicketDone — ticket status guard', () => {
  test('refuses a ticket that is not done/stale (review round 1 nit)', async () => {
    const ticket = makeTicket('TKT-0103', { status: 'in_progress' });
    await store.putTicket(ticket);
    const owner = new MergeOwner(store, bus, repo, { runTests: okTests });
    await expect(owner.onTicketDone(ticket.id)).rejects.toThrow(TicketNotReadyForMergeError);
  });
});

describe('onTicketDone — worktree removal safety (review round 1 blocker 2)', () => {
  test('force-removes past a stray untracked file left by the test run', async () => {
    const ticket = makeTicket('TKT-0104');
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'feature.txt', 'hello\n');

    const leavesUntracked: RunTestsFn = (cwd) => {
      writeFileSync(join(cwd, 'coverage-report.txt'), 'noise\n'); // untracked, never git add'ed
      return { ok: true, summary: 'ok' };
    };

    const owner = new MergeOwner(store, bus, repo, { runTests: leavesUntracked });
    const outcome = await owner.onTicketDone(ticket.id);

    expect(outcome.status).toBe('merged');
    expect(outcome.worktreeKept).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(owner.status(ticket.id)?.worktreeKept).toBe(false);
  });

  test('keeps (never force-removes) a worktree left with uncommitted TRACKED changes, records why, and does not throw', async () => {
    const ticket = makeTicket('TKT-0105');
    await store.putTicket(ticket);
    const wt = engineerCommit(ticket, 'feature.txt', 'hello\n');

    const leavesTrackedDirty: RunTestsFn = (cwd) => {
      // e.g. a test runner that updates a tracked snapshot without committing.
      writeFileSync(join(cwd, 'feature.txt'), 'hello, modified by the test run\n');
      return { ok: true, summary: 'ok' };
    };

    const owner = new MergeOwner(store, bus, repo, { runTests: leavesTrackedDirty });
    const outcome = await owner.onTicketDone(ticket.id);

    // The merge itself still landed (it happened before the dirtying) —
    // only the worktree-removal step is affected, and it never throws.
    expect(outcome.status).toBe('merged');
    expect(outcome.mergeCommit).toBeTruthy();
    expect(outcome.worktreeKept).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, 'feature.txt'), 'utf8')).toBe('hello, modified by the test run\n');

    const record = owner.status(ticket.id);
    expect(record?.status).toBe('merged');
    expect(record?.worktreeKept).toBe(true);
    expect(record?.summary).toContain('tracked changes');

    // The merge itself is still recorded as landed on integration.
    const onIntegration = git(['show', 'integration:feature.txt']);
    expect(onIntegration).toBe('hello');
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

    const events = store.listEvents().filter((e) => e.ticket === b.id);
    expect(events.some((e) => e.kind === 'merge_conflict')).toBe(true);

    expectHumanCheckoutUntouched();
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

    const events = store.listEvents().filter((e) => e.ticket === ticket.id);
    expect(events.some((e) => e.kind === 'merge_tests_failed')).toBe(true);
  });
});

describe('mergeIntegrationToMain', () => {
  test('refuses when the sprint_review gate is not approved', async () => {
    const owner = new MergeOwner(store, bus, repo, {
      gateApproved: () => ({ approved: false }),
    });
    const outcome: MergeOutcome = await owner.mergeIntegrationToMain();
    expect(outcome.status).toBe('gated');
    expectHumanCheckoutUntouched();
  });

  test('defaults to not-approved when no gateApproved is injected', async () => {
    const owner = new MergeOwner(store, bus, repo);
    const outcome = await owner.mergeIntegrationToMain();
    expect(outcome.status).toBe('gated');
  });

  test('merges integration into main once approved, without touching the human checkout', async () => {
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
    expect(store.listEvents().some((e) => e.kind === 'integration_merged_to_main')).toBe(true);
    expect(existsSync(join(repo, '.worktrees', '_main'))).toBe(true);

    expectHumanCheckoutUntouched();
  });

  test('refuses with a clear error when main is already checked out elsewhere (e.g. the operator forgot to switch off it)', async () => {
    // Deliberately reproduce the collision blocker 1's fix declines to work
    // around: `main` checked out in `repoRoot` itself, so a dedicated
    // `_main` worktree can't be created without git refusing.
    git(['checkout', 'main']);
    const owner = new MergeOwner(store, bus, repo, {
      gateApproved: () => ({ approved: true }),
    });
    await expect(owner.mergeIntegrationToMain()).rejects.toThrow(BranchCheckedOutElsewhereError);
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
