import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type RpcServerHandle, startRpcServer } from '@agile-agents/daemon';
import { parseArgs } from '../args';
import { hookEventToMethod, parseHookArgs, runHook } from './hook';

function stdinWith(payload: unknown): NodeJS.ReadableStream {
  return Readable.from([JSON.stringify(payload)]);
}

describe('hookEventToMethod', () => {
  test('kebab-case event names map to snake_case hook.* methods', () => {
    expect(hookEventToMethod('pre-tool-use')).toBe('hook.pre_tool_use');
    expect(hookEventToMethod('post-tool-use')).toBe('hook.post_tool_use');
    expect(hookEventToMethod('stop')).toBe('hook.stop');
  });
});

describe('parseHookArgs', () => {
  test('fail-closed is the default (T009); --fail-open opts out', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: undefined,
    });
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--fail-open']))).toEqual({
      event: 'pre-tool-use',
      failClosed: false,
      timeoutMs: undefined,
    });
  });

  test('--fail-closed is still accepted (explicit, no-op vs the default)', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--fail-closed']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: undefined,
    });
  });

  test('reads --timeout as a number of milliseconds', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--timeout', '500']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: 500,
    });
  });

  test('a non-numeric --timeout throws', () => {
    expect(() => parseHookArgs(parseArgs(['pre-tool-use', '--timeout', 'soon']))).toThrow(
      /--timeout must be a number/,
    );
  });

  test('throws a usage error with no event', () => {
    expect(() => parseHookArgs(parseArgs([]))).toThrow(/usage: agile hook/);
  });
});

describe('runHook', () => {
  let dir: string;
  let socketPath: string;
  let rpc: RpcServerHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agile-cli-hook-'));
    socketPath = join(dir, 'test.sock');
  });

  afterEach(async () => {
    await rpc?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('forwards stdin JSON to hook.<event> and prints the real decision verbatim', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({
          decision: 'allow',
          echoedTool: (params as { tool: string }).tool,
        }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Read' }),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed).toEqual({ decision: 'allow', echoedTool: 'Read' });
  });

  // T012 QA/review round: `AGILE_AGENT` (set by `writeClaudeSettings`'s
  // `agentId` option) is forwarded into the payload as `agile_agent`, so
  // `HookService.resolveAgentByCwd` can disambiguate a reviewer/engineer
  // sharing one worktree.
  test('forwards AGILE_AGENT as payload.agile_agent when set', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({
          receivedAgent: (params as { agile_agent?: unknown }).agile_agent,
        }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    const originalEnv = process.env.AGILE_AGENT;
    process.env.AGILE_AGENT = 'reviewer-1';
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Edit' }),
      });
    } finally {
      console.log = original;
      if (originalEnv === undefined) Reflect.deleteProperty(process.env, 'AGILE_AGENT');
      else process.env.AGILE_AGENT = originalEnv;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({ receivedAgent: 'reviewer-1' });
  });

  test('does not add agile_agent when AGILE_AGENT is unset', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({ hasAgileAgent: 'agile_agent' in (params as object) }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    const originalEnv = process.env.AGILE_AGENT;
    Reflect.deleteProperty(process.env, 'AGILE_AGENT');
    console.log = (msg: string) => lines.push(msg);
    try {
      await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Read' }),
      });
    } finally {
      console.log = original;
      if (originalEnv !== undefined) process.env.AGILE_AGENT = originalEnv;
    }
    expect(JSON.parse(lines.join('\n'))).toEqual({ hasAgileAgent: false });
  });

  test('fail-open (--fail-open): a not-implemented stub yields a permissive {} decision, exit 0, warns on stderr', async () => {
    // No `hook.*` extraMethods wired — same shape as an RPC failure for any
    // other reason (unimplemented method, handler throw, etc).
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });

    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    // stdout stays pure JSON — the warning must never land there.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    expect(errors.join('\n')).toMatch(
      /daemon unreachable or hook\.\* not implemented; failing open/,
    );
  });

  test('fail-open: an unreachable daemon also yields {} and exit 0, warns on stderr', async () => {
    expect(existsSync(socketPath)).toBe(false);
    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    expect(errors.join('\n')).toMatch(
      /daemon unreachable or hook\.\* not implemented; failing open/,
    );
  });

  test('--timeout bounds how long a wedged daemon is waited on before failing (open here)', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      // Never resolves — simulates a daemon that accepted the connection
      // but is wedged and never replies.
      extraMethods: { 'hook.pre_tool_use': () => new Promise(() => {}) },
    });

    const start = performance.now();
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        timeoutMs: 100,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    const elapsed = performance.now() - start;
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    // Well under the 2000ms default — proves the override actually took effect.
    expect(elapsed).toBeLessThan(1000);
  });

  test('fail-closed (default, T009): a not-implemented stub denies the pre-tool-use call with a reason, exit 0', async () => {
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });
    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'agile daemon unreachable',
      },
    });
    expect(errors.join('\n')).toMatch(/not implemented yet/);
  });

  test('fail-closed: an unreachable daemon also denies pre-tool-use with a reason, exit 0', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'agile daemon unreachable',
      },
    });
  });

  test('fail-closed: post-tool-use/stop have no deny concept, so they still print {} on failure', async () => {
    for (const event of ['post-tool-use', 'stop']) {
      const lines: string[] = [];
      const original = console.log;
      console.log = (msg: string) => lines.push(msg);
      let code: number;
      try {
        code = await runHook({ socketPath, event, failClosed: true, stdin: stdinWith({}) });
      } finally {
        console.log = original;
      }
      expect(code).toBe(0);
      expect(JSON.parse(lines.join('\n'))).toEqual({});
    }
  });

  test('invalid JSON on stdin exits 1 without reaching the daemon', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: Readable.from(['{not json']),
      });
    } finally {
      console.error = original;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/invalid JSON/);
  });
});
