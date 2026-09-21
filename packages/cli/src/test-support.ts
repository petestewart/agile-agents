/**
 * Test-only helper: spins up a real in-process daemon RPC server (same
 * wiring as `packages/daemon/src/daemon.ts`'s `startDaemon`, built from
 * public `@agile-agents/daemon` exports only) against a freshly `agile
 * init`-ed temp repo. Used by every command test in `commands/*.test.ts`
 * that needs a live socket to round-trip against, per the ticket's
 * validation step ("CLI tests against an in-process daemon").
 *
 * Not `startDaemon` itself: that also binds an HTTP server and acquires the
 * repo lock, neither of which any CLI test needs, and binding two extra
 * listeners per test would slow the suite for no coverage gained.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Bus,
  FakeRunner,
  GateService,
  InboxService,
  QuestionService,
  type RpcServerHandle,
  StateStore,
  StreamService,
  ToolService,
  buildBusRpcMethods,
  buildGateRpcMethods,
  buildInboxRpcMethods,
  buildQuestionRpcMethods,
  buildStateRpcMethods,
  buildStreamRpcMethods,
  buildToolRpcMethods,
  loadToolRegistry,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import { RpcConnectionError, callRpc } from './client';

export interface TestDaemon {
  repo: string;
  /** The temp state home this daemon serves (T111) — `AGILE_HOME` for its lifetime. */
  home: string;
  stateRoot: string;
  socketPath: string;
  store: StateStore;
  rpc: RpcServerHandle;
  /** Same instance wired into `gate.*` RPC methods — tests use this to seed
   * a pending `HilRequest` the way `packages/daemon/src/gates/rpc.test.ts`
   * does, since there is no `gate.request` RPC for an external client to
   * create one through. */
  gateService: GateService;
  /** Same instance wired into `question.*` RPC (T040) — tests seed an open question through it. */
  questionService: QuestionService;
  streamService: StreamService;
  cleanup(): Promise<void>;
}

export async function startTestDaemon(prefix = 'agile-cli-test-'): Promise<TestDaemon> {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });

  // T111: the state home lives outside the repo. `AGILE_HOME` is exported
  // for the duration so `discoverConfig` (and any CLI subprocess this test
  // daemon spawns) resolves the same home, never the operator's `~/.agile/`.
  const home = join(repo, 'home');
  const previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  // T112 (D9): the socket belongs to the home, which is where every CLI
  // verb now looks for it (`resolveHomePaths`) — never a repo cwd.
  const socketPath = join(home, 'agiled.sock');

  // A no-op delegate (never auto-approves) matches production's default —
  // tests that need auto-delegation pass their own `GateService` instead of
  // using this helper.
  const gateService = new GateService(store);
  const streamService = new StreamService(store);
  const questionService = new QuestionService(store, streamService);
  // `FakeRunner` (never a real vendor session) so `tool.*` tests never need
  // `AGILE_LIVE=1` — same reasoning as the daemon's own tool tests.
  const toolService = new ToolService({
    registry: loadToolRegistry(init.stateRoot),
    runner: new FakeRunner(),
    repoRoot: repo,
  });

  const rpc = startRpcServer({
    socketPath,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    extraMethods: {
      ...buildStateRpcMethods(store),
      ...buildStreamRpcMethods(streamService),
      ...buildInboxRpcMethods(
        new InboxService({
          streams: streamService,
          questions: questionService,
          gates: gateService,
        }),
      ),
      ...buildBusRpcMethods(new Bus(store, init.stateRoot)),
      ...buildGateRpcMethods(gateService),
      ...buildQuestionRpcMethods(questionService),
      ...buildToolRpcMethods(toolService),
    },
  });
  await rpc.listening;
  // `listening` says the server bound its path; a client still saw
  // `connect ENOENT` on it once on a loaded CI runner (the `mcp --socket`
  // bridge test, 2026-09-11, twin run green, no local reproduction in 8
  // runs under load). Prove the socket connectable from this process before
  // handing it to a test that spawns a real CLI subprocess against it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await callRpc(socketPath, 'daemon.ping', {}, { timeoutMs: 1000 });
      break;
    } catch (err) {
      if (!(err instanceof RpcConnectionError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    repo,
    stateRoot: init.stateRoot,
    socketPath,
    store,
    rpc,
    gateService,
    questionService,
    streamService,
    home,
    async cleanup() {
      await rpc.close();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
      else process.env.AGILE_HOME = previousHome;
      rmSync(repo, { recursive: true, force: true });
    },
  };
}
