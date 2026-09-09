import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecord, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus, ulid } from '../bus';
import { createHalt } from '../halts';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HookService } from './service';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
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
  return new HookService(store, bus, { repoRoot: repo, ...overrides });
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
  test('unresolvable cwd (no matching ticket) allows through with no event logged', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.preToolUse({
      hook_event_name: 'PreToolUse',
      cwd: '/somewhere/else',
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(result).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(store.listEvents().filter((e) => e.kind === 'hook_decision')).toHaveLength(0);
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

  test('git push origin main via Bash asks for human approval with a reason', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(result.hookSpecificOutput.permissionDecisionReason).toBeDefined();
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
  test('drains low-priority inbox into systemMessage and acks it', async () => {
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
    expect(result.systemMessage).toContain('KB-0117 promoted');
    expect(bus.poll('eng-1', { priority: 'low' })).toHaveLength(0);
  });

  test('an empty low-priority inbox returns {}', async () => {
    await seedTicket();
    const svc = service();
    const result = await svc.stop({ cwd: worktree });
    expect(result).toEqual({});
  });
});
