import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  hookService = new HookService(store, bus, { repoRoot: repo });
  methods = buildHookRpcMethods(hookService);

  worktree = join(repo, '.worktrees', 'TKT-0001');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * T122: a hook call resolves from the agent registry alone — ticket files
 * are gone with the ceremony layer — so the fixture is an `AgentRecord`
 * whose worktree contains the call's cwd.
 */
async function seedTicket(): Promise<void> {
  await store.putAgent('eng-1', {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    role: 'worker',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    worktree: join('.worktrees', 'TKT-0001'),
    last_seen: new Date().toISOString(),
  });
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
 * T033 root-cause fix, round 3: round 2's `Promise.all([stdout.text(),
 * stderr.text(), exited])` (draining piped stdout/stderr concurrently with
 * exit instead of sequentially) narrowed the race but did not close it —
 * QA still reproduced `EBADF: bad file descriptor, epoll_ctl` here under
 * concurrent-agent load (two `store` suites looping in the background,
 * load average ~2-3/4 cores; see `.pipeline-report.md`'s "Round 3" log).
 * The EBADF comes from Bun's own epoll bookkeeping for *piped* stdio fds,
 * not from an undrained buffer — draining faster doesn't remove the pipe,
 * it just shrinks the window. Routing stdout/stderr straight to plain files
 * (`Bun.file(path)` as the stdio destination) removes the pipe/epoll path
 * for those fds entirely: the OS dup2()s the child's fds onto regular
 * files, so there is nothing for `proc.exited`'s bookkeeping to race.
 *
 * `Bun.spawnSync` (the coordinator's other suggested option) was tried and
 * rejected: this describe block's own `startRpcServer` runs its unix-socket
 * server in *this same test process*, and `spawnSync` blocks this
 * process's event loop for the whole CLI subprocess lifetime — the socket
 * server could never accept the child's connection, so the child would
 * always hit its own 2s timeout and fail closed instead of getting a real
 * reply, breaking the very assertion this test exists to make.
 *
 * No assertion changes from round 2: exit code and stdout are checked
 * exactly as before; stderr is still captured only for a failure message.
 */
async function runHookCli(spawnArgs: {
  cmd: string[];
  stdin: Response;
  env: Record<string, string | undefined>;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'agile-hook-cli-'));
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  try {
    const proc = Bun.spawn({
      cmd: spawnArgs.cmd,
      stdin: spawnArgs.stdin,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      env: spawnArgs.env,
    });
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
