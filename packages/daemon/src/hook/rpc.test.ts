import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { type RpcServerHandle, dispatch, startRpcServer } from '../rpc';
import { StateStore } from '../store';
import { buildHookRpcMethods } from './rpc';
import { HookService } from './service';

let repo: string;
let store: StateStore;
let bus: Bus;
let hookService: HookService;
let methods: Record<string, ReturnType<typeof buildHookRpcMethods>[string]>;
let worktree: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-hook-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  hookService = new HookService(store, bus, { repoRoot: repo, gates: new GateService(store) });
  methods = buildHookRpcMethods(hookService);

  worktree = join(repo, '.worktrees', 'TKT-0001');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function seedTicket(overrides: Partial<Ticket> = {}) {
  await store.putTicket(
    validateTicket({
      id: 'TKT-0001',
      title: 'Ticket',
      status: 'in_progress',
      contract: {},
      history: [],
      assignee: 'eng-1',
      worktree: join('.worktrees', 'TKT-0001'),
      ...overrides,
    }),
  );
}

describe('hook.* RPC round trip (via dispatch)', () => {
  test('hook.pre_tool_use returns the exact Claude output JSON', async () => {
    await seedTicket();
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'hook.pre_tool_use',
      params: { cwd: worktree, tool_name: 'Read', tool_input: { file_path: 'x.txt' } },
    });
    expect(response && 'result' in response ? response.result : undefined).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
  });

  test('hook.post_tool_use and hook.stop round-trip too', async () => {
    await seedTicket();
    const post = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'hook.post_tool_use',
      params: { cwd: worktree, tool_name: 'Bash', tool_response: 'ok' },
    });
    expect(post && 'result' in post ? post.result : undefined).toEqual({});

    const stop = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 3,
      method: 'hook.stop',
      params: { cwd: worktree },
    });
    expect(stop && 'result' in stop ? stop.result : undefined).toEqual({});
  });
});

/**
 * T033 root-cause fix: the two tests below used to `await new
 * Response(proc.stdout).text()` and only *then* `await proc.exited` — under
 * full-suite CPU contention this occasionally crashed with `EBADF: bad file
 * descriptor, epoll_ctl` from inside `proc.exited` (reproduced 2/10 full
 * runs on the integration head; 0/6 in isolation). The subprocess is spawned
 * with `stderr: 'pipe'` but the old code never drained it — an un-consumed
 * piped stream left the child's stderr fd alive and unregistered from this
 * process's own epoll instance until GC got around to it; when that
 * finalization lands in the same tick `proc.exited`'s own internal
 * epoll_ctl call runs (far more likely once the whole suite has many other
 * subprocesses/sockets churning fds), the two races and the second one to
 * touch the fd sees it already gone. Waiting on stdout, stderr, and exit
 * *together* (Bun's own documented `Bun.spawn` pattern) is the real
 * readiness fix — every stdio stream this process handed the OS is drained
 * before we call the subprocess "done", so there's nothing left half-closed
 * for `proc.exited`'s bookkeeping to race. This changes no assertion: exit
 * code and stdout are checked exactly as before, stderr is captured only
 * for a failure message.
 */
async function runHookCli(proc: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('hook.* RPC round trip through the CLI subprocess', () => {
  const CLI_ENTRY = join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'index.ts');
  let rpc: RpcServerHandle;
  let socketPath: string;

  beforeEach(() => {
    socketPath = join(repo, 'test.sock');
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: repo,
      startedAt: Date.now(),
      extraMethods: methods,
    });
  });

  afterEach(async () => {
    await rpc.close();
  });

  test('`agile hook pre-tool-use` prints the daemon reply verbatim', async () => {
    await seedTicket();
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'hook', 'pre-tool-use'],
      stdin: new Response(
        JSON.stringify({ cwd: worktree, tool_name: 'Read', tool_input: { file_path: 'x.txt' } }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AGILE_SOCKET_PATH: socketPath },
    });
    const { stdout, stderr, exitCode } = await runHookCli(proc);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
  });

  test('`agile hook pre-tool-use` denies with the halt reason through the whole stack', async () => {
    const { createHalt } = await import('../halts');
    await seedTicket();
    await createHalt(store, {
      scope: 'global',
      reason: 'AGILE-HALT: stand down',
      raised_by: 'architect',
    });

    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'hook', 'pre-tool-use'],
      stdin: new Response(
        JSON.stringify({ cwd: worktree, tool_name: 'Read', tool_input: { file_path: 'x.txt' } }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AGILE_SOCKET_PATH: socketPath },
    });
    const { stdout, stderr, exitCode } = await runHookCli(proc);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'AGILE-HALT: stand down',
      },
    });
  });
});
