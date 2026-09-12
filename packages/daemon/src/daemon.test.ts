import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@agile-agents/shared';
import { type DaemonHandle, startDaemon } from './daemon';
import { runInit } from './init';
import type { JsonRpcResponse } from './rpc';
import { StateStore } from './store';

let repo: string;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-daemon-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
});

afterEach(async () => {
  await handle?.stop();
  rmSync(repo, { recursive: true, force: true });
});

describe('startDaemon', () => {
  test('acquires the lock, and /health serves version + stateRoot', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);

    const res = await fetch(`http://127.0.0.1:${handle.http.port}/health`);
    const body = (await res.json()) as { version: string; stateRoot: string };
    expect(body.stateRoot).toBe(handle.config.stateRoot);
    expect(typeof body.version).toBe('string');
  });

  test('a second daemon for the same repo fails with a clear lock error', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await expect(
      startDaemon({ cwd: repo, port: 0, socketPath: join(repo, '.agile-daemon.sock') }),
    ).rejects.toThrow(/already running/);
  });

  test('graceful shutdown removes the lock and closes the listeners', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    const { lockPath } = handle.config;
    const { port } = handle.http;
    const { socketPath } = handle.rpc;

    await handle.stop();
    handle = undefined; // already stopped; afterEach shouldn't stop it again

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test('stop() is idempotent', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    await handle.stop();
  });

  test('after shutdown, a fresh daemon can start for the same repo', async () => {
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);
  });
});

function call(socketPath: string, request: Record<string, unknown>): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line) as JsonRpcResponse);
      }
    });
    socket.on('error', reject);
  });
}

describe('state.* RPC methods (T005)', () => {
  test('state.ticket_get/state.ticket_list are real once .agile/ exists; other state.* stay stubbed', async () => {
    runInit(repo);
    const store = StateStore.open(join(repo, '.agile'));
    await store.putTicket({
      id: 'TKT-0001',
      title: 'Test',
      status: 'draft',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });

    const get = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'state.ticket_get',
      params: { id: 'TKT-0001' },
    });
    expect('result' in get && (get.result as { id: string }).id).toBe('TKT-0001');

    const list = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'state.ticket_list',
    });
    expect('result' in list && (list.result as unknown[]).length).toBe(1);

    const stillStubbed = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 3,
      method: 'state.ticket_transition',
    });
    expect('error' in stillStubbed && stillStubbed.error.code).toBe(-32001);
  });
});

describe('tool.* RPC methods (T011)', () => {
  test('a tool call resolves the live sprint and writes ledger/<sprint>.jsonl, not ledger/nosprint.jsonl', async () => {
    const init = runInit(repo);
    const store = StateStore.open(init.stateRoot);
    await store.putTicket({
      id: 'TKT-0001',
      title: 'Test',
      status: 'in_progress',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
      assignee: 'eng-1',
    });
    await store.putSprint({
      id: 'S-01',
      goal: 'test',
      tickets: ['TKT-0001'],
      budget_tokens: 1000,
      started: '2026-09-09T00:00:00.000Z',
      carried_over: [],
    });
    writeFileSync(
      join(repo, 'pkg.test.ts'),
      'import { test, expect } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    );

    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });

    // `test_run` never touches the runner/ACP layer (it executes `command`
    // directly), so it exercises the daemon's real `tool.call` -> `ToolService`
    // -> ledger path end to end without needing a live vendor session.
    const response = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tool.call',
      params: {
        agent: 'eng-1',
        ticket: 'TKT-0001',
        name: 'test_run',
        input: { command: 'bun test pkg.test.ts' },
      },
    });
    expect('result' in response && (response.result as { ok: boolean }).ok).toBe(true);

    await store.flush();
    expect(existsSync(join(init.stateRoot, 'ledger', 'S-01.jsonl'))).toBe(true);
    expect(existsSync(join(init.stateRoot, 'ledger', 'nosprint.jsonl'))).toBe(false);
  });
});

describe('handle.advancePipeline (the one pipeline list)', () => {
  test("a reviewer escalate in em's inbox stales the in_review ticket through the handle, with the ceremony timer off", async () => {
    // Eleventh live run (2026-09-10): `agile run --live` re-listed the glue
    // by hand and dropped `advanceReviewerEscalations`/`releaseStaleTicketSessions`;
    // with `ceremonyTickMs: 0` the daemon's own list never ran either.
    runInit(repo);
    const store = StateStore.open(join(repo, '.agile'));
    await store.putTicket({
      id: 'TKT-0001',
      title: 'Test',
      status: 'in_review',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
      ceremonyTickMs: 0,
    });
    expect(typeof handle.advancePipeline).toBe('function');
    const bus = handle.bus;
    if (!bus) throw new Error('daemon has no bus');
    const sent = await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: 'reviewer-0001',
      to: ['em'],
      kind: 'escalate',
      priority: 'normal',
      ticket: 'TKT-0001',
      body: 'reviewer escalates round 1: ticket/contract issue',
      refs: [],
      requires_ack: false,
    });
    expect(sent.ok).toBe(true);

    await handle.advancePipeline?.();

    expect(handle.store?.getTicket('TKT-0001').status).toBe('stale');
    expect(bus.poll('architect').some((m) => m.kind === 'escalate')).toBe(true);
  });

  /**
   * T041 acceptance: "killing the resident session does not stall gates
   * (delegate path still decides)". The two are deliberately separate
   * sessions — the resident EM answers chat, the one-shot delegate decides
   * gates — so this asserts the split holds even with the resident dead.
   */
  test('T041: killing the resident EM session does not stall an em-owned gate', async () => {
    runInit(repo);
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
      ceremonyTickMs: 0,
      gateDelegate: () => ({ decision: 'approve', by: 'em', rationale: 'delegate decided' }),
    });
    expect(handle.residentEm).toBeDefined();
    expect(handle.emChat).toBeDefined();

    handle.residentEm?.kill();
    expect(handle.residentEm?.alive).toBe(false);

    const gates = handle.gateService;
    if (!gates) throw new Error('daemon has no gate service');
    const request = await gates.request('unblock', {
      policy: { gates: { unblock: 'em' }, breaker_signals: [] },
      hilKind: 'unblock',
      summary: 'eng-0001 wants to install a dependency in its own worktree',
    });
    await gates.settled();
    const decided = gates.get(request.id);
    expect(decided?.status).toBe('resolved');
    expect(decided?.decision).toBe('approve');
  });

  test('T041: the resident EM never spawns a vendor process until someone chats', async () => {
    runInit(repo);
    handle = await startDaemon({
      cwd: repo,
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
      ceremonyTickMs: 0,
    });
    expect(handle.residentEm?.alive).toBe(false);
  });
});
