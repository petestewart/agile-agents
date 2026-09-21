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
    ticket: 'TKT-0001',
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

describe('HookService.stop', () => {
  test('drains low-priority inbox and re-prompts the model via decision:block+reason (review round fix, blocker 4)', async () => {
    await seedTicket();
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'fyi',
      priority: 'low',
      body: 'KB-0117 promoted',
    });

    const svc = service();
    const result = await svc.stop({ cwd: worktree });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('KB-0117 promoted');
    expect(bus.poll('eng-1', { priority: 'low' })).toHaveLength(0);
  });

  test('an empty low-priority inbox returns {} — never blocks the turn to say nothing', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.stop({ cwd: worktree });
    expect(result).toEqual({});
  });
});

// T012 QA/review round: resolution rewritten to go through the agent
// registry (`AgentRecord.worktree`/`.role`) first, not just `Ticket.worktree`
// — see `service.ts`'s file header and `resolveAgentByCwd`.
describe('HookService — registry-based agent resolution (T012 QA/review round)', () => {
  test('a QA agent in its own fresh clone (never matching Ticket.worktree) resolves and a read is allowed', async () => {
    await seedTicket({ status: 'in_qa', assignee: 'eng-1' });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(qaWorktree, { recursive: true });
    await store.putAgent(
      'qa-1',
      agentRecord({ role: 'qa', worktree: qaWorktree, ticket: 'TKT-0001' }),
    );

    const svc = service();
    const result = await svc.preToolUse({
      hook_event_name: 'PreToolUse',
      cwd: qaWorktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.agent).toBe('qa-1');
    expect(events[0]?.ticket).toBe('TKT-0001');
  });

  // T031: the architect resolves from its own read-only checkout regardless
  // of the ticket its `AgentRecord.ticket` happens to name — unlike
  // engineer/reviewer/qa, that ticket's own status is not gated (a `done`
  // or `ready` ticket is the normal case for whatever the architect's
  // brief/ledger context was last rendered for, not a stale registration).
  test('an architect resolves from .worktrees/architect even when its recorded ticket is `done`, and its Bash/Edit are denied by the role table', async () => {
    await seedTicket({ status: 'done' });
    const architectWorktree = join(repo, '.worktrees', 'architect');
    mkdirSync(architectWorktree, { recursive: true });
    await store.putAgent(
      'architect',
      agentRecord({ role: 'architect', worktree: architectWorktree, ticket: 'TKT-0001' }),
    );

    const svc = service();
    const read = await svc.preToolUse({
      cwd: architectWorktree,
      tool_name: 'Read',
      tool_input: { file_path: join(architectWorktree, 'x.txt') },
    });
    expect(read.hookSpecificOutput.permissionDecision).toBe('allow');
    const readEvents = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.agent === 'architect');
    expect(readEvents).toHaveLength(1);
    expect(readEvents[0]?.ticket).toBe('TKT-0001');

    const edit = await svc.preToolUse({
      cwd: architectWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(architectWorktree, 'x.txt') },
    });
    expect(edit.hookSpecificOutput.permissionDecision).toBe('deny');

    const exec = await svc.preToolUse({
      cwd: architectWorktree,
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' },
    });
    expect(exec.hookSpecificOutput.permissionDecision).toBe('deny');

    const readOnlyExec = await svc.preToolUse({
      cwd: architectWorktree,
      tool_name: 'Bash',
      tool_input: { command: 'git log' },
    });
    expect(readOnlyExec.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('reviewer and engineer sharing one worktree: role comes from the registry, not inferred as engineer', async () => {
    await seedTicket({ status: 'in_review', assignee: 'eng-1' });
    await store.putAgent('eng-1', agentRecord({ role: 'engineer', worktree, ticket: 'TKT-0001' }));
    await store.putAgent(
      'reviewer-1',
      agentRecord({ role: 'reviewer', worktree, ticket: 'TKT-0001' }),
    );

    // Ambiguous (two agents, same worktree, no hint) — fails closed rather
    // than silently resolving as the engineer.
    const svc = service();
    const ambiguous = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
    });
    expect(ambiguous.hookSpecificOutput.permissionDecision).toBe('deny');

    // Disambiguated via the `agile_agent` hint (what the CLI forwards from
    // `AGILE_AGENT`, itself set by `writeClaudeSettings`'s `agentId` option)
    // — reviewer resolves as `role: 'reviewer'`, and role now actually
    // GATES the edit (review round 3, opus item 1 — this used to only be
    // attributed correctly on the event log while still `allow`ing the
    // edit itself; asserted here, not `void`d).
    const asReviewer = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
      agile_agent: 'reviewer-1',
    });
    expect(asReviewer.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(asReviewer.hookSpecificOutput.permissionDecisionReason).toMatch(/reviewer role denies/);
    const reviewerEvents = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.agent === 'reviewer-1');
    expect(reviewerEvents).toHaveLength(1);

    // Same shared worktree, same file, but resolved as the engineer — the
    // engineer's own edit-inside-worktree allowance still applies.
    const asEngineer = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
      agile_agent: 'eng-1',
    });
    expect(asEngineer.hookSpecificOutput.permissionDecision).toBe('allow');
    const engineerEvents = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.agent === 'eng-1');
    expect(engineerEvents).toHaveLength(1);
  });

  test('reviewer Bash: only the read-only allow-list passes, everything else denies (review round 3, opus item 1)', async () => {
    await seedTicket({ status: 'in_review', assignee: 'eng-1' });
    await store.putAgent(
      'reviewer-1',
      agentRecord({ role: 'reviewer', worktree, ticket: 'TKT-0001' }),
    );
    const svc = service();

    const readOnly = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git diff' },
      agile_agent: 'reviewer-1',
    });
    expect(readOnly.hookSpecificOutput.permissionDecision).toBe('allow');

    const destructive = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf src' },
      agile_agent: 'reviewer-1',
    });
    expect(destructive.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(destructive.hookSpecificOutput.permissionDecisionReason).toMatch(/reviewer role denies/);
  });

  test('QA Edit denies (deny edits to source — write test files only), engineer edit outside its worktree denies', async () => {
    await seedTicket({ status: 'in_qa', assignee: 'eng-1' });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(qaWorktree, { recursive: true });
    await store.putAgent(
      'qa-1',
      agentRecord({ role: 'qa', worktree: qaWorktree, ticket: 'TKT-0001' }),
    );
    const svc = service();

    const qaEdit = await svc.preToolUse({
      cwd: qaWorktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(qaWorktree, 'src.ts') },
    });
    expect(qaEdit.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(qaEdit.hookSpecificOutput.permissionDecisionReason).toMatch(/QA role denies edits/);

    await store.putAgent('eng-1', agentRecord({ role: 'engineer', worktree, ticket: 'TKT-0001' }));
    const outside = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      // Escapes the engineer's own worktree.
      tool_input: { file_path: join(repo, 'outside.ts') },
    });
    expect(outside.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(outside.hookSpecificOutput.permissionDecisionReason).toMatch(/outside the worktree/);
  });

  test('a stale registry entry (last_seen past the liveness timeout) is ignored when resolving cwd (review round 3, opus item 4)', async () => {
    await seedTicket({ status: 'in_progress', assignee: 'eng-1' });
    const staleLastSeen = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await store.putAgent(
      'eng-1',
      agentRecord({ role: 'engineer', worktree, ticket: 'TKT-0001', last_seen: staleLastSeen }),
    );

    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });

    // Falls back to the Ticket.worktree-based resolution (the registry
    // entry is ignored as stale) — the ticket itself still resolves this as
    // an allow (a Read is always allowed), but attribution comes from the
    // fallback path, not the stale registry record.
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('an agent record with no `worktree` set falls back to the Ticket.worktree-based resolution (backward compat)', async () => {
    await seedTicket();
    // No putAgent call at all — matches every pre-T012-QA-round test above.
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

// Round 4 (QA round 3 REJECT — a real regression, not a test-harness
// artifact): `buildContext`'s own `store.heartbeat` call was silently
// dropping `role`/`worktree`/`session_id` from the registry once
// `HEARTBEAT_COALESCE_MS` elapsed, decaying a reviewer to the engineer's
// permissive policy (and stranding QA with no resolvable identity) after
// roughly 30+ seconds of normal tool-call traffic. Fixed at the store level
// (`StateStore.heartbeat` now only ever touches `last_seen`/`ticket`).
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
        ticket: 'TKT-0001',
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
    await store.putAgent(
      'reviewer-1',
      agentRecord({ role: 'reviewer', worktree, ticket: 'TKT-0001' }),
    );
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

  test('QA keeps resolvable identity (worktree) after 3 simulated heartbeat windows', async () => {
    await seedTicket({ status: 'in_qa', assignee: 'eng-1' });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(qaWorktree, { recursive: true });
    await store.putAgent(
      'qa-1',
      agentRecord({ role: 'qa', worktree: qaWorktree, ticket: 'TKT-0001' }),
    );
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
      // QA is permitted "anything in the env" (§14) for a plain command —
      // the regression QA round 3 found made this DENY with "cwd is not a
      // registered ticket worktree" once `worktree` was dropped.
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
describe('HookService — QA contract-input/output deny list (T017 review round)', () => {
  test('QA Read of a contract input under the clone denies with the §13 reason; a non-contract path allows', async () => {
    await seedTicket({
      status: 'in_qa',
      assignee: 'eng-1',
      contract: {
        inputs: ['spec/input.md'],
        outputs: [],
        acceptance: ['x'],
        done: [],
        env: 'clone',
      },
    });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(join(qaWorktree, 'spec'), { recursive: true });
    mkdirSync(join(qaWorktree, 'src'), { recursive: true });
    writeFileSync(join(qaWorktree, 'spec', 'input.md'), '# spec\n');
    writeFileSync(join(qaWorktree, 'src', 'a.ts'), '// impl\n');
    await store.putAgent(
      'qa-1',
      agentRecord({ role: 'qa', worktree: qaWorktree, ticket: 'TKT-0001' }),
    );
    const svc = service();

    const denied = await svc.preToolUse({
      cwd: qaWorktree,
      tool_name: 'Read',
      // Claude always sends an ABSOLUTE file_path — this is the exact shape
      // the first wiring draft failed to match against the ticket's
      // repo-relative `contract.inputs` glob.
      tool_input: { file_path: join(qaWorktree, 'spec', 'input.md') },
    });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toBe(
      'QA may not read contract inputs/outputs (§13)',
    );

    const allowed = await svc.preToolUse({
      cwd: qaWorktree,
      tool_name: 'Read',
      tool_input: { file_path: join(qaWorktree, 'src', 'a.ts') },
    });
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('QA Bash "cat" of the same contract input denies (§14 Bash rule)', async () => {
    await seedTicket({
      status: 'in_qa',
      assignee: 'eng-1',
      contract: {
        inputs: ['spec/input.md'],
        outputs: [],
        acceptance: ['x'],
        done: [],
        env: 'clone',
      },
    });
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(join(qaWorktree, 'spec'), { recursive: true });
    writeFileSync(join(qaWorktree, 'spec', 'input.md'), '# spec\n');
    await store.putAgent(
      'qa-1',
      agentRecord({ role: 'qa', worktree: qaWorktree, ticket: 'TKT-0001' }),
    );
    const svc = service();

    const result = await svc.preToolUse({
      cwd: qaWorktree,
      tool_name: 'Bash',
      tool_input: { command: 'cat spec/input.md' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe(
      'QA may not read contract inputs/outputs (§13)',
    );
  });

  test('an engineer session is unaffected — denyReadPaths is only ever set for role qa', async () => {
    await seedTicket({
      status: 'in_progress',
      assignee: 'eng-1',
      contract: {
        inputs: ['spec/input.md'],
        outputs: [],
        acceptance: ['x'],
        done: [],
        env: 'clone',
      },
    });
    mkdirSync(join(worktree, 'spec'), { recursive: true });
    writeFileSync(join(worktree, 'spec', 'input.md'), '# spec\n');
    const svc = service();

    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'spec', 'input.md') },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
