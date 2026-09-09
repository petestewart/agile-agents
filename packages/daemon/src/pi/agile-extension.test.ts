import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, validateTicket } from '@agile-agents/shared';
import { Bus, buildBusRpcMethods } from '../bus';
import { GateService } from '../gates';
import { HookService, buildHookRpcMethods } from '../hook';
import { runInit } from '../init';
import { type RpcServerHandle, startRpcServer } from '../rpc';
import { StateStore } from '../store';
import {
  GATE_ENV_VAR,
  type HookPreToolUseReply,
  type PiBeforeAgentStartResult,
  type PiExtensionApi,
  type PiHandler,
  type PiToolCallEvent,
  type PiToolCallResult,
  type PiToolResultEvent,
  type PiToolResultEventResult,
  createAgileExtension,
  formatInboxMessage,
  looksLikeTestRun,
  summarizeTestOutput,
  toPiToolCallResult,
} from './agile-extension';

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('toPiToolCallResult', () => {
  it('allows through with no block on an allow verdict', () => {
    expect(toPiToolCallResult({ hookSpecificOutput: { permissionDecision: 'allow' } })).toEqual({});
  });

  it('allows through when the daemon reply carries no hookSpecificOutput at all', () => {
    expect(toPiToolCallResult({})).toEqual({});
  });

  it('blocks with the daemon reason on deny', () => {
    expect(
      toPiToolCallResult({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
    ).toEqual({ block: true, reason: 'nope' });
  });

  it('fails safe: an ask verdict blocks too (no synchronous HIL channel from tool_call)', () => {
    const result = toPiToolCallResult({
      hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'needs a human' },
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe('needs a human');
  });
});

describe('looksLikeTestRun', () => {
  it('recognizes common test commands as bash calls', () => {
    expect(looksLikeTestRun('bash', { command: 'bun test' })).toBe(true);
    expect(looksLikeTestRun('bash', { command: 'npm test' })).toBe(true);
    expect(looksLikeTestRun('bash', { command: 'pytest -q' })).toBe(true);
    expect(looksLikeTestRun('bash', { command: 'go test ./...' })).toBe(true);
  });

  it('does not flag an unrelated bash call or a non-bash tool', () => {
    expect(looksLikeTestRun('bash', { command: 'git status' })).toBe(false);
    expect(looksLikeTestRun('read', { command: 'bun test' })).toBe(false);
  });
});

describe('summarizeTestOutput', () => {
  it('passes short output through unchanged', () => {
    const result = summarizeTestOutput('all good\n2 passed');
    expect(result.rewritten).toBe(false);
    expect(result.text).toBe('all good\n2 passed');
  });

  it('distills long output into a pass/fail summary with a tail', () => {
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => `PASS test_${i}`),
      'FAIL test_x: boom',
      'AssertionError: expected 1 to be 2',
    ];
    const big = lines.join('\n');
    expect(big.length).toBeGreaterThan(2000);
    const result = summarizeTestOutput(big);
    expect(result.rewritten).toBe(true);
    expect(result.text).toContain('AGILE-SUMMARY');
    expect(result.text).toContain('fail-looking');
    expect(result.text).toContain('AssertionError: expected 1 to be 2');
  });

  // Round 2 review fix (B4, secondary nit): an early failure block must
  // survive even when a long trailing summary would otherwise push it out
  // of a tail-only truncation (jest/vitest-per-file-block-shaped output).
  it('keeps an early failure line even when it falls outside the tail', () => {
    const lines = [
      'FAIL src/foo.test.ts',
      'AssertionError: expected 1 to be 2 at foo.test.ts:12',
      ...Array.from({ length: 300 }, (_, i) => `PASS trailing_${i}`),
    ];
    const big = lines.join('\n');
    const result = summarizeTestOutput(big);
    expect(result.rewritten).toBe(true);
    // The early failure lines are far outside the last 40 lines (the tail).
    expect(result.text).toContain('AssertionError: expected 1 to be 2 at foo.test.ts:12');
    expect(result.text).toContain('failure-matching lines');
  });
});

describe('formatInboxMessage', () => {
  it('formats and caps concatenated bodies', () => {
    const text = formatInboxMessage([
      { kind: 'question', from: 'eng-1', body: 'hello' },
      { kind: 'decision', from: 'architect', body: 'world' },
    ]);
    expect(text).toBe('[question from eng-1] hello\n[decision from architect] world');
  });

  it('stops once the char cap is hit', () => {
    const text = formatInboxMessage(
      [
        { kind: 'k', from: 'a', body: 'x'.repeat(10) },
        { kind: 'k', from: 'a', body: 'y'.repeat(10) },
      ],
      15,
    );
    expect(text.includes('yyyyyyyyyy')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against a real daemon RPC server (fake `hook.*`/`bus.*`
// handlers standing in for HookService/Bus) and a fake `pi` extension API
// capturing registered handlers — no real `pi`/`pi-acp` process involved,
// per T022's verify-before-build gate (no vendor login in this container).
// ---------------------------------------------------------------------------

class FakePi implements PiExtensionApi {
  toolCall?: PiHandler<PiToolCallEvent, PiToolCallResult>;
  toolResult?: PiHandler<PiToolResultEvent, PiToolResultEventResult>;
  beforeAgentStart?: PiHandler<
    { type: 'before_agent_start'; prompt: string },
    PiBeforeAgentStartResult
  >;
  agentSettled?: () => void;
  sessionShutdown?: () => void;

  // biome-ignore lint/suspicious/noExplicitAny: matching the overloaded `on()` shape loosely for the fake
  on(event: string, handler: any): void {
    if (event === 'tool_call') this.toolCall = handler;
    else if (event === 'tool_result') this.toolResult = handler;
    else if (event === 'before_agent_start') this.beforeAgentStart = handler;
    else if (event === 'agent_settled') this.agentSettled = handler;
    else if (event === 'session_shutdown') this.sessionShutdown = handler;
  }
}

let dir: string;
let socketPath: string;
let rpcServer: RpcServerHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-pi-extension-'));
  socketPath = join(dir, 'test.sock');
});

afterEach(async () => {
  await rpcServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createAgileExtension: gate', () => {
  it('registers nothing when AGILE_PI_GATE is unset (a human interactive session)', () => {
    const pi = new FakePi();
    createAgileExtension({ env: {} })(pi);
    expect(pi.toolCall).toBeUndefined();
    expect(pi.toolResult).toBeUndefined();
  });

  it('registers nothing when the gate is set but no socket/agent env is present', () => {
    const pi = new FakePi();
    createAgileExtension({ env: { [GATE_ENV_VAR]: '1' } })(pi);
    expect(pi.toolCall).toBeUndefined();
  });
});

describe('createAgileExtension: tool_call gating', () => {
  it('forwards to hook.pre_tool_use and translates allow/deny', async () => {
    const preToolUse = mock((params: unknown): HookPreToolUseReply => {
      const p = params as { tool_name?: string };
      if (p.tool_name === 'write') {
        return {
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'AGILE-GATE: no',
          },
        };
      }
      return { hookSpecificOutput: { permissionDecision: 'allow' } };
    });
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': preToolUse,
        'bus.heartbeat': () => ({}),
      },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: {
        [GATE_ENV_VAR]: '1',
        AGILE_SOCKET_PATH: socketPath,
        AGILE_AGENT: 'eng-1',
        AGILE_TICKET: 'TKT-0001',
      },
      heartbeatIntervalMs: 60_000,
    })(pi);

    expect(pi.toolCall).toBeDefined();
    const readResult = await pi.toolCall?.(
      { type: 'tool_call', toolCallId: '1', toolName: 'read', input: {} },
      { cwd: '/repo' },
    );
    expect(readResult).toEqual({});

    const writeResult = await pi.toolCall?.(
      { type: 'tool_call', toolCallId: '2', toolName: 'write', input: {} },
      { cwd: '/repo' },
    );
    expect(writeResult).toEqual({ block: true, reason: 'AGILE-GATE: no' });

    expect(preToolUse).toHaveBeenCalledTimes(2);
    const firstCallParams = preToolUse.mock.calls[0]?.[0] as { agile_agent?: string; cwd?: string };
    expect(firstCallParams.agile_agent).toBe('eng-1');
    expect(firstCallParams.cwd).toBe('/repo');
  });

  it('fails closed when the daemon is unreachable', async () => {
    const pi = new FakePi();
    createAgileExtension({
      env: {
        [GATE_ENV_VAR]: '1',
        AGILE_SOCKET_PATH: join(dir, 'nothing-listening.sock'),
        AGILE_AGENT: 'eng-1',
      },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const result = await pi.toolCall?.(
      { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'ls' } },
      { cwd: '/repo' },
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('unreachable');
  });
});

describe('createAgileExtension: tool_result rewriting', () => {
  it('rewrites a large test-run bash output, leaves a small one and non-test tools alone', async () => {
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.post_tool_use': () => ({}),
        'bus.heartbeat': () => ({}),
      },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const bigLines = Array.from({ length: 300 }, (_, i) => `PASS case_${i}`);
    bigLines.push('FAIL case_x: boom');
    const bigOutput = bigLines.join('\n');

    const rewritten = await pi.toolResult?.(
      {
        type: 'tool_result',
        toolCallId: '1',
        toolName: 'bash',
        input: { command: 'bun test' },
        content: [{ type: 'text', text: bigOutput }],
        isError: false,
      },
      { cwd: '/repo' },
    );
    expect(rewritten?.content?.[0]?.text).toContain('AGILE-SUMMARY');

    const smallResult = await pi.toolResult?.(
      {
        type: 'tool_result',
        toolCallId: '2',
        toolName: 'bash',
        input: { command: 'bun test' },
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
      { cwd: '/repo' },
    );
    expect(smallResult).toBeUndefined();

    const nonTestResult = await pi.toolResult?.(
      {
        type: 'tool_result',
        toolCallId: '3',
        toolName: 'bash',
        input: { command: 'git log' },
        content: [{ type: 'text', text: bigOutput }],
        isError: false,
      },
      { cwd: '/repo' },
    );
    expect(nonTestResult).toBeUndefined();
  });

  // Round 2 review fix (B4): a rewritten *failing* run must echo isError:
  // true — a summary that comes back looking like a pass is exactly the
  // failure mode this rewrite must never produce.
  it('preserves isError: true on a rewritten failing test run', async () => {
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'hook.post_tool_use': () => ({}), 'bus.heartbeat': () => ({}) },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const bigLines = Array.from({ length: 300 }, (_, i) => `PASS case_${i}`);
    bigLines.push('FAIL case_x: boom');
    const bigOutput = bigLines.join('\n');

    const rewritten = await pi.toolResult?.(
      {
        type: 'tool_result',
        toolCallId: '1',
        toolName: 'bash',
        input: { command: 'bun test' },
        content: [{ type: 'text', text: bigOutput }],
        isError: true,
      },
      { cwd: '/repo' },
    );
    expect(rewritten?.content?.[0]?.text).toContain('AGILE-SUMMARY');
    expect(rewritten?.isError).toBe(true);
  });

  it('preserves isError: false on a rewritten passing test run', async () => {
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'hook.post_tool_use': () => ({}), 'bus.heartbeat': () => ({}) },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const bigOutput = Array.from({ length: 400 }, (_, i) => `PASS case_${i}`).join('\n');
    const rewritten = await pi.toolResult?.(
      {
        type: 'tool_result',
        toolCallId: '1',
        toolName: 'bash',
        input: { command: 'bun test' },
        content: [{ type: 'text', text: bigOutput }],
        isError: false,
      },
      { cwd: '/repo' },
    );
    expect(rewritten?.content?.[0]?.text).toContain('AGILE-SUMMARY');
    expect(rewritten?.isError).toBe(false);
  });
});

describe('createAgileExtension: inbox delivery', () => {
  it('delivers pending normal-priority messages via before_agent_start and acks them', async () => {
    const acked: string[] = [];
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'bus.poll': () => [{ id: 'm1', kind: 'decision', from: 'architect', body: 'use zod' }],
        'bus.ack': (params) => {
          acked.push((params as { id: string }).id);
          return {};
        },
        'bus.heartbeat': () => ({}),
      },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const result = await pi.beforeAgentStart?.(
      { type: 'before_agent_start', prompt: 'go' },
      { cwd: '/repo' },
    );
    expect(result?.message?.customType).toBe('agile-inbox');
    expect(result?.message?.content[0]?.text).toContain('use zod');

    // Ack is fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(acked).toEqual(['m1']);
  });

  it('returns nothing when the inbox is empty', async () => {
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'bus.poll': () => [], 'bus.heartbeat': () => ({}) },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
      heartbeatIntervalMs: 60_000,
    })(pi);

    const result = await pi.beforeAgentStart?.(
      { type: 'before_agent_start', prompt: 'go' },
      { cwd: '/repo' },
    );
    expect(result).toBeUndefined();
  });

  // T022 round 2 fix (review B1) — end-to-end against the REAL
  // HookService/Bus/StateStore (not fakes), the same objects the
  // reviewer's own repro used: a normal-priority message sent before the
  // engineer's first tool call must survive that tool_call (no
  // additionalContext channel to lose it into) and still be there for
  // before_agent_start to deliver + ack on the *next* turn.
  it('a normal message survives a tool_call and is still delivered on the next before_agent_start (real HookService/Bus)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agile-pi-extension-e2e-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const worktree = join(repo, '.worktrees', 'TKT-0001');
    mkdirSync(worktree, { recursive: true });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const bus = new Bus(store, init.stateRoot);
      await store.putTicket(
        validateTicket({
          id: 'TKT-0001',
          title: 'Ticket',
          status: 'in_progress',
          contract: {},
          history: [],
          assignee: 'eng-1',
          worktree: join('.worktrees', 'TKT-0001'),
        }),
      );
      const hookService = new HookService(store, bus, {
        repoRoot: repo,
        gates: new GateService(store),
      });

      await bus.send({
        id: ulid(),
        ts: new Date().toISOString(),
        from: 'em',
        to: ['eng-1'],
        kind: 'answer',
        priority: 'normal',
        body: 'stop editing src/foo.ts, TKT-0002 owns it now',
        promote_to: 'none',
      });

      rpcServer = startRpcServer({
        socketPath,
        version: '0.0.0-test',
        stateRoot: init.stateRoot,
        startedAt: Date.now(),
        extraMethods: {
          ...buildHookRpcMethods(hookService),
          ...buildBusRpcMethods(bus),
        },
      });

      const pi = new FakePi();
      createAgileExtension({
        env: { [GATE_ENV_VAR]: '1', AGILE_SOCKET_PATH: socketPath, AGILE_AGENT: 'eng-1' },
        heartbeatIntervalMs: 60_000,
      })(pi);

      const toolCallResult = await pi.toolCall?.(
        { type: 'tool_call', toolCallId: '1', toolName: 'read', input: { file_path: 'x.txt' } },
        { cwd: worktree },
      );
      expect(toolCallResult).toEqual({});
      // Not acked by the tool_call round trip — still pending.
      expect(bus.poll('eng-1')).toHaveLength(1);

      const delivered = await pi.beforeAgentStart?.(
        { type: 'before_agent_start', prompt: 'go' },
        { cwd: worktree },
      );
      expect(delivered?.message?.content[0]?.text).toContain('TKT-0002 owns it now');

      await new Promise((r) => setTimeout(r, 20));
      expect(bus.poll('eng-1')).toHaveLength(0); // delivered, now acked
      store.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('createAgileExtension: heartbeat', () => {
  it('calls bus.heartbeat on agent_settled and via the periodic timer', async () => {
    const heartbeats: unknown[] = [];
    rpcServer = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'bus.heartbeat': (params) => {
          heartbeats.push(params);
          return {};
        },
      },
    });

    const pi = new FakePi();
    createAgileExtension({
      env: {
        [GATE_ENV_VAR]: '1',
        AGILE_SOCKET_PATH: socketPath,
        AGILE_AGENT: 'eng-1',
        AGILE_TICKET: 'TKT-1',
      },
      heartbeatIntervalMs: 20,
    })(pi);

    // One fires at registration.
    await new Promise((r) => setTimeout(r, 10));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    pi.agentSettled?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    // The periodic timer fires again without any external trigger.
    await new Promise((r) => setTimeout(r, 40));
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    const first = heartbeats[0] as { agent?: string; patch?: { ticket?: string } };
    expect(first.agent).toBe('eng-1');
    expect(first.patch?.ticket).toBe('TKT-1');

    pi.sessionShutdown?.();
  });
});
