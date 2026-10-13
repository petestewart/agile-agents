import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RpcServerHandle, startRpcServer } from '@agile-agents/daemon';
import { parseArgs } from './args';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  LONG_RPC_TIMEOUT_MS,
  RpcCallError,
  RpcConnectionError,
  RpcTimeoutError,
  callRpc,
  formatWait,
  nodeCheck,
} from './client';
import { runAnswer } from './commands/answer';
import { runAttach } from './commands/attach';
import { runLand } from './commands/land';
import { runPolicyTry } from './commands/policy';
import { runReview } from './commands/review';
import {
  runStreamAddRepo,
  runStreamClose,
  runStreamImportChildren,
  runStreamLink,
  runStreamNew,
  runStreamSay,
} from './commands/stream';

let dir: string;
let socketPath: string;
let rpc: RpcServerHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-cli-client-'));
  socketPath = join(dir, 'test.sock');
});

afterEach(async () => {
  await rpc?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('callRpc', () => {
  test('round-trips a successful call', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'echo.ping': (params) => ({ echoed: params }) },
    });

    const result = await callRpc<{ echoed: unknown }>(socketPath, 'echo.ping', { hello: 'world' });
    expect(result.echoed).toEqual({ hello: 'world' });
  });

  test('rejects with RpcCallError on a daemon-reported error', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '0.0.0-test',
      stateRoot: dir,
      startedAt: Date.now(),
    });

    await expect(callRpc(socketPath, 'nonexistent.method')).rejects.toThrow(RpcCallError);
  });

  test('rejects with RpcConnectionError when nothing is listening', async () => {
    expect(existsSync(socketPath)).toBe(false);
    await expect(callRpc(socketPath, 'daemon.ping', undefined, { timeoutMs: 500 })).rejects.toThrow(
      RpcConnectionError,
    );
  });

  test('daemon.status returns pid/version/stateRoot/uptime', async () => {
    rpc = startRpcServer({
      socketPath,
      version: '9.9.9',
      stateRoot: dir,
      startedAt: Date.now(),
    });
    const status = await callRpc<{ version: string; pid: number }>(socketPath, 'daemon.status');
    expect(status.version).toBe('9.9.9');
    expect(status.pid).toBe(process.pid);
  });

  describe('a daemon that closes the connection without replying', () => {
    let rawServer: Server | undefined;

    afterEach(async () => {
      await new Promise<void>((resolve) =>
        rawServer ? rawServer.close(() => resolve()) : resolve(),
      );
    });

    test('rejects promptly with RpcConnectionError instead of hanging for the full timeout', async () => {
      rawServer = createServer((socket) => {
        // Accept the connection, then close it immediately — never write a
        // JSON-RPC response line. Simulates a daemon crashing or shutting
        // down mid-request. Drain first: on macOS, Bun never completes
        // `server.close()` for a socket ended with unread inbound bytes (the
        // request line the client writes on connect), so the afterEach hangs.
        socket.resume();
        socket.end();
      });
      await new Promise<void>((resolve) => rawServer?.listen(socketPath, resolve));

      const start = performance.now();
      await expect(
        callRpc(socketPath, 'daemon.ping', undefined, { timeoutMs: 5000 }),
      ).rejects.toThrow(RpcConnectionError);
      const elapsed = performance.now() - start;
      // Well under the 5s timeout passed above — proves 'close' short-circuits it.
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

/** T523 (CLI audit C1/C5). */
describe('a call that gets no answer in time', () => {
  let rawServer: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      rawServer ? rawServer.close(() => resolve()) : resolve(),
    );
    rawServer = undefined;
  });

  /** Accepts, reads the request, never answers. */
  async function silentDaemon(): Promise<void> {
    rawServer = createServer((socket) => {
      socket.resume();
    });
    await new Promise<void>((resolve) => rawServer?.listen(socketPath, resolve));
  }

  test('is an RpcTimeoutError, still an RpcConnectionError for callers that only need "no answer"', async () => {
    await silentDaemon();
    const err = await callRpc(socketPath, 'daemon.status', undefined, { timeoutMs: 50 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect(err).toBeInstanceOf(RpcConnectionError);
    expect((err as RpcTimeoutError).method).toBe('daemon.status');
    expect((err as RpcTimeoutError).timeoutMs).toBe(50);
    // The hook and the MCP bridge print this as before.
    expect((err as Error).message).toBe('timed out after 50ms waiting for daemon.status');
  });

  test('a long verb\u2019s timeout says the daemon may still finish, and where to look', async () => {
    await silentDaemon();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const err = await callRpc(
      socketPath,
      'delivery.deliver',
      { stream: id },
      {
        timeoutMs: 50,
        check: nodeCheck(id),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as Error).message).toBe(
      `agiled did not answer delivery.deliver within 50 ms; it may still finish the work. Check with \`agile node show ${id}\` (or \`agile tail --stream ${id}\`) before trying again`,
    );
  });

  test('formatWait says a wait in words', () => {
    expect(formatWait(50)).toBe('50 ms');
    expect(formatWait(DEFAULT_RPC_TIMEOUT_MS)).toBe('5 s');
    expect(formatWait(LONG_RPC_TIMEOUT_MS)).toBe('10 min');
  });
});

/**
 * T523 (CLI audit C1): every verb whose daemon work can run long waits
 * `LONG_RPC_TIMEOUT_MS` for that call (T155's way: the call's own
 * `timeoutMs`), and the rest keep the short default. Read off the timer
 * `callRpc` arms, against a daemon that refuses every call at once.
 */
describe('long verbs wait long (T523)', () => {
  const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  let rawServer: Server | undefined;
  let methods: string[];

  beforeEach(async () => {
    methods = [];
    rawServer = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string };
        methods.push(request.method);
        socket.end(
          `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'refused for the test' } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => rawServer?.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      rawServer ? rawServer.close(() => resolve()) : resolve(),
    );
    rawServer = undefined;
  });

  /** The method called and the wait `callRpc` armed for it. */
  async function waitOf(run: () => Promise<number>): Promise<{ method?: string; wait?: number }> {
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      await expect(run()).rejects.toThrow('refused for the test');
      const waits = timers.mock.calls
        .map((call) => call[1])
        .filter((ms) => ms === DEFAULT_RPC_TIMEOUT_MS || ms === LONG_RPC_TIMEOUT_MS);
      return { method: methods[0], wait: waits[0] };
    } finally {
      timers.mockRestore();
    }
  }

  const long: Array<[string, () => Promise<number>, string]> = [
    ['deliver / land', () => runLand(socketPath, parseArgs([ID]), false), 'delivery.deliver'],
    ['attach', () => runAttach(socketPath, parseArgs([ID]), false), 'attach.start'],
    ['resolve', () => runAttach(socketPath, parseArgs([ID]), false, true), 'attach.resolve'],
    ['review', () => runReview(socketPath, parseArgs([ID]), false), 'attach.start'],
    ['policy try', () => runPolicyTry(socketPath, parseArgs(['fix', 'it']), false), 'policy.try'],
    [
      'node new (starts its agent)',
      () => runStreamNew(socketPath, parseArgs(['--title', 't', '--goal', 'g']), false),
      'stream.create',
    ],
    [
      'node say',
      () => runStreamSay(socketPath, parseArgs([ID, 'hi']), false),
      'stream.thread_append',
    ],
    [
      'node add-repo',
      () => runStreamAddRepo(socketPath, parseArgs([ID, 'demo']), false, false),
      'node.add_repo',
    ],
    [
      'node switch-repo',
      () => runStreamAddRepo(socketPath, parseArgs([ID, 'demo']), false, true),
      'node.switch_repo',
    ],
    ['node link', () => runStreamLink(socketPath, parseArgs([ID, 'SHOP-1']), false), 'node.link'],
    [
      'node import-children',
      () => runStreamImportChildren(socketPath, parseArgs([ID]), false),
      'node.import_children',
    ],
    [
      'answer HIL-… yes (approving a merge gate merges)',
      () => runAnswer(socketPath, parseArgs(['HIL-1', 'yes']), false),
      'gate.approve',
    ],
  ];

  for (const [verb, run, method] of long) {
    test(`${verb} waits ${formatWait(LONG_RPC_TIMEOUT_MS)} for ${method}`, async () => {
      expect(await waitOf(run)).toEqual({ method, wait: LONG_RPC_TIMEOUT_MS });
    });
  }

  const short: Array<[string, () => Promise<number>, string]> = [
    [
      'node new --no-start',
      () =>
        runStreamNew(socketPath, parseArgs(['--title', 't', '--goal', 'g', '--no-start']), false),
      'stream.create',
    ],
    [
      'answer Q-…',
      () => runAnswer(socketPath, parseArgs(['Q-1', 'yes']), false),
      'question.answer',
    ],
    ['node close', () => runStreamClose(socketPath, parseArgs([ID]), false), 'stream.close'],
  ];

  for (const [verb, run, method] of short) {
    test(`${verb} keeps the ${formatWait(DEFAULT_RPC_TIMEOUT_MS)} default for ${method}`, async () => {
      expect(await waitOf(run)).toEqual({ method, wait: DEFAULT_RPC_TIMEOUT_MS });
    });
  }

  test('the long wait outlasts what the daemon itself allows a start (ACP initialize, 120 s)', () => {
    expect(LONG_RPC_TIMEOUT_MS).toBeGreaterThan(120_000);
  });
});
