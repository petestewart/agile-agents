import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecord, Ticket } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { createHalt } from '../halts';
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

async function seedTicket(overrides: Partial<Ticket> = {}) {
  await store.putTicket(makeTicket(overrides));
}

function service(
  overrides: Partial<ConstructorParameters<typeof HookService>[2]> = {},
): HookService {
  return new HookService(store, bus, { repoRoot: repo, gates, ...overrides });
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    ticket: 'TKT-0001',
    pid: 4242,
    last_seen: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

describe('HookService.preToolUse', () => {
  test('an unresolvable cwd DENIES with a fixed reason and logs the decision (review round fix, blocker 2)', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.preToolUse({
      hook_event_name: 'PreToolUse',
      cwd: '/somewhere/else',
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'agile: cwd is not a registered ticket worktree',
      },
    });
    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events).toHaveLength(1);
    expect(events[0]?.ticket).toBeUndefined();
    expect(events[0]?.agent).toBeUndefined();
    expect(events[0]?.data.decision).toBe('deny');
  });

  test('a ticket that is done/draft/ready/blocked/paused (not live) does not resolve — cwd denies', async () => {
    await seedTicket({ status: 'done' });
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
      /not a registered ticket worktree/,
    );
  });

  test('a global halt blocks the next tool call with the halt reason, and logs a hook_decision event', async () => {
    await seedTicket();
    await createHalt(store, {
      scope: 'global',
      reason: 'AGILE-HALT: auth model changed, stand down',
      raised_by: 'architect',
    });

    const svc = service();
    const result = await svc.preToolUse({
      hook_event_name: 'PreToolUse',
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'AGILE-HALT: auth model changed, stand down',
      },
    });

    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events).toHaveLength(1);
    expect(events[0]?.ticket).toBe('TKT-0001');
    expect(events[0]?.agent).toBe('eng-1');
    expect(events[0]?.data.decision).toBe('deny');
  });

  test('a subdirectory of the worktree still resolves the ticket/agent', async () => {
    await seedTicket();
    mkdirSync(join(worktree, 'src'), { recursive: true });
    await createHalt(store, { scope: 'global', reason: 'halted', raised_by: 'architect' });

    const svc = service();
    const result = await svc.preToolUse({
      cwd: join(worktree, 'src'),
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('a symlinked worktree resolves the same ticket (realpath both sides) — under a global halt, denies', async () => {
    await seedTicket();
    const alias = join(repo, 'alias-worktree');
    symlinkSync(worktree, alias);
    await createHalt(store, {
      scope: 'global',
      reason: 'AGILE-HALT: symlink test',
      raised_by: 'architect',
    });

    const svc = service();
    const result = await svc.preToolUse({
      cwd: alias,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe('AGILE-HALT: symlink test');
  });

  test('a big raw Read is denied and the reason names read_summary', async () => {
    await seedTicket();
    const svc = service({ fileSize: () => 100 * 1024 });
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/read_summary/);
  });

  test('an answer message appears as additionalContext on the next tool call, and is acked', async () => {
    await seedTicket();
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'answer',
      priority: 'normal',
      body: 'use the JWT approach',
      promote_to: 'none',
    });

    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(result.hookSpecificOutput.additionalContext).toContain('use the JWT approach');
    expect(bus.poll('eng-1')).toHaveLength(0); // acked, moved to done/
  });

  test('an urgent message denies with its body, and is acked so the next call sees the next tier', async () => {
    await seedTicket();
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'halt',
      priority: 'urgent',
      body: 'STOP: standup called',
    });

    const svc = service();
    const first = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(first.hookSpecificOutput.permissionDecisionReason).toBe('STOP: standup called');

    const second = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(second.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('ticket budget exhausted denies', async () => {
    await seedTicket({ budget: { ceiling_tokens: 100, spent_tokens: 100 } });
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/budget exhausted/);
  });

  test('a normal message pending does NOT bypass a big-read denial (review round fix, blocker 1) — still deny, context still attached', async () => {
    await seedTicket();
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'answer',
      priority: 'normal',
      body: 'use the JWT approach',
      promote_to: 'none',
    });
    const svc = service({ fileSize: () => 100 * 1024 });
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/read_summary/);
    expect(result.hookSpecificOutput.additionalContext).toContain('use the JWT approach');
    expect(bus.poll('eng-1')).toHaveLength(0); // still acked/delivered
  });

  test('a normal message pending does NOT bypass a budget denial', async () => {
    await seedTicket({ budget: { ceiling_tokens: 100, spent_tokens: 100 } });
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'answer',
      priority: 'normal',
      body: 'use the JWT approach',
      promote_to: 'none',
    });
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/budget exhausted/);
    expect(result.hookSpecificOutput.additionalContext).toContain('use the JWT approach');
  });

  test('a normal message pending does NOT turn a never-without-human Bash command into an allow', async () => {
    await seedTicket();
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'em',
      to: ['eng-1'],
      kind: 'answer',
      priority: 'normal',
      body: 'use the JWT approach',
      promote_to: 'none',
    });
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny'); // ask -> deny+HIL, never allow
    expect(result.hookSpecificOutput.additionalContext).toContain('use the JWT approach');
  });

  test('git push origin main via Bash denies naming a durable HIL request (QA round: Claude cannot answer ask)', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = result.hookSpecificOutput.permissionDecisionReason ?? '';
    expect(reason).toMatch(/HIL-/);

    const hilIdMatch = /HIL-[0-9A-HJKMNP-TV-Z]{26}/.exec(reason);
    expect(hilIdMatch).not.toBeNull();
    const hilId = hilIdMatch?.[0] as never;

    const requests = gates.list();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toBe(hilId);
    expect(requests[0]?.ticket).toBe('TKT-0001');
    expect(requests[0]?.gate).toBe('unblock');
    expect(requests[0]?.status).toBe('pending');

    // A real hil_request message landed in the human inbox.
    const humanInbox = bus.poll('human' as never);
    expect(humanInbox.some((m) => m.kind === 'hil_request')).toBe(true);
  });

  test('a second identical never-without-human call while pending reuses the same HIL id (no duplicate)', async () => {
    await seedTicket();
    const svc = service();
    const first = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    const second = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(first.hookSpecificOutput.permissionDecisionReason).toBe(
      second.hookSpecificOutput.permissionDecisionReason,
    );
    expect(gates.list()).toHaveLength(1);
  });

  test('an ordinary Bash command allows', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('heartbeat updates the agent registry last_seen on every pre-tool-use call', async () => {
    await seedTicket();
    await store.putAgent('eng-1', agentRecord({ last_seen: '2000-01-01T00:00:00Z' }));
    const svc = service();
    await svc.preToolUse({ cwd: worktree, tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    const record = store.getAgent('eng-1');
    expect(Date.parse(record.last_seen)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00Z'));
  });

  test('hook decisions and heartbeats are deferred-commit: N tool calls commit at most once, not N times', async () => {
    await seedTicket();
    await store.putAgent('eng-1', agentRecord({ last_seen: '2000-01-01T00:00:00Z' }));
    const commitCount = () =>
      new TextDecoder()
        .decode(
          Bun.spawnSync(['git', 'rev-list', '--count', 'HEAD'], { cwd: stateRoot, stdout: 'pipe' })
            .stdout,
        )
        .trim();
    const before = commitCount();

    const svc = service();
    for (let i = 0; i < 5; i++) {
      await svc.preToolUse({
        cwd: worktree,
        tool_name: 'Read',
        tool_input: { file_path: 'x.txt' },
      });
    }
    // Nothing committed yet — batched, not flushed.
    expect(commitCount()).toBe(before);

    await store.flush();
    const after = commitCount();
    expect(Number(after) - Number(before)).toBeLessThanOrEqual(1);
  });
});

describe('HookService.postToolUse', () => {
  test('records a ledger line approximating tokens from chars/4', async () => {
    await seedTicket({ sprint: 'S-01' });
    await store.putAgent('eng-1', agentRecord());
    const svc = service();
    await svc.postToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: 'x'.repeat(40),
    });
    const lines = store.listLedger('S-01');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.out_tokens).toBe(10);
    expect(lines[0]?.model).toBe('claude-sonnet-4-5');
    expect(lines[0]?.kind).toBe('engineer');
  });

  test('an oversized tool_response emits additionalContext pointing at read_summary/test_run, still recording usage', async () => {
    await seedTicket({ sprint: 'S-01' });
    await store.putAgent('eng-1', agentRecord());
    const svc = service({ limits: { maxReadBytes: 10 } });
    const result = await svc.postToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'cat huge.log' },
      tool_response: 'x'.repeat(1000),
    });
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/read_summary|test_run/);
    expect(store.listLedger('S-01')).toHaveLength(1);
  });

  test('a normal-sized tool_response returns {} (no additionalContext)', async () => {
    await seedTicket({ sprint: 'S-01' });
    await store.putAgent('eng-1', agentRecord());
    const svc = service();
    const result = await svc.postToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_response: 'ok',
    });
    expect(result).toEqual({});
  });
});

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
    // — reviewer resolves as `role: 'reviewer'`.
    const asReviewer = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
      agile_agent: 'reviewer-1',
    });
    const reviewerEvents = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.agent === 'reviewer-1');
    expect(reviewerEvents).toHaveLength(1);
    void asReviewer;

    const asEngineer = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
      agile_agent: 'eng-1',
    });
    const engineerEvents = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.agent === 'eng-1');
    expect(engineerEvents).toHaveLength(1);
    void asEngineer;
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
