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
  test('reads the event and --fail-closed', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use']))).toEqual({
      event: 'pre-tool-use',
      failClosed: false,
    });
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--fail-closed']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
    });
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

  test('forwards stdin JSON to hook.<event> and prints the real decision', async () => {
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
        failClosed: false,
        stdin: stdinWith({ tool: 'Read' }),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed).toEqual({ decision: 'allow', echoedTool: 'Read' });
  });

  test('fail-open (default): a not-implemented stub yields a permissive {} decision, exit 0', async () => {
    // No `hook.*` extraMethods wired — this is exactly T008's integration
    // state (hook.* is T009's stub namespace).
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });

    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
  });

  test('fail-open: an unreachable daemon also yields {} and exit 0', async () => {
    expect(existsSync(socketPath)).toBe(false);
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
  });

  test('--fail-closed: a not-implemented stub is a hard failure, exit 1', async () => {
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });
    const errors: string[] = [];
    const original = console.error;
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
      console.error = original;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/not implemented yet/);
  });

  test('--fail-closed: an unreachable daemon is also a hard failure, exit 1', async () => {
    const errors: string[] = [];
    const original = console.error;
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
      console.error = original;
    }
    expect(code).toBe(1);
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
