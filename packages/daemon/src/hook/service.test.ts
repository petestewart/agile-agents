import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, AgentRecord, Ticket, TicketId } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HookService } from './service';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let gates: GateService;
let worktree: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-hook-service-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
  gates = new GateService(store);

  worktree = join(repo, '.worktrees', 'TKT-0001');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id: 'TKT-0001',
    title: 'Ticket',
    status: 'in_progress',
    contract: {},
    history: [],
    assignee: 'eng-1',
    worktree: join('.worktrees', 'TKT-0001'),
    ...overrides,
  });
}

/**
 * T122: the hook resolves a call from the agent registry alone — ticket
 * files are gone with the ceremony layer, so seeding one is a no-op kept
 * here only so these fixtures keep reading as they did.
 */
async function seedTicket(_overrides: Partial<Ticket> = {}): Promise<void> {}

function service(
  overrides: Partial<ConstructorParameters<typeof HookService>[2]> = {},
): HookService {
  return new HookService(store, bus, { repoRoot: repo, ...overrides });
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    pid: 4242,
    // Fresh by default — real "now" at fixture-construction time, not a
    // hardcoded past timestamp — so every existing test here stays "live"
    // under review round 3's staleness check (`resolveAgentByCwd` ignores a
    // registry entry whose `last_seen` is older than the bus's liveness
    // timeout) without having to inject a matching clock into every
    // `service()` call. Tests that need a genuinely stale record pass their
    // own `last_seen` override.
    last_seen: new Date().toISOString(),
    ...overrides,
  };
}

// T012 QA/review round: resolution rewritten to go through the agent
// registry (`AgentRecord.worktree`/`.role`) first, not just `Ticket.worktree`
// — see `service.ts`'s file header and `resolveAgentByCwd`.

// Round 4 (QA round 3 REJECT — a real regression, not a test-harness
// artifact): `buildContext`'s own `store.heartbeat` call was silently
// dropping `role`/`worktree`/`session_id` from the registry once
// `HEARTBEAT_COALESCE_MS` elapsed, decaying a reviewer to the engineer's
// permissive policy (and stranding QA with no resolvable identity) after
// roughly 30+ seconds of normal tool-call traffic. Fixed at the store level
// (`StateStore.heartbeat` now only ever touches `last_seen`/`stream`).
describe('HookService — heartbeat preserves agent identity across the coalescing window (T012 review round 4)', () => {
  test('role/worktree/session_id survive a hook heartbeat past the coalescing window, byte-for-byte', async () => {
    await seedTicket({ status: 'in_review', assignee: 'eng-1' });
    let now = new Date('2026-09-09T00:00:00.000Z');
    await store.putAgent(
      'reviewer-1',
      agentRecord({
        role: 'reviewer',
        worktree,
        session_id: 'sess-reviewer-1',
        // Registered well before the simulated clock's start — otherwise
        // the coalescing check (`now - last_seen < 30s`) sees a *negative*
        // gap against the fixture's real-wall-clock default `last_seen`
        // and treats the first heartbeat below as still "recent", never
        // writing at all.
        last_seen: new Date(now.getTime() - 60_000).toISOString(),
      }),
    );
    const svc = service({ now: () => now });

    await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
      agile_agent: 'reviewer-1',
    });
    const before = store.getAgent('reviewer-1' as never);
    expect(before.role).toBe('reviewer');
    expect(before.worktree).toBe(worktree);
    expect(before.session_id).toBe('sess-reviewer-1');

    // Past the 30s heartbeat-coalescing window — this is exactly the write
    // QA round 3 caught dropping role/worktree/session_id.
    now = new Date(now.getTime() + 31_000);
    await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
      agile_agent: 'reviewer-1',
    });
    const after = store.getAgent('reviewer-1' as never);
    expect(after.role).toBe(before.role);
    expect(after.worktree).toBe(before.worktree);
    expect(after.session_id).toBe(before.session_id);
    expect(after.vendor).toBe(before.vendor);
    expect(after.model).toBe(before.model);
    expect(after.pid).toBe(before.pid);
    expect(after.last_seen).not.toBe(before.last_seen);
  });

  test('reviewer Edit is still denied after 3 simulated heartbeat windows (injectable clock)', async () => {
    await seedTicket({ status: 'in_review', assignee: 'eng-1' });
    await store.putAgent('reviewer-1', agentRecord({ role: 'reviewer', worktree }));
    let now = new Date('2026-09-09T00:00:00.000Z');
    const svc = service({ now: () => now });

    // Three tool calls, each one heartbeat-coalescing window (30s) apart —
    // simulates a real reviewer session idling between tool calls at a
    // normal cadence, well past the point QA round 3 found the role gate
    // silently disappearing.
    for (let window = 0; window < 3; window++) {
      now = new Date(now.getTime() + 31_000);
      const result = await svc.preToolUse({
        cwd: worktree,
        tool_name: 'Edit',
        tool_input: { file_path: join(worktree, 'a.ts') },
        agile_agent: 'reviewer-1',
      });
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
        /reviewer role denies all writes/,
      );
    }
    const record = store.getAgent('reviewer-1' as never);
    expect(record.role).toBe('reviewer');
    expect(record.worktree).toBe(worktree);
  });

  test('a worker keeps resolvable identity (worktree) after 3 simulated heartbeat windows', async () => {
    await seedTicket({ status: 'in_qa', assignee: 'eng-1' });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(qaWorktree, { recursive: true });
    await store.putAgent('qa-1', agentRecord({ role: 'worker', worktree: qaWorktree }));
    let now = new Date('2026-09-09T00:00:00.000Z');
    const svc = service({ now: () => now });

    for (let window = 0; window < 3; window++) {
      now = new Date(now.getTime() + 31_000);
      const result = await svc.preToolUse({
        cwd: qaWorktree,
        tool_name: 'Bash',
        tool_input: { command: 'bun test' },
        agile_agent: 'qa-1',
      });
      // A worker may run the repo's own test command — the regression QA
      // round 3 found made this DENY with "cwd is not a
      // registered stream worktree" once `worktree` was dropped.
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    }
    expect(store.getAgent('qa-1' as never).worktree).toBe(qaWorktree);
  });
});

// T017 review round (opus blocker 2): end-to-end through the real
// HookService.preToolUse — not just decide.ts's pure function — proving
// `buildContext` actually resolves and forwards `ctx.denyReadPaths` for a
// QA session, and that a Claude ABSOLUTE `file_path` under the clone is
// correctly matched against the ticket's repo-relative contract globs.

// T125: the daemon no longer derives a repo root from its own cwd
// (`config.ts`), so `HookService` may be built without one. A *relative*
// `worktree` on an agent record then has nothing to resolve against, and the
// hook path's first rule applies — "unresolvable ⇒ DENY" (cockpit design
// §8.1, fail closed). The alternative, resolving it against whatever
// directory `agiled` happened to be started in, would authorize a tool call
// from a directory nobody registered.
describe('HookService without a repoRoot (T125)', () => {
  test('a relative worktree is unresolvable and denies, rather than resolving against the daemon cwd', async () => {
    await store.putAgent('eng-1', agentRecord({ role: 'worker', worktree: '.worktrees/TKT-0001' }));
    const svc = new HookService(store, bus, {});

    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'README.md') },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
      /not a registered stream worktree/,
    );
  });

  test('an absolute worktree still resolves without a repoRoot', async () => {
    await store.putAgent('eng-1', agentRecord({ role: 'worker', worktree }));
    const svc = new HookService(store, bus, {});

    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'README.md') },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
